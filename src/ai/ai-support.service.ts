import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../notifications/events.gateway';
import { MetaCloudApiService } from '../whatsapp/providers/meta-cloud-api.service';
import {
  ConversationStatus,
  SenderType,
  ServiceType,
  TicketPriority,
  TicketStatus,
  TicketSource,
  TicketReason,
} from '@prisma/client';
import {
  buildCustomerConversationContext,
  buildTenantAiSystemInstructions,
  findEquipmentAndClientByCode,
  generateGeminiWithEquipmentTools,
  parseEscalationOutput,
  prelookupEquipmentsFromTexts,
  resolveGeminiModel,
  TICKET_ESCALATION_PROTOCOL,
} from './ai-prompt.helper';
import { resolveTenantAgent } from '../agents/agents.helper';

interface EscalationPayloadData {
  ticketAction?: 'CREATE' | 'APPEND_NOTES';
  existingTicketId?: string | null;
  reason: string;
  ticketReason: TicketReason;
  problemTypeId?: string;
  serviceType: ServiceType;
  priority: TicketPriority;
  diagnosticSummary: string;
  additionalNotes?: string;
  equipmentId?: string;
  resolvedCustomerId?: string;
}

interface PreparedCustomerReply {
  tenantId: string;
  agentId?: string;
  conversationId: string;
  customer: { id: string; name: string; phone: string };
  replyText: string;
  shouldEscalate: boolean;
  escalationData?: EscalationPayloadData;
}

interface PendingReplyEntry {
  seq: number;
  timer: NodeJS.Timeout;
  readyPromise: Promise<PreparedCustomerReply | null>;
}

@Injectable()
export class AiSupportService implements OnModuleDestroy {
  private readonly logger = new Logger(AiSupportService.name);
  private readonly pendingReplies = new Map<string, PendingReplyEntry>();
  private seqCounter = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
    private readonly eventsGateway: EventsGateway,
    private readonly metaCloudApiService: MetaCloudApiService,
  ) {}

  onModuleDestroy() {
    for (const entry of this.pendingReplies.values()) {
      clearTimeout(entry.timer);
    }
    this.pendingReplies.clear();
  }

  /**
   * Cancela cualquier respuesta IA pendiente de envío (p. ej. si un operador humano respondió antes).
   */
  cancelPendingReply(conversationId: string) {
    const existing = this.pendingReplies.get(conversationId);
    if (existing) {
      clearTimeout(existing.timer);
      this.pendingReplies.delete(conversationId);
      this.logger.log(`Envío IA pendiente cancelado para conversación ${conversationId}`);
    }
  }

  /**
   * Programa la respuesta de IA con retardo controlado (por defecto 60s en Servicio Técnico):
   * prepara la respuesta inmediatamente en segundo plano y la envía al cumplirse el minuto.
   */
  async scheduleCustomerMessage(params: {
    tenantId: string;
    agentId?: string;
    conversationId: string;
    customerId: string;
    messageText: string;
  }) {
    const { tenantId, agentId, conversationId } = params;
    const resolvedAgent = await resolveTenantAgent(this.prisma, tenantId, { agentId });
    const isTechnicalService = resolvedAgent?.area === 'TECHNICAL_SERVICE';
    const delaySeconds = isTechnicalService ? (resolvedAgent?.aiResponseDelaySeconds ?? 60) : 0;

    if (delaySeconds <= 0) {
      return this.processCustomerMessage(params);
    }

    // Cancelar envío pendiente previo (debounce si el cliente escribe en varios mensajes seguidos)
    this.cancelPendingReply(conversationId);
    const seq = ++this.seqCounter;

    // Comenzar a preparar la respuesta INMEDIATAMENTE en segundo plano
    const readyPromise = this.prepareCustomerReply(params).catch((err) => {
      this.logger.error(
        `Error preparando respuesta IA anticipada para ${conversationId}: ${err.message}`,
        err.stack,
      );
      return null;
    });

    const timer = setTimeout(async () => {
      const current = this.pendingReplies.get(conversationId);
      if (!current || current.seq !== seq) return;
      this.pendingReplies.delete(conversationId);

      try {
        const conv = await this.prisma.conversation.findUnique({
          where: { id: conversationId },
          select: { status: true },
        });
        if (!conv || conv.status !== ConversationStatus.BOT_HANDLING) {
          this.logger.log(
            `Conversación ${conversationId} ya pasó a estado ${conv?.status}; se omite envío automático IA.`,
          );
          return;
        }

        const prepared = await readyPromise;
        if (!prepared) return;

        await this.dispatchPreparedReply(prepared);
      } catch (err: any) {
        this.logger.error(
          `Error enviando respuesta programada para ${conversationId}: ${err.message}`,
          err.stack,
        );
      }
    }, delaySeconds * 1000);

    this.pendingReplies.set(conversationId, { seq, timer, readyPromise });
    this.logger.log(
      `Respuesta IA iniciada en paralelo para ${conversationId}; envío programado en ${delaySeconds}s.`,
    );
  }

  /**
   * Procesa y envía inmediatamente (usado cuando aiResponseDelaySeconds = 0 o llamado directo).
   */
  async processCustomerMessage(params: {
    tenantId: string;
    agentId?: string;
    conversationId: string;
    customerId: string;
    messageText: string;
  }) {
    const prepared = await this.prepareCustomerReply(params);
    if (!prepared) return;
    return this.dispatchPreparedReply(prepared);
  }

  /**
   * Prepara el diagnóstico y texto de respuesta consultando BD + Gemini sin esperar al envío.
   */
  private async prepareCustomerReply(params: {
    tenantId: string;
    agentId?: string;
    conversationId: string;
    customerId: string;
    messageText: string;
  }): Promise<PreparedCustomerReply | null> {
    const { tenantId, agentId, conversationId, customerId, messageText } = params;

    const resolvedAgent = await resolveTenantAgent(this.prisma, tenantId, { agentId });
    const isTechnicalService = resolvedAgent?.area === 'TECHNICAL_SERVICE';
    const contextHours = resolvedAgent?.aiContextHours ?? 24;
    const messageSince = isTechnicalService
      ? new Date(Date.now() - contextHours * 60 * 60 * 1000)
      : undefined;

    const [customer, tenant, agentWithTraining, recentMessages] = await Promise.all([
      this.prisma.customer.findUnique({
        where: { id: customerId },
        include: { equipments: true },
      }),
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        include: {
          aiRules: { where: { isActive: true }, orderBy: { priority: 'asc' } },
          aiKnowledgeItems: { where: { isActive: true } },
          aiTrainingExamples: { where: { isApproved: true }, take: 5 },
          problemTypes: { where: { isActive: true }, orderBy: { name: 'asc' } },
        },
      }),
      resolvedAgent
        ? this.prisma.whatsAppAgent.findUnique({
            where: { id: resolvedAgent.id },
            include: {
              aiRules: { where: { isActive: true }, orderBy: { priority: 'asc' } },
              aiKnowledgeItems: { where: { isActive: true } },
              aiTrainingExamples: { where: { isApproved: true }, take: 5 },
            },
          })
        : Promise.resolve(null),
      this.prisma.message.findMany({
        where: {
          conversationId,
          ...(messageSince ? { createdAt: { gte: messageSince } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: isTechnicalService ? 20 : 8,
      }),
    ]);

    if (!customer || !tenant) return null;

    const effectiveAi = agentWithTraining
      ? {
          ...tenant,
          id: tenant.id,
          name: tenant.name,
          aiEnabled: agentWithTraining.aiEnabled,
          geminiApiKey: agentWithTraining.geminiApiKey ?? tenant.geminiApiKey,
          geminiModel: agentWithTraining.geminiModel || tenant.geminiModel,
          aiTemperature: agentWithTraining.aiTemperature ?? tenant.aiTemperature,
          aiSystemPrompt: agentWithTraining.aiSystemPrompt ?? tenant.aiSystemPrompt,
          aiRules: agentWithTraining.aiRules,
          aiKnowledgeItems: agentWithTraining.aiKnowledgeItems,
          aiTrainingExamples: agentWithTraining.aiTrainingExamples,
          problemTypes: tenant.problemTypes,
        }
      : tenant;

    // Si la IA del agente está desactivada, deriva directo a cola humana de inmediato
    if (!effectiveAi.aiEnabled) {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { status: ConversationStatus.WAITING_AGENT },
      });

      await this.notificationsService.notify({
        tenantId,
        type: 'chat.waiting_agent',
        title: `Mensaje de ${customer.name} (IA desactivada)`,
        body: messageText,
        link: `/chat/${conversationId}`,
      });

      this.eventsGateway.emitToTenant(tenantId, 'chat:conversation_updated', {
        conversationId,
        status: ConversationStatus.WAITING_AGENT,
      });
      return null;
    }

    const orderedHistory = [...recentMessages].reverse();

    const { replyText, shouldEscalate, escalationData } = await this.runAiDiagnostic({
      tenant: effectiveAi,
      customer,
      recentMessages: orderedHistory,
      latestMessage: messageText,
    });

    return {
      tenantId,
      agentId: agentWithTraining?.id,
      conversationId,
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
      },
      replyText,
      shouldEscalate,
      escalationData,
    };
  }

  private async dispatchPreparedReply(prepared: PreparedCustomerReply) {
    const { tenantId, agentId, conversationId, customer, replyText, shouldEscalate, escalationData } = prepared;

    if (escalationData && (shouldEscalate || escalationData.ticketAction === 'APPEND_NOTES' || escalationData.ticketAction === 'CREATE')) {
      await this.escalateToHuman({
        tenantId,
        agentId,
        conversationId,
        customerId: escalationData.resolvedCustomerId || customer.id,
        ticketAction: escalationData.ticketAction,
        existingTicketId: escalationData.existingTicketId,
        shouldEscalate,
        reason: escalationData.reason,
        ticketReason: escalationData.ticketReason,
        problemTypeId: escalationData.problemTypeId,
        serviceType: escalationData.serviceType,
        priority: escalationData.priority,
        diagnosticSummary: escalationData.diagnosticSummary,
        additionalNotes: escalationData.additionalNotes,
        equipmentId: escalationData.equipmentId,
      });
    }

    const botMessage = await this.prisma.message.create({
      data: {
        tenantId,
        conversationId,
        senderType: SenderType.BOT,
        content: replyText,
      },
    });

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date() },
    });

    await this.metaCloudApiService.sendTextMessage({
      tenantId,
      agentId,
      to: customer.phone,
      text: replyText,
    });

    this.eventsGateway.emitToTenant(tenantId, 'chat:new_message', {
      conversationId,
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
      },
      message: botMessage,
    });

    return botMessage;
  }

  /**
   * Ejecuta Gemini usando exclusivamente el entrenamiento configurado por el SuperAdmin para la empresa.
   */
  private async runAiDiagnostic(params: {
    tenant: any;
    customer: any;
    recentMessages: any[];
    latestMessage: string;
  }): Promise<{
    replyText: string;
    shouldEscalate: boolean;
    escalationData?: EscalationPayloadData;
  }> {
    const { tenant, customer, recentMessages, latestMessage } = params;

    const apiKey = tenant.geminiApiKey?.trim() || this.configService.get<string>('GEMINI_API_KEY');
    const geminiModel = resolveGeminiModel(
      tenant.geminiModel,
      this.configService.get<string>('GEMINI_MODEL'),
    );

    if (apiKey && apiKey !== 'your-gemini-api-key') {
      try {
        const client = new GoogleGenAI({ apiKey });
        const customerHistoryTexts = recentMessages
          .filter((m) => m.senderType === SenderType.CUSTOMER)
          .slice(-3)
          .map((m) => m.content);
        const prematched = await prelookupEquipmentsFromTexts(this.prisma, tenant.id, [
          latestMessage,
          ...customerHistoryTexts,
        ]);
        const uniquePreMatch = prematched.length === 1 ? prematched[0] : undefined;

        const systemInstructions = `${buildTenantAiSystemInstructions(tenant, { latestMessage })}\n\n${TICKET_ESCALATION_PROTOCOL}`;
        const userContext = buildCustomerConversationContext({
          customerName: uniquePreMatch?.customer?.name || customer.name,
          customerExternalCode:
            uniquePreMatch?.codClient || uniquePreMatch?.customer?.externalCode || customer.externalCode,
          equipments: prematched.map((m) => ({
            id: m.equipmentId,
            name: m.name,
            brand: m.brand,
            model: m.model,
            serialNumber: m.serialNumber,
            externalCode: m.externalCode,
            internalCode: m.internalCode,
            codClient: m.codClient,
            customerCompanyName: m.customer?.companyName || null,
            customerName: m.customer?.name || null,
            activeTickets: m.activeTickets,
          })),
          recentMessages,
          latestMessage,
        });

        const {
          text: rawAiText,
          modelUsed,
          matchedEquipmentId,
          matchedCustomerId,
        } = await generateGeminiWithEquipmentTools({
          client,
          prisma: this.prisma,
          tenantId: tenant.id,
          preferredModel: geminiModel,
          systemInstruction: systemInstructions,
          userContext,
          temperature: tenant.aiTemperature ?? 0.2,
          initialMatchedEquipmentId: uniquePreMatch?.equipmentId,
          initialMatchedCustomerId: uniquePreMatch?.customer?.customerId,
        });
        if (modelUsed !== geminiModel) {
          this.logger.warn(
            `Gemini fallback activado para '${tenant.name}': ${geminiModel} saturado -> respondido con ${modelUsed}`,
          );
        }

        const { replyText, escalationPayload } = parseEscalationOutput(rawAiText);

        const hasActionableTicketPayload =
          escalationPayload &&
          (escalationPayload.shouldEscalate ||
            escalationPayload.ticketAction === 'CREATE' ||
            escalationPayload.ticketAction === 'APPEND_NOTES');

        if (hasActionableTicketPayload) {
          const validProblem = tenant.problemTypes?.find((pt: any) => pt.id === escalationPayload.problemTypeId);
          const candidateEquipmentId = escalationPayload.equipmentId || matchedEquipmentId;
          let resolvedEquipmentId: string | undefined;
          let resolvedCustomerId: string | undefined = matchedCustomerId;

          if (candidateEquipmentId) {
            const directEquipment = await this.prisma.equipment.findFirst({
              where: { id: candidateEquipmentId, tenantId: tenant.id },
              select: { id: true, customerId: true },
            });
            if (directEquipment) {
              resolvedEquipmentId = directEquipment.id;
              resolvedCustomerId = directEquipment.customerId;
            } else {
              const byCode = await findEquipmentAndClientByCode(this.prisma, tenant.id, String(candidateEquipmentId));
              if (byCode.matches[0]) {
                resolvedEquipmentId = byCode.matches[0].equipmentId;
                resolvedCustomerId = byCode.matches[0].customer?.customerId || resolvedCustomerId;
              }
            }
          }

          const requestedAction: 'CREATE' | 'APPEND_NOTES' =
            escalationPayload.ticketAction === 'APPEND_NOTES' ? 'APPEND_NOTES' : 'CREATE';
          const shouldEscalateFlag =
            requestedAction === 'CREATE' ? true : Boolean(escalationPayload.shouldEscalate);

          return {
            replyText:
              replyText ||
              `Hemos registrado tu solicitud y derivado el caso a nuestro equipo de ${tenant.name}.`,
            shouldEscalate: shouldEscalateFlag,
            escalationData: {
              ticketAction: requestedAction,
              existingTicketId: escalationPayload.existingTicketId || null,
              reason: escalationPayload.reason || validProblem?.name || 'Derivación solicitada por IA',
              ticketReason: Object.values(TicketReason).includes(escalationPayload.ticketReason)
                ? escalationPayload.ticketReason
                : validProblem?.defaultReason || TicketReason.OTHER,
              problemTypeId: validProblem?.id,
              serviceType:
                escalationPayload.serviceType === 'ONSITE_PHYSICAL'
                  ? ServiceType.ONSITE_PHYSICAL
                  : ServiceType.REMOTE_WHATSAPP,
              priority: Object.values(TicketPriority).includes(escalationPayload.priority)
                ? escalationPayload.priority
                : TicketPriority.HIGH,
              diagnosticSummary:
                escalationPayload.diagnosticSummary || escalationPayload.additionalNotes || latestMessage,
              additionalNotes: escalationPayload.additionalNotes || undefined,
              equipmentId: resolvedEquipmentId,
              resolvedCustomerId: resolvedCustomerId || customer.id,
            },
          };
        }

        if (replyText) {
          return { replyText, shouldEscalate: false };
        }
      } catch (err: any) {
        this.logger.error(`Error en Gemini API para tenant '${tenant.name}': ${err.message}`);
      }
    } else {
      this.logger.warn(
        `Sin GEMINI_API_KEY configurada para tenant '${tenant.name}'. Derivando mensaje a atención humana.`,
      );
    }

    // Fallback neutro sin reglas de dominio hardcodeadas: deriva a cola humana si Gemini no está disponible
    return {
      replyText: `Hola ${customer.name}, gracias por escribir a ${tenant.name}. En este momento derivamos tu consulta a un operador de nuestro equipo para asistirte a la brevedad.`,
      shouldEscalate: true,
      escalationData: {
        reason: 'Sin motor IA disponible (derivación directa)',
        ticketReason: TicketReason.OTHER,
        serviceType: ServiceType.REMOTE_WHATSAPP,
        priority: TicketPriority.MEDIUM,
        diagnosticSummary: `Mensaje del cliente sin respuesta automática de Gemini: "${latestMessage}"`,
        equipmentId: customer.equipments?.[0]?.id,
      },
    };
  }

  /**
   * Crea el ticket generado por la IA o agrega notas a un ticket abierto existente (evitando duplicados).
   */
  private async escalateToHuman(params: {
    tenantId: string;
    agentId?: string;
    conversationId: string;
    customerId: string;
    ticketAction?: 'CREATE' | 'APPEND_NOTES';
    existingTicketId?: string | null;
    shouldEscalate?: boolean;
    reason: string;
    ticketReason?: TicketReason;
    problemTypeId?: string;
    serviceType: ServiceType;
    priority: TicketPriority;
    diagnosticSummary: string;
    additionalNotes?: string;
    equipmentId?: string;
  }) {
    const {
      tenantId,
      agentId,
      conversationId,
      customerId,
      existingTicketId,
      shouldEscalate = true,
      reason,
      ticketReason,
      problemTypeId,
      serviceType,
      priority,
      diagnosticSummary,
      additionalNotes,
      equipmentId,
    } = params;

    const closedStatuses = [TicketStatus.RESOLVED, TicketStatus.CANCELLED];

    // Guard anti-duplicación en PostgreSQL: verificar si ya existe ticket abierto para este equipo o conversación
    let openTicket = existingTicketId
      ? await this.prisma.ticket.findFirst({
          where: {
            id: existingTicketId,
            tenantId,
            status: { notIn: closedStatuses },
          },
        })
      : null;

    if (!openTicket && equipmentId) {
      openTicket = await this.prisma.ticket.findFirst({
        where: {
          tenantId,
          equipmentId,
          status: { notIn: closedStatuses },
        },
        orderBy: { createdAt: 'desc' },
      });
    }

    if (!openTicket && !equipmentId) {
      openTicket = await this.prisma.ticket.findFirst({
        where: {
          tenantId,
          conversationId,
          status: { notIn: closedStatuses },
        },
        orderBy: { createdAt: 'desc' },
      });
    }

    if (openTicket) {
      const noteContent = (additionalNotes || diagnosticSummary || reason).trim();
      const timestampLabel = new Date().toLocaleString('es-AR');
      const noteLine = `[Actualización WhatsApp IA - ${timestampLabel}]: ${noteContent}`;

      const updatedDiagnostic = openTicket.aiDiagnostic
        ? `${openTicket.aiDiagnostic}\n\n${noteLine}`
        : noteLine;
      const updatedDescription = openTicket.description
        ? `${openTicket.description}\n\n${noteLine}`
        : noteLine;

      const updatedTicket = await this.prisma.ticket.update({
        where: { id: openTicket.id },
        data: {
          aiDiagnostic: updatedDiagnostic,
          description: updatedDescription,
          ...(openTicket.equipmentId ? {} : equipmentId ? { equipmentId } : {}),
        },
      });

      if (shouldEscalate) {
        await this.prisma.conversation.update({
          where: { id: conversationId },
          data: {
            status: ConversationStatus.WAITING_AGENT,
            aiDiagnostic: updatedDiagnostic,
          },
        });
      } else {
        await this.prisma.conversation.update({
          where: { id: conversationId },
          data: { aiDiagnostic: updatedDiagnostic },
        });
      }

      await this.notificationsService.notify({
        tenantId,
        type: 'ticket.updated',
        title: `Nota agregada al Ticket #${updatedTicket.id.slice(-4).toUpperCase()}`,
        body: noteContent,
        link: `/tickets`,
      });

      this.eventsGateway.emitToTenant(tenantId, 'chat:conversation_updated', {
        conversationId,
        ...(shouldEscalate ? { status: ConversationStatus.WAITING_AGENT } : {}),
        aiDiagnostic: updatedDiagnostic,
        ticketId: updatedTicket.id,
      });

      await this.auditService.log({
        tenantId,
        action: 'TICKET_NOTES_APPENDED_BY_AI',
        entity: 'Ticket',
        entityId: updatedTicket.id,
        payload: {
          conversationId,
          equipmentId: equipmentId || updatedTicket.equipmentId || null,
          additionalNotes: noteContent,
        },
      });

      this.logger.log(
        `[AI Anti-Duplicate] Conversación ${conversationId} -> Nota agregada a ticket abierto existente ${updatedTicket.id}`,
      );

      return updatedTicket;
    }

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        status: ConversationStatus.WAITING_AGENT,
        aiDiagnostic: diagnosticSummary,
      },
    });

    const ticket = await this.prisma.ticket.create({
      data: {
        tenantId,
        agentId: agentId || null,
        customerId,
        conversationId,
        equipmentId,
        problemTypeId: problemTypeId || null,
        title: `Incidencia WhatsApp: ${reason.slice(0, 80)}`,
        description: reason,
        aiDiagnostic: diagnosticSummary,
        serviceType,
        priority,
        status: TicketStatus.OPEN,
        source: TicketSource.AI_WHATSAPP,
        reason: ticketReason || TicketReason.OTHER,
      },
    });

    const modalityText =
      serviceType === ServiceType.ONSITE_PHYSICAL
        ? 'Visita Presencial en Local'
        : 'Soporte Remoto por WhatsApp';

    await this.notificationsService.notify({
      tenantId,
      type: 'ticket.escalated',
      title: `Ticket #${ticket.id.slice(-4).toUpperCase()} creado por IA (${modalityText})`,
      body: diagnosticSummary,
      link: `/tickets`,
    });

    this.eventsGateway.emitToTenant(tenantId, 'chat:conversation_updated', {
      conversationId,
      status: ConversationStatus.WAITING_AGENT,
      aiDiagnostic: diagnosticSummary,
      ticketId: ticket.id,
    });

    await this.auditService.log({
      tenantId,
      action: 'TICKET_ESCALATED_BY_AI',
      entity: 'Ticket',
      entityId: ticket.id,
      payload: {
        conversationId,
        serviceType,
        priority,
        problemTypeId: problemTypeId || null,
        diagnosticSummary,
      },
    });

    this.logger.log(`[AI Handoff] Conversación ${conversationId} -> Ticket creado: ${ticket.id}`);

    return ticket;
  }
}

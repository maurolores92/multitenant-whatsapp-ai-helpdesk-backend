import { Injectable, Logger } from '@nestjs/common';
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
  resolveGeminiModel,
  TICKET_ESCALATION_PROTOCOL,
} from './ai-prompt.helper';

@Injectable()
export class AiSupportService {
  private readonly logger = new Logger(AiSupportService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
    private readonly eventsGateway: EventsGateway,
    private readonly metaCloudApiService: MetaCloudApiService,
  ) {}

  /**
   * Procesa un mensaje entrante cuando la conversación está en BOT_HANDLING.
   * Respeta la configuración y entrenamiento definidos por el SuperAdmin por compañía.
   */
  async processCustomerMessage(params: {
    tenantId: string;
    conversationId: string;
    customerId: string;
    messageText: string;
  }) {
    const { tenantId, conversationId, customerId, messageText } = params;

    const [customer, tenant, recentMessages] = await Promise.all([
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
      this.prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        take: 8,
      }),
    ]);

    if (!customer || !tenant) return;

    // Si el SuperAdmin desactivó la IA de la compañía, deriva directo a cola humana
    if (!tenant.aiEnabled) {
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
      return;
    }

    const orderedHistory = [...recentMessages].reverse();

    const { replyText, shouldEscalate, escalationData } = await this.runAiDiagnostic({
      tenant,
      customer,
      recentMessages: orderedHistory,
      latestMessage: messageText,
    });

    if (shouldEscalate && escalationData) {
      await this.escalateToHuman({
        tenantId,
        conversationId,
        customerId: escalationData.resolvedCustomerId || customer.id,
        reason: escalationData.reason,
        ticketReason: escalationData.ticketReason,
        problemTypeId: escalationData.problemTypeId,
        serviceType: escalationData.serviceType,
        priority: escalationData.priority,
        diagnosticSummary: escalationData.diagnosticSummary,
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
    escalationData?: {
      reason: string;
      ticketReason: TicketReason;
      problemTypeId?: string;
      serviceType: ServiceType;
      priority: TicketPriority;
      diagnosticSummary: string;
      equipmentId?: string;
      resolvedCustomerId?: string;
    };
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
        const systemInstructions = `${buildTenantAiSystemInstructions(tenant)}\n\n${TICKET_ESCALATION_PROTOCOL}`;
        const userContext = buildCustomerConversationContext({
          customerName: customer.name,
          customerExternalCode: customer.externalCode,
          equipments: [],
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
        });
        if (modelUsed !== geminiModel) {
          this.logger.warn(
            `Gemini fallback activado para '${tenant.name}': ${geminiModel} saturado -> respondido con ${modelUsed}`,
          );
        }

        const { replyText, escalationPayload } = parseEscalationOutput(rawAiText);

        if (escalationPayload?.shouldEscalate) {
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

          return {
            replyText:
              replyText ||
              `Hemos registrado tu solicitud y derivado el caso a nuestro equipo de ${tenant.name}.`,
            shouldEscalate: true,
            escalationData: {
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
              diagnosticSummary: escalationPayload.diagnosticSummary || latestMessage,
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
   * Crea el ticket generado por la IA y notifica al equipo de la compañía
   */
  private async escalateToHuman(params: {
    tenantId: string;
    conversationId: string;
    customerId: string;
    reason: string;
    ticketReason?: TicketReason;
    problemTypeId?: string;
    serviceType: ServiceType;
    priority: TicketPriority;
    diagnosticSummary: string;
    equipmentId?: string;
  }) {
    const {
      tenantId,
      conversationId,
      customerId,
      reason,
      ticketReason,
      problemTypeId,
      serviceType,
      priority,
      diagnosticSummary,
      equipmentId,
    } = params;

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

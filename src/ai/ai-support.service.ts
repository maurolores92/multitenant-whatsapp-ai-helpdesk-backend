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
} from '@prisma/client';

@Injectable()
export class AiSupportService {
  private readonly logger = new Logger(AiSupportService.name);
  private readonly aiClient: GoogleGenAI | null = null;
  private readonly isConfigured: boolean = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
    private readonly eventsGateway: EventsGateway,
    private readonly metaCloudApiService: MetaCloudApiService,
  ) {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY');
    if (apiKey && apiKey !== 'your-gemini-api-key') {
      try {
        this.aiClient = new GoogleGenAI({ apiKey });
        this.isConfigured = true;
        this.logger.log('✔ Motor Google Gemini inicializado con éxito');
      } catch (err) {
        this.logger.error(`Error al inicializar GoogleGenAI: ${err.message}`);
      }
    } else {
      this.logger.warn(
        '⚠️ GEMINI_API_KEY no configurada. El motor de IA operará con triaje heurístico asistido.',
      );
    }
  }

  /**
   * Procesa un mensaje entrante de un cliente cuando la conversación está en BOT_HANDLING
   */
  async processCustomerMessage(params: {
    tenantId: string;
    conversationId: string;
    customerId: string;
    messageText: string;
  }) {
    const { tenantId, conversationId, customerId, messageText } = params;

    // 1. Obtener contexto del cliente y sus equipos registrados
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      include: { equipments: true },
    });

    if (!customer) return;

    // 2. Obtener historial reciente de la conversación
    const recentMessages = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      take: 8,
    });

    // 3. Ejecutar diagnóstico de IA con reglas de entrenamiento de la compañía
    const { replyText, shouldEscalate, escalationData } = await this.runAiDiagnostic({
      tenantId,
      customer,
      recentMessages,
      latestMessage: messageText,
    });

    // 4. Si la IA determinó que se requiere un técnico humano:
    if (shouldEscalate && escalationData) {
      await this.escalateToHuman({
        tenantId,
        conversationId,
        customerId: customer.id,
        reason: escalationData.reason,
        serviceType: escalationData.serviceType,
        priority: escalationData.priority,
        diagnosticSummary: escalationData.diagnosticSummary,
        equipmentId: escalationData.equipmentId,
      });
    }

    // 5. Guardar el mensaje del Bot en base de datos
    const botMessage = await this.prisma.message.create({
      data: {
        tenantId,
        conversationId,
        senderType: SenderType.BOT,
        content: replyText,
      },
    });

    // 6. Actualizar fecha de la conversación
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date() },
    });

    // 7. Enviar respuesta oficial por WhatsApp Cloud API
    await this.metaCloudApiService.sendTextMessage({
      tenantId,
      to: customer.phone,
      text: replyText,
    });

    // 8. Transmitir respuesta del Bot en tiempo real a los operadores
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
   * Realiza el triaje técnico con Google Gemini inyectando las reglas y entrenamiento de la compañía
   */
  private async runAiDiagnostic(params: {
    tenantId: string;
    customer: any;
    recentMessages: any[];
    latestMessage: string;
  }): Promise<{
    replyText: string;
    shouldEscalate: boolean;
    escalationData?: {
      reason: string;
      serviceType: ServiceType;
      priority: TicketPriority;
      diagnosticSummary: string;
      equipmentId?: string;
    };
  }> {
    const { tenantId, customer, recentMessages, latestMessage } = params;

    // 1. Obtener la compañía con su configuración de IA y reglas activas
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      include: {
        aiRules: {
          where: { isActive: true },
          orderBy: { priority: 'asc' },
        },
        aiKnowledgeItems: {
          where: { isActive: true },
        },
        aiTrainingExamples: {
          where: { isApproved: true },
          take: 4,
        },
      },
    });

    const tenantName = tenant?.name || 'Soporte Técnico Especializado';
    const apiKey = tenant?.geminiApiKey?.trim() || this.configService.get<string>('GEMINI_API_KEY');
    const geminiModel = tenant?.geminiModel?.trim() || this.configService.get<string>('GEMINI_MODEL', 'gemini-2.0-flash');

    const equipmentsList = customer.equipments
      .map(
        (eq: any) =>
          `- ${eq.name} (Marca: ${eq.brand || 'N/A'}, Modelo: ${eq.model || 'N/A'}, S/N: ${eq.serialNumber || 'N/A'}) [ID: ${eq.id}]`,
      )
      .join('\n');

    // 2. Intentar invocar Google Gemini con las credenciales de la compañía o del sistema
    if (apiKey && apiKey !== 'your-gemini-api-key') {
      try {
        let client = this.aiClient;
        if (tenant?.geminiApiKey?.trim()) {
          client = new GoogleGenAI({ apiKey: tenant.geminiApiKey.trim() });
        } else if (!client) {
          client = new GoogleGenAI({ apiKey });
        }

        let prompt = `Eres el asistente de soporte técnico Nivel 1 para atención por WhatsApp de la empresa "${tenantName}".
Tu función es atender al cliente cordialmente, indagar sobre la falla y resolver o clasificar la atención.
${tenant?.aiSystemPrompt ? `DIRECTIVA BASE DE LA EMPRESA:\n${tenant.aiSystemPrompt}\n` : ''}

EQUIPOS REGISTRADOS DEL CLIENTE:
${equipmentsList || 'No posee equipos registrados previamente.'}
`;

        if (tenant && tenant.aiRules.length > 0) {
          prompt += `\nREGLAS DE OBLIGATORIO CUMPLIMIENTO PARA ESTA EMPRESA:\n`;
          tenant.aiRules.forEach((rule, idx) => {
            prompt += `${idx + 1}. [${rule.category}] ${rule.title}: ${rule.instruction}\n`;
          });
        }

        if (tenant && tenant.aiKnowledgeItems.length > 0) {
          prompt += `\nBASE DE CONOCIMIENTOS TÉCNICOS Y PREGUNTAS FRECUENTES:\n`;
          tenant.aiKnowledgeItems.forEach((kb) => {
            prompt += `P: ${kb.question}\nR: ${kb.answer}\n`;
          });
        }

        if (tenant && tenant.aiTrainingExamples.length > 0) {
          prompt += `\nEJEMPLOS DE RESPUESTAS APROBADAS POR OPERADORES:\n`;
          tenant.aiTrainingExamples.forEach((ex) => {
            prompt += `Cliente: "${ex.customerInput}" ➔ Asistente: "${ex.idealResponse}"\n`;
          });
        }

        prompt += `
REGLAS GENERALES DE DERIVACIÓN TÉCNICA:
- Si el problema es leve (duda de configuración, reinicio simple), proporciona una instrucción concisa en un solo párrafo.
- Si el cliente menciona: humo, olor a quemado, chispa, golpe físico, falla mecánica, placa rota o no enciende tras verificar térmicas, DEBES DERIVAR A VISITA FÍSICA (ONSITE_PHYSICAL) con prioridad ALTA o CRÍTICA.
- Si el problema es de software, configuración avanzada o calibración remota, deriva a ATENCIÓN REMOTA POR WHATSAPP (REMOTE_WHATSAPP).

Último mensaje del cliente: "${latestMessage}"

Si decides derivar, incluye al final de tu respuesta una línea exacta con el siguiente formato JSON:
ESCALATION_JSON:{"shouldEscalate":true,"reason":"...","serviceType":"REMOTE_WHATSAPP" o "ONSITE_PHYSICAL","priority":"MEDIUM" o "HIGH" o "CRITICAL","diagnosticSummary":"...","equipmentId":"..."}`;

        const response = await client.models.generateContent({
          model: geminiModel,
          contents: prompt,
        });

        const outputText = response.text || '';

        if (outputText.includes('ESCALATION_JSON:')) {
          const parts = outputText.split('ESCALATION_JSON:');
          const cleanReply = parts[0].trim();
          const jsonStr = parts[1].trim();
          const parsed = JSON.parse(jsonStr);

          return {
            replyText: cleanReply,
            shouldEscalate: true,
            escalationData: {
              reason: parsed.reason,
              serviceType: parsed.serviceType === 'ONSITE_PHYSICAL' ? ServiceType.ONSITE_PHYSICAL : ServiceType.REMOTE_WHATSAPP,
              priority: (parsed.priority as TicketPriority) || TicketPriority.HIGH,
              diagnosticSummary: parsed.diagnosticSummary,
              equipmentId: parsed.equipmentId || customer.equipments[0]?.id,
            },
          };
        }

        return {
          replyText: outputText.trim(),
          shouldEscalate: false,
        };
      } catch (err) {
        this.logger.error(`Error en Gemini API call, aplicando triaje heurístico: ${err.message}`);
      }
    }

    // Motor de Triaje Heurístico Robusto (Fallback sin API Key)
    const lower = latestMessage.toLowerCase();
    const isPhysicalDanger =
      lower.includes('quemado') ||
      lower.includes('humo') ||
      lower.includes('chispa') ||
      lower.includes('olor') ||
      lower.includes('roto') ||
      lower.includes('explot') ||
      lower.includes('físico') ||
      lower.includes('electr');

    const matchedEquipment = customer.equipments[0];

    if (isPhysicalDanger) {
      const eqName = matchedEquipment ? matchedEquipment.name : 'tu equipo';
      return {
        replyText: `Entendido. Dado que mencionas indicios de anomalía eléctrica o sobrecalentamiento en ${eqName}, por seguridad te recomendamos desconectar la alimentación y no forzar el encendido. He registrado la incidencia y escalado el caso a nuestro equipo técnico para coordinar una VISITA FÍSICA en tu local. Un técnico continuará esta conversación a la brevedad.`,
        shouldEscalate: true,
        escalationData: {
          reason: `Riesgo eléctrico/sobrecalentamiento reportado en ${eqName}`,
          serviceType: ServiceType.ONSITE_PHYSICAL,
          priority: TicketPriority.HIGH,
          diagnosticSummary: `El cliente reportó anomalías térmicas/eléctricas durante la operación de ${eqName}. Se recomienda revisión presencial de fusible primario y fuente conmutada.`,
          equipmentId: matchedEquipment?.id,
        },
      };
    }

    if (lower.includes('error') || lower.includes('falla') || lower.includes('ayuda') || lower.includes('tecnico')) {
      const eqName = matchedEquipment ? `${matchedEquipment.name} (${matchedEquipment.brand || ''} ${matchedEquipment.model || ''})` : 'el equipo';
      return {
        replyText: `¡Hola! He identificado ${eqName} en nuestra base técnica. Para orientarte mejor: ¿la máquina emite algún código de error en pantalla o parpadeo en las luces indicadoras? ¿Ocurrió tras un corte de energía?`,
        shouldEscalate: false,
      };
    }

    return {
      replyText: `Hola ${customer.name}, gracias por comunicarte con nuestro servicio técnico oficial. ¿En qué podemos ayudarte hoy con tus equipos?`,
      shouldEscalate: false,
    };
  }

  /**
   * Ejecuta el traspaso automático (Handoff) de IA a Técnico Humano
   */
  private async escalateToHuman(params: {
    tenantId: string;
    conversationId: string;
    customerId: string;
    reason: string;
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
      serviceType,
      priority,
      diagnosticSummary,
      equipmentId,
    } = params;

    // 1. Cambiar estado de la conversación a WAITING_AGENT y guardar diagnóstico
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        status: ConversationStatus.WAITING_AGENT,
        aiDiagnostic: diagnosticSummary,
      },
    });

    // 2. Crear Orden de Servicio / Ticket técnico
    const ticket = await this.prisma.ticket.create({
      data: {
        tenantId,
        customerId,
        conversationId,
        equipmentId,
        title: `Incidencia WhatsApp: ${reason.slice(0, 80)}`,
        description: reason,
        aiDiagnostic: diagnosticSummary,
        serviceType,
        priority,
        status: TicketStatus.OPEN,
      },
    });

    // 3. Notificación in-app urgente y WebSocket para los técnicos
    const modalityText =
      serviceType === ServiceType.ONSITE_PHYSICAL
        ? 'Visita Presencial en Local'
        : 'Soporte Remoto por WhatsApp';

    await this.notificationsService.notify({
      tenantId,
      type: 'ticket.escalated',
      title: `⚠️ Ticket #${ticket.id.slice(-4)} Escalado por IA (${modalityText})`,
      body: diagnosticSummary,
      link: `/tickets`,
    });

    // 4. Emitir actualización de estado de la conversación en tiempo real
    this.eventsGateway.emitToTenant(tenantId, 'chat:conversation_updated', {
      conversationId,
      status: ConversationStatus.WAITING_AGENT,
      aiDiagnostic: diagnosticSummary,
      ticketId: ticket.id,
    });

    // 5. Registro de Auditoría
    await this.auditService.log({
      tenantId,
      action: 'TICKET_ESCALATED_BY_AI',
      entity: 'Ticket',
      entityId: ticket.id,
      payload: {
        conversationId,
        serviceType,
        priority,
        diagnosticSummary,
      },
    });

    this.logger.log(
      `[AI Handoff] Conversación ${conversationId} derivada a técnico humano. Ticket creado: ${ticket.id}`,
    );

    return ticket;
  }
}

import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MetaCloudApiService } from '../whatsapp/providers/meta-cloud-api.service';
import { EventsGateway } from '../notifications/events.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { AiSupportService } from '../ai/ai-support.service';
import { AgentArea, ConversationStatus, SenderType } from '@prisma/client';
import { resolveTenantAgent } from '../agents/agents.helper';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly metaCloudApiService: MetaCloudApiService,
    private readonly eventsGateway: EventsGateway,
    private readonly notificationsService: NotificationsService,
    @Inject(forwardRef(() => AiSupportService))
    private readonly aiSupportService: AiSupportService,
  ) {}

  /**
   * Procesa un mensaje entrante de un cliente recibido vía Webhook oficial
   */
  async handleIncomingCustomerMessage(params: {
    tenantId: string;
    agentId?: string;
    fromPhone: string;
    customerName?: string;
    text: string;
    whatsappMessageId: string;
  }) {
    const { tenantId, agentId, fromPhone, customerName, text, whatsappMessageId } = params;
    const resolvedAgent = await resolveTenantAgent(this.prisma, tenantId, { agentId });
    const targetAgentId = resolvedAgent?.id;

    // 1. Deduplicación: Meta reintenta webhooks si no recibe 200 rápido
    const existingMessage = await this.prisma.message.findFirst({
      where: { whatsappMessageId },
    });
    if (existingMessage) {
      this.logger.warn(`Mensaje duplicado descartado: ${whatsappMessageId}`);
      return existingMessage;
    }

    // 2. Normalizar teléfono entrante con prefijo '+' (E.164) y buscar/registrar contacto de WhatsApp
    const digits = fromPhone.replace(/\D/g, '');
    const normalizedPhone = digits ? `+${digits}` : fromPhone.trim();
    const phoneCandidates = Array.from(new Set([normalizedPhone, digits, fromPhone.trim()].filter(Boolean)));

    let customer = await this.prisma.customer.findFirst({
      where: {
        tenantId,
        phone: { in: phoneCandidates },
      },
    });

    if (!customer) {
      customer = await this.prisma.customer.create({
        data: {
          tenantId,
          phone: normalizedPhone,
          name: customerName || `Cliente WhatsApp (${digits.slice(-4) || fromPhone.slice(-4)})`,
        },
      });
      this.logger.log(`Nuevo contacto WhatsApp creado para tenant ${tenantId}: ${customer.name} (${normalizedPhone})`);
    } else {
      const updateData: Record<string, any> = {};
      if (customer.phone !== normalizedPhone) {
        updateData.phone = normalizedPhone;
      }
      if (customerName && customer.name.startsWith('Cliente WhatsApp')) {
        updateData.name = customerName;
      }
      if (Object.keys(updateData).length > 0) {
        customer = await this.prisma.customer.update({
          where: { id: customer.id },
          data: updateData,
        });
      }
    }

    // 3. Buscar conversación activa (no resuelta) para este cliente y agente/línea o crear una nueva
    let conversation = await this.prisma.conversation.findFirst({
      where: {
        tenantId,
        customerId: customer.id,
        ...(targetAgentId ? { agentId: targetAgentId } : {}),
        status: {
          not: ConversationStatus.RESOLVED,
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    if (!conversation) {
      conversation = await this.prisma.conversation.create({
        data: {
          tenantId,
          agentId: targetAgentId ?? null,
          customerId: customer.id,
          status: ConversationStatus.BOT_HANDLING, // Inicia con triaje IA
        },
      });
    }

    // 4. Guardar el mensaje entrante del cliente
    const message = await this.prisma.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        senderType: SenderType.CUSTOMER,
        content: text,
        whatsappMessageId,
      },
    });

    // 5. Actualizar última actividad de la conversación
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() },
    });

    // 6. Transmitir en tiempo real a todos los operadores de la empresa
    this.eventsGateway.emitToTenant(tenantId, 'chat:new_message', {
      conversationId: conversation.id,
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
      },
      message,
    });

    if (conversation.status === ConversationStatus.WAITING_AGENT) {
      await this.notificationsService.notify({
        tenantId,
        type: 'chat.waiting_agent',
        title: `Mensaje de cliente: ${customer.name}`,
        body: text,
        link: `/chat/${conversation.id}`,
      });
    }

    // 7. Si la conversación está en manos del Bot IA, procesar triaje automático con el agente asignado
    if (conversation.status === ConversationStatus.BOT_HANDLING) {
      this.logger.log(`Invocando triaje de IA para conversación ${conversation.id}...`);
      await this.aiSupportService.processCustomerMessage({
        tenantId,
        agentId: conversation.agentId ?? targetAgentId,
        conversationId: conversation.id,
        customerId: customer.id,
        messageText: text,
      });
    }

    this.logger.log(
      `Mensaje recibido en conversación ${conversation.id} de cliente ${customer.phone}`,
    );

    return {
      customer,
      conversation,
      message,
    };
  }

  /**
   * Envía un mensaje como agente/técnico humano y registra la trazabilidad del operador
   */
  async sendAgentMessage(params: {
    tenantId: string;
    conversationId: string;
    userId: string;
    text: string;
  }) {
    const { tenantId, conversationId, userId, text } = params;

    // 1. Validar existencia y aislamiento de tenant
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        customer: true,
      },
    });

    if (!conversation || conversation.tenantId !== tenantId) {
      throw new NotFoundException('Conversación no encontrada o no autorizada');
    }

    // 2. Obtener datos del operador
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, role: true },
    });

    if (!user) {
      throw new ForbiddenException('Usuario operador no encontrado');
    }

    // 3. Despachar a Meta Cloud API usando la línea/agente dueño de la conversación
    const result = await this.metaCloudApiService.sendTextMessage({
      tenantId,
      agentId: conversation.agentId ?? undefined,
      to: conversation.customer.phone,
      text,
    });

    // 4. Persistir mensaje con trazabilidad del usuario (`senderUserId`)
    const savedMessage = await this.prisma.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        senderType: SenderType.AGENT,
        senderUserId: user.id, // ¡TRAZABILIDAD OBLIGATORIA!
        content: text,
        whatsappMessageId: result.whatsappMessageId || undefined,
      },
      include: {
        senderUser: {
          select: {
            id: true,
            name: true,
            role: true,
          },
        },
      },
    });

    // 5. Actualizar estado de la conversación (si estaba en espera pasa a AGENT_HANDLING)
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        status: ConversationStatus.AGENT_HANDLING,
        assignedUserId: conversation.assignedUserId || user.id,
        lastMessageAt: new Date(),
      },
    });

    // 6. Registro de Auditoría
    await this.auditService.log({
      tenantId,
      userId: user.id,
      action: 'CHAT_MESSAGE_SENT',
      entity: 'Message',
      entityId: savedMessage.id,
      payload: {
        conversationId: conversation.id,
        customerPhone: conversation.customer.phone,
        operatorName: user.name,
      },
    });

    // 7. Transmitir por WebSockets a todos los operadores de la empresa
    this.eventsGateway.emitToTenant(tenantId, 'chat:message_sent', {
      conversationId: conversation.id,
      message: savedMessage,
      operator: {
        id: user.id,
        name: user.name,
        role: user.role,
      },
    });

    return savedMessage;
  }

  /**
   * Obtiene la lista de conversaciones de la empresa con filtros opcionales por estado, área o agente
   */
  async getConversations(
    tenantId: string,
    status?: ConversationStatus,
    options?: { area?: AgentArea; agentId?: string },
  ) {
    return this.prisma.conversation.findMany({
      where: {
        tenantId,
        ...(status ? { status } : {}),
        ...(options?.agentId ? { agentId: options.agentId } : {}),
        ...(options?.area
          ? {
              OR: [{ agent: { area: options.area } }, ...(options.area === AgentArea.TECHNICAL_SERVICE ? [{ agentId: null }] : [])],
            }
          : {}),
      },
      include: {
        agent: {
          select: {
            id: true,
            code: true,
            name: true,
            area: true,
            whatsappPhone: true,
          },
        },
        customer: {
          include: {
            equipments: {
              select: {
                id: true,
                name: true,
                brand: true,
                model: true,
                serialNumber: true,
                status: true,
              },
            },
          },
        },
        assignedUser: {
          select: {
            id: true,
            name: true,
            role: true,
          },
        },
        messages: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          include: {
            senderUser: {
              select: { id: true, name: true },
            },
          },
        },
        tickets: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            title: true,
            serviceType: true,
            priority: true,
            status: true,
            aiDiagnostic: true,
          },
        },
      },
      orderBy: { lastMessageAt: 'desc' },
    });
  }

  /**
   * Obtiene el historial de mensajes de una conversación
   */
  async getConversationMessages(
    tenantId: string,
    conversationId: string,
    limit = 100,
  ) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { tenantId: true },
    });

    if (!conversation || conversation.tenantId !== tenantId) {
      throw new NotFoundException('Conversación no encontrada');
    }

    return this.prisma.message.findMany({
      where: { conversationId },
      include: {
        senderUser: {
          select: {
            id: true,
            name: true,
            role: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  /**
   * Reasigna la conversación a otro técnico u operador
   */
  async assignConversation(
    tenantId: string,
    conversationId: string,
    targetUserId: string,
    actorUserId: string,
  ) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!conversation || conversation.tenantId !== tenantId) {
      throw new NotFoundException('Conversación no encontrada');
    }

    const updated = await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        assignedUserId: targetUserId,
        status: ConversationStatus.AGENT_HANDLING,
      },
      include: {
        assignedUser: { select: { id: true, name: true, role: true } },
      },
    });

    await this.auditService.log({
      tenantId,
      userId: actorUserId,
      action: 'CONVERSATION_ASSIGNED',
      entity: 'Conversation',
      entityId: conversationId,
      payload: { assignedToUserId: targetUserId },
    });

    // Notificar al usuario asignado y emitir actualización a la sala de la empresa
    await this.notificationsService.notify({
      tenantId,
      userId: targetUserId,
      type: 'chat.assigned',
      title: 'Conversación asignada',
      body: 'Se te ha asignado un chat de soporte técnico',
      link: `/chat/${conversationId}`,
    });

    this.eventsGateway.emitToTenant(tenantId, 'chat:conversation_updated', {
      conversationId,
      status: ConversationStatus.AGENT_HANDLING,
      assignedUserId: targetUserId,
    });

    return updated;
  }

  /**
   * Marca una conversación como resuelta
   */
  async resolveConversation(
    tenantId: string,
    conversationId: string,
    actorUserId: string,
  ) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!conversation || conversation.tenantId !== tenantId) {
      throw new NotFoundException('Conversación no encontrada');
    }

    const updated = await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { status: ConversationStatus.RESOLVED },
    });

    await this.auditService.log({
      tenantId,
      userId: actorUserId,
      action: 'CONVERSATION_RESOLVED',
      entity: 'Conversation',
      entityId: conversationId,
    });

    this.eventsGateway.emitToTenant(tenantId, 'chat:conversation_updated', {
      conversationId,
      status: ConversationStatus.RESOLVED,
    });

    return updated;
  }

  /**
   * Tomar conversación por un operador humano (pausa las respuestas automáticas de la IA)
   */
  async takeOverConversation(
    tenantId: string,
    conversationId: string,
    userId: string,
  ) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { customer: true },
    });

    if (!conversation || conversation.tenantId !== tenantId) {
      throw new NotFoundException('Conversación no encontrada');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, role: true },
    });

    const updated = await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        status: ConversationStatus.AGENT_HANDLING,
        assignedUserId: userId,
      },
      include: {
        customer: true,
        assignedUser: { select: { id: true, name: true, role: true } },
        tickets: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            title: true,
            serviceType: true,
            priority: true,
            status: true,
            aiDiagnostic: true,
          },
        },
      },
    });

    await this.auditService.log({
      tenantId,
      userId,
      action: 'CONVERSATION_TAKEN_OVER',
      entity: 'Conversation',
      entityId: conversationId,
      payload: { takenByUserId: userId, userName: user?.name },
    });

    this.eventsGateway.emitToTenant(tenantId, 'chat:conversation_updated', {
      conversationId,
      status: ConversationStatus.AGENT_HANDLING,
      assignedUserId: userId,
      assignedUser: user,
    });

    return updated;
  }

  /**
   * Devolver la conversación a la IA (reactiva las respuestas automáticas del bot)
   */
  async releaseConversationToBot(
    tenantId: string,
    conversationId: string,
    userId: string,
  ) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { customer: true },
    });

    if (!conversation || conversation.tenantId !== tenantId) {
      throw new NotFoundException('Conversación no encontrada');
    }

    const updated = await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        status: ConversationStatus.BOT_HANDLING,
        assignedUserId: null,
      },
      include: {
        customer: true,
        assignedUser: { select: { id: true, name: true, role: true } },
        tickets: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            title: true,
            serviceType: true,
            priority: true,
            status: true,
            aiDiagnostic: true,
          },
        },
      },
    });

    await this.auditService.log({
      tenantId,
      userId,
      action: 'CONVERSATION_RELEASED_TO_BOT',
      entity: 'Conversation',
      entityId: conversationId,
    });

    this.eventsGateway.emitToTenant(tenantId, 'chat:conversation_updated', {
      conversationId,
      status: ConversationStatus.BOT_HANDLING,
      assignedUserId: null,
      assignedUser: null,
    });

    return updated;
  }
}

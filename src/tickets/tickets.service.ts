import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  TicketStatus,
  ServiceType,
  TicketPriority,
  TicketSource,
  TicketReason,
} from '@prisma/client';
import { UpdateTicketDto } from './dto/update-ticket.dto';

@Injectable()
export class TicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /**
   * Catálogos operativos del tenant para edición de tickets (clientes, equipos y problemas ERP)
   */
  async getCatalogs(tenantId: string) {
    const [customers, problemTypes] = await Promise.all([
      this.prisma.customer.findMany({
        where: { tenantId },
        include: {
          equipments: {
            orderBy: { name: 'asc' },
          },
        },
        orderBy: { name: 'asc' },
      }),
      this.prisma.problemType.findMany({
        where: {
          tenantId,
          isActive: true,
        },
        orderBy: { name: 'asc' },
      }),
    ]);

    return {
      customers,
      problemTypes,
    };
  }

  /**
   * Obtiene todos los tickets/órdenes de la empresa con filtros
   */
  async getTenantTickets(params: {
    tenantId: string;
    status?: TicketStatus;
    serviceType?: ServiceType;
    reason?: TicketReason;
    source?: TicketSource;
    limit?: number;
  }) {
    const { tenantId, status, serviceType, reason, source, limit = 100 } = params;

    return this.prisma.ticket.findMany({
      where: {
        tenantId,
        ...(status ? { status } : {}),
        ...(serviceType ? { serviceType } : {}),
        ...(reason ? { reason } : {}),
        ...(source ? { source } : {}),
      },
      include: {
        customer: true,
        equipment: true,
        problemType: true,
        conversation: {
          select: {
            id: true,
            status: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Obtiene el detalle de un ticket específico
   */
  async getTicketById(tenantId: string, id: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id },
      include: {
        customer: {
          include: { equipments: true },
        },
        equipment: true,
        problemType: true,
        conversation: true,
      },
    });

    if (!ticket || ticket.tenantId !== tenantId) {
      throw new NotFoundException('Ticket de soporte no encontrado');
    }

    return ticket;
  }

  /**
   * Actualiza el estado, motivo, técnico asignado o notas de resolución del ticket
   */
  async updateTicket(tenantId: string, id: string, dto: UpdateTicketDto, actorUserId: string) {
    await this.getTicketById(tenantId, id);

    if (dto.customerId) {
      const customer = await this.prisma.customer.findFirst({
        where: { id: dto.customerId, tenantId },
      });
      if (!customer) {
        throw new NotFoundException('Cliente no encontrado para esta empresa');
      }
    }

    if (dto.equipmentId) {
      const equipment = await this.prisma.equipment.findFirst({
        where: { id: dto.equipmentId, tenantId },
      });
      if (!equipment) {
        throw new NotFoundException('Equipo no encontrado para esta empresa');
      }
    }

    if (dto.problemTypeId) {
      const problemType = await this.prisma.problemType.findFirst({
        where: { id: dto.problemTypeId, tenantId },
      });
      if (!problemType) {
        throw new NotFoundException('Tipo de problema no encontrado para esta empresa');
      }
    }

    const updated = await this.prisma.ticket.update({
      where: { id },
      data: {
        ...(dto.customerId ? { customerId: dto.customerId } : {}),
        ...(dto.equipmentId !== undefined ? { equipmentId: dto.equipmentId || null } : {}),
        ...(dto.problemTypeId !== undefined ? { problemTypeId: dto.problemTypeId || null } : {}),
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.priority ? { priority: dto.priority } : {}),
        ...(dto.serviceType ? { serviceType: dto.serviceType } : {}),
        ...(dto.reason ? { reason: dto.reason } : {}),
        ...(dto.serviceOrderNumber !== undefined ? { serviceOrderNumber: dto.serviceOrderNumber } : {}),
        ...(dto.resolutionNotes !== undefined ? { resolutionNotes: dto.resolutionNotes } : {}),
        ...(dto.scheduledDate !== undefined
          ? { scheduledDate: dto.scheduledDate ? new Date(dto.scheduledDate) : null }
          : {}),
      },
      include: {
        customer: true,
        equipment: true,
        problemType: true,
        conversation: {
          select: { id: true, status: true },
        },
      },
    });

    await this.auditService.log({
      tenantId,
      userId: actorUserId,
      action: 'TICKET_UPDATED',
      entity: 'Ticket',
      entityId: id,
      payload: dto,
    });

    return updated;
  }

  /**
   * Vincula un número de Orden de Servicio y envía la notificación oficial a WhatsApp
   */
  async notifyServiceOrder(params: {
    tenantId: string;
    ticketId: string;
    serviceOrderNumber: string;
    customMessage?: string;
    actorUserId: string;
  }) {
    const { tenantId, ticketId, serviceOrderNumber, customMessage, actorUserId } = params;

    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        customer: true,
        equipment: true,
        conversation: true,
      },
    });

    if (!ticket || ticket.tenantId !== tenantId) {
      throw new NotFoundException('Ticket de soporte no encontrado');
    }

    const cleanOrderNumber = serviceOrderNumber.trim();

    const updatedTicket = await this.prisma.ticket.update({
      where: { id: ticketId },
      data: {
        serviceOrderNumber: cleanOrderNumber,
        status: ticket.status === TicketStatus.OPEN ? TicketStatus.IN_PROGRESS : ticket.status,
      },
      include: {
        customer: true,
        equipment: true,
        assignedTechnician: {
          select: { id: true, name: true, email: true, role: true },
        },
      },
    });

    const messageToSend =
      customMessage?.trim() ||
      `Estimado/a ${ticket.customer.name}, le informamos que se ha generado la *Orden de Servicio N° ${cleanOrderNumber}* para la atención técnica de su caso${ticket.equipment ? ` sobre el equipo *${ticket.equipment.name}* (S/N: ${ticket.equipment.serialNumber})` : ''}. Nuestro equipo técnico se encuentra gestionando su solicitud con la máxima prioridad.`;

    if (ticket.conversationId) {
      await this.prisma.message.create({
        data: {
          tenantId,
          conversationId: ticket.conversationId,
          senderType: 'AGENT',
          senderUserId: actorUserId,
          content: messageToSend,
        },
      });

      await this.prisma.conversation.update({
        where: { id: ticket.conversationId },
        data: { lastMessageAt: new Date() },
      });
    }

    await this.auditService.log({
      tenantId,
      userId: actorUserId,
      action: 'TICKET_SERVICE_ORDER_NOTIFIED',
      entity: 'Ticket',
      entityId: ticketId,
      payload: {
        serviceOrderNumber: cleanOrderNumber,
        conversationId: ticket.conversationId,
        message: messageToSend,
      },
    });

    return {
      success: true,
      ticket: updatedTicket,
      messageSent: messageToSend,
    };
  }
}

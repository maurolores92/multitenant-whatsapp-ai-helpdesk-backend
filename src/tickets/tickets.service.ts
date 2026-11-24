import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TicketStatus, ServiceType, TicketPriority } from '@prisma/client';

@Injectable()
export class TicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Obtiene todos los tickets/órdenes de la empresa con filtros
   */
  async getTenantTickets(params: {
    tenantId: string;
    status?: TicketStatus;
    serviceType?: ServiceType;
    limit?: number;
  }) {
    const { tenantId, status, serviceType, limit = 50 } = params;

    return this.prisma.ticket.findMany({
      where: {
        tenantId,
        ...(status ? { status } : {}),
        ...(serviceType ? { serviceType } : {}),
      },
      include: {
        customer: true,
        equipment: true,
        assignedTechnician: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
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
        assignedTechnician: {
          select: { id: true, name: true, role: true },
        },
        conversation: true,
      },
    });

    if (!ticket || ticket.tenantId !== tenantId) {
      throw new NotFoundException('Ticket de soporte no encontrado');
    }

    return ticket;
  }

  /**
   * Actualiza el estado, técnico asignado o notas de resolución del ticket
   */
  async updateTicket(params: {
    tenantId: string;
    id: string;
    status?: TicketStatus;
    priority?: TicketPriority;
    serviceType?: ServiceType;
    serviceOrderNumber?: string;
    assignedTechnicianId?: string;
    resolutionNotes?: string;
    actorUserId: string;
  }) {
    const {
      tenantId,
      id,
      status,
      priority,
      serviceType,
      serviceOrderNumber,
      assignedTechnicianId,
      resolutionNotes,
      actorUserId,
    } = params;

    const ticket = await this.getTicketById(tenantId, id);

    const updated = await this.prisma.ticket.update({
      where: { id },
      data: {
        ...(status ? { status } : {}),
        ...(priority ? { priority } : {}),
        ...(serviceType ? { serviceType } : {}),
        ...(serviceOrderNumber !== undefined ? { serviceOrderNumber } : {}),
        ...(assignedTechnicianId !== undefined ? { assignedTechnicianId } : {}),
        ...(resolutionNotes ? { resolutionNotes } : {}),
      },
      include: {
        assignedTechnician: {
          select: { id: true, name: true },
        },
      },
    });

    await this.auditService.log({
      tenantId,
      userId: actorUserId,
      action: 'TICKET_UPDATED',
      entity: 'Ticket',
      entityId: id,
      payload: { status, priority, serviceType, serviceOrderNumber, assignedTechnicianId },
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

    // Actualizar el ticket con el número de orden de servicio
    const updatedTicket = await this.prisma.ticket.update({
      where: { id: ticketId },
      data: {
        serviceOrderNumber: cleanOrderNumber,
        status: ticket.status === TicketStatus.OPEN ? TicketStatus.IN_PROGRESS : ticket.status,
      },
      include: {
        customer: true,
        equipment: true,
      },
    });

    // Mensaje profesional por default o personalizado
    const messageToSend =
      customMessage?.trim() ||
      `Estimado/a ${ticket.customer.name}, le informamos que se ha generado la *Orden de Servicio N° ${cleanOrderNumber}* para la atención técnica de su caso${ticket.equipment ? ` sobre el equipo *${ticket.equipment.name}* (S/N: ${ticket.equipment.serialNumber})` : ''}. Nuestro equipo técnico se encuentra gestionando su solicitud con la máxima prioridad. Muchas gracias por confiar en HelpCopies SRL.`;

    // Si tiene conversación de WhatsApp vinculada, registrar el mensaje en la conversación
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

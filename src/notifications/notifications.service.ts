import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from './events.gateway';

export interface CreateNotificationParams {
  tenantId: string;
  userId?: string;
  type: string;
  title: string;
  body: string;
  link?: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsGateway: EventsGateway,
  ) {}

  /**
   * Crea una notificación persistente y la emite en tiempo real vía WebSockets
   */
  async notify(params: CreateNotificationParams) {
    try {
      // 1. Persistir en la base de datos
      const notification = await this.prisma.notification.create({
        data: {
          tenantId: params.tenantId,
          userId: params.userId ?? null,
          type: params.type,
          title: params.title,
          body: params.body,
          link: params.link,
        },
      });

      // 2. Despachar evento WebSocket en tiempo real
      if (params.userId) {
        this.eventsGateway.emitToUser(
          params.tenantId,
          params.userId,
          'notification:new',
          notification,
        );
      } else {
        this.eventsGateway.emitToTenant(
          params.tenantId,
          'notification:new',
          notification,
        );
      }

      this.logger.log(
        `[Notificación emitida] Tenant: ${params.tenantId} | Tipo: ${params.type} | Titulo: ${params.title}`,
      );

      return notification;
    } catch (error) {
      this.logger.error(`Error al crear notificación: ${error.message}`, error.stack);
      return null;
    }
  }

  /**
   * Lista las notificaciones de un operador (las suyas y las de toda la empresa)
   */
  async getUserNotifications(tenantId: string, userId: string, limit = 30) {
    return this.prisma.notification.findMany({
      where: {
        tenantId,
        OR: [{ userId }, { userId: null }],
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Marca una notificación como leída
   */
  async markAsRead(tenantId: string, notificationId: string) {
    return this.prisma.notification.updateMany({
      where: {
        id: notificationId,
        tenantId,
      },
      data: { isRead: true },
    });
  }

  /**
   * Marca todas las notificaciones como leídas
   */
  async markAllAsRead(tenantId: string, userId: string) {
    return this.prisma.notification.updateMany({
      where: {
        tenantId,
        OR: [{ userId }, { userId: null }],
        isRead: false,
      },
      data: { isRead: true },
    });
  }
}

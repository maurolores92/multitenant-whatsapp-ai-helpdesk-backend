import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface LogAuditParams {
  tenantId: string;
  userId?: string;
  action: string;
  entity: string;
  entityId?: string;
  payload?: any;
  ipAddress?: string;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Registra un evento de auditoría obligatorio con aislamiento de Tenant
   */
  async log(params: LogAuditParams) {
    try {
      const record = await this.prisma.auditLog.create({
        data: {
          tenantId: params.tenantId,
          userId: params.userId,
          action: params.action,
          entity: params.entity,
          entityId: params.entityId,
          payload: params.payload ?? undefined,
          ipAddress: params.ipAddress,
        },
      });

      this.logger.log(
        `[AUDIT] Tenant: ${params.tenantId} | User: ${params.userId ?? 'SYSTEM'} | Action: ${params.action} | Entity: ${params.entity}:${params.entityId ?? ''}`,
      );

      return record;
    } catch (error) {
      this.logger.error(`Error al registrar log de auditoría: ${error.message}`, error.stack);
      // No bloqueamos la ejecución principal si falla la auditoría secundaria
      return null;
    }
  }

  /**
   * Consulta el historial de auditoría de una empresa con paginación
   */
  async getTenantLogs(tenantId: string, limit = 50, skip = 0) {
    return this.prisma.auditLog.findMany({
      where: { tenantId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip,
    });
  }
}

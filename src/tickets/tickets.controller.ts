import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { TicketsService } from './tickets.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../auth/constants/permissions.constant';
import { TicketStatus, ServiceType, TicketPriority } from '@prisma/client';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('tickets')
export class TicketsController {
  constructor(private readonly ticketsService: TicketsService) {}

  @RequirePermissions(PERMISSIONS.READ_CHATS)
  @Get()
  async getTickets(
    @CurrentTenant() tenantId: string,
    @Query('status') status?: TicketStatus,
    @Query('serviceType') serviceType?: ServiceType,
    @Query('limit') limit?: number,
  ) {
    return this.ticketsService.getTenantTickets({
      tenantId,
      status,
      serviceType,
      limit: limit ? Number(limit) : 50,
    });
  }

  @RequirePermissions(PERMISSIONS.READ_CHATS)
  @Get(':id')
  async getTicketById(
    @CurrentTenant() tenantId: string,
    @Param('id') id: string,
  ) {
    return this.ticketsService.getTicketById(tenantId, id);
  }

  @RequirePermissions(PERMISSIONS.UPDATE_TICKET)
  @Patch(':id')
  async updateTicket(
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') actorUserId: string,
    @Param('id') id: string,
    @Body()
    body: {
      status?: TicketStatus;
      priority?: TicketPriority;
      serviceType?: ServiceType;
      serviceOrderNumber?: string;
      assignedTechnicianId?: string;
      resolutionNotes?: string;
    },
  ) {
    return this.ticketsService.updateTicket({
      tenantId,
      id,
      actorUserId,
      ...body,
    });
  }

  @RequirePermissions(PERMISSIONS.UPDATE_TICKET)
  @Post(':id/notify-service-order')
  async notifyServiceOrder(
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') actorUserId: string,
    @Param('id') id: string,
    @Body()
    body: {
      serviceOrderNumber: string;
      customMessage?: string;
    },
  ) {
    return this.ticketsService.notifyServiceOrder({
      tenantId,
      ticketId: id,
      serviceOrderNumber: body.serviceOrderNumber,
      customMessage: body.customMessage,
      actorUserId,
    });
  }
}

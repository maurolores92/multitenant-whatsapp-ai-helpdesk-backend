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
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../auth/constants/permissions.constant';
import { TicketStatus, ServiceType, TicketReason, TicketSource } from '@prisma/client';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('tickets')
export class TicketsController {
  constructor(private readonly ticketsService: TicketsService) {}

  @RequirePermissions(PERMISSIONS.ACCESS_TECHNICAL_SERVICE)
  @Get('catalogs')
  async getCatalogs(@CurrentTenant() tenantId: string) {
    return this.ticketsService.getCatalogs(tenantId);
  }

  @RequirePermissions(PERMISSIONS.ACCESS_TECHNICAL_SERVICE)
  @Get()
  async getTickets(
    @CurrentTenant() tenantId: string,
    @Query('status') status?: TicketStatus,
    @Query('serviceType') serviceType?: ServiceType,
    @Query('reason') reason?: TicketReason,
    @Query('source') source?: TicketSource,
    @Query('limit') limit?: number,
  ) {
    return this.ticketsService.getTenantTickets({
      tenantId,
      status,
      serviceType,
      reason,
      source,
      limit: limit ? Number(limit) : 100,
    });
  }

  @RequirePermissions(PERMISSIONS.ACCESS_TECHNICAL_SERVICE)
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
    @Body() body: UpdateTicketDto,
  ) {
    return this.ticketsService.updateTicket(tenantId, id, body, actorUserId);
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

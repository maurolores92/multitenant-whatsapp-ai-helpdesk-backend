import { Controller, Get, Patch, Param, UseGuards, Query } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';

@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  async getNotifications(
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
    @Query('limit') limit?: number,
  ) {
    return this.notificationsService.getUserNotifications(
      tenantId,
      userId,
      limit ? Number(limit) : 30,
    );
  }

  @Patch(':id/read')
  async markAsRead(
    @CurrentTenant() tenantId: string,
    @Param('id') notificationId: string,
  ) {
    return this.notificationsService.markAsRead(tenantId, notificationId);
  }

  @Patch('read-all')
  async markAllAsRead(
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.notificationsService.markAllAsRead(tenantId, userId);
  }
}

import {
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Body,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ErpSyncService } from './erp-sync.service';
import { UpdateErpConfigDto } from './dto/update-erp-config.dto';

@Controller('tenants/:tenantId/erp-sync')
@UseGuards(JwtAuthGuard)
export class ErpSyncController {
  constructor(private readonly erpSyncService: ErpSyncService) {}

  private assertCanAccessTenant(user: any, tenantId: string) {
    if (user.role === Role.SUPER_ADMIN) return;
    if (user.role === Role.ADMIN && user.tenantId === tenantId) return;

    throw new ForbiddenException(
      'Solo un Superadministrador o Administrador de la compañía puede gestionar la conexión con HelpCopies ERP',
    );
  }

  @Get('config')
  async getConfig(@Param('tenantId') tenantId: string, @CurrentUser() user: any) {
    this.assertCanAccessTenant(user, tenantId);
    return this.erpSyncService.getConfig(tenantId);
  }

  @Patch('config')
  async updateConfig(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateErpConfigDto,
    @CurrentUser() user: any,
  ) {
    this.assertCanAccessTenant(user, tenantId);
    return this.erpSyncService.updateConfig(tenantId, dto, user.id);
  }

  @Get('problems')
  async getProblems(@Param('tenantId') tenantId: string, @CurrentUser() user: any) {
    this.assertCanAccessTenant(user, tenantId);
    return this.erpSyncService.getProblems(tenantId);
  }

  @Post('test-connection')
  async testConnection(@Param('tenantId') tenantId: string, @CurrentUser() user: any) {
    this.assertCanAccessTenant(user, tenantId);
    return this.erpSyncService.testConnection(tenantId);
  }

  @Post('run')
  async runSync(@Param('tenantId') tenantId: string, @CurrentUser() user: any) {
    this.assertCanAccessTenant(user, tenantId);
    return this.erpSyncService.syncTenantFromErp(tenantId, user.id);
  }
}

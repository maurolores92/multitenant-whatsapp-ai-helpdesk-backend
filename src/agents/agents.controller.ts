import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { AgentsService } from './agents.service';
import { CreateAgentDto, UpdateAgentDto } from './dto/agent.dto';
import { UpdateWhatsAppConfigDto } from '../tenants/dto/update-whatsapp-config.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { PERMISSIONS } from '../auth/constants/permissions.constant';

@Controller('agents')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AgentsController {
  constructor(private readonly agentsService: AgentsService) {}

  @Get()
  async list(
    @CurrentTenant() currentTenantId: string,
    @CurrentUser() user: any,
    @Query('tenantId') queryTenantId?: string,
  ) {
    const targetTenantId =
      user.role === Role.SUPER_ADMIN && queryTenantId ? queryTenantId : currentTenantId;

    if (user.role !== Role.SUPER_ADMIN && targetTenantId !== user.tenantId) {
      throw new ForbiddenException('No autorizado para ver agentes de otra empresa');
    }

    return this.agentsService.listAgents(targetTenantId);
  }

  @RequirePermissions(PERMISSIONS.MANAGE_WHATSAPP_CONFIG)
  @Post()
  async create(
    @CurrentTenant() currentTenantId: string,
    @CurrentUser() user: any,
    @Body() dto: CreateAgentDto,
    @Query('tenantId') queryTenantId?: string,
  ) {
    const targetTenantId =
      user.role === Role.SUPER_ADMIN && queryTenantId ? queryTenantId : currentTenantId;
    return this.agentsService.createAgent(targetTenantId, dto, user.id);
  }

  @RequirePermissions(PERMISSIONS.MANAGE_WHATSAPP_CONFIG)
  @Patch(':agentId')
  async update(
    @CurrentTenant() currentTenantId: string,
    @CurrentUser() user: any,
    @Param('agentId') agentId: string,
    @Body() dto: UpdateAgentDto,
    @Query('tenantId') queryTenantId?: string,
  ) {
    const targetTenantId =
      user.role === Role.SUPER_ADMIN && queryTenantId ? queryTenantId : currentTenantId;
    return this.agentsService.updateAgent(targetTenantId, agentId, dto, user.id);
  }

  @RequirePermissions(PERMISSIONS.MANAGE_WHATSAPP_CONFIG)
  @Patch(':agentId/whatsapp-config')
  async updateWhatsAppConfig(
    @CurrentTenant() currentTenantId: string,
    @CurrentUser() user: any,
    @Param('agentId') agentId: string,
    @Body() dto: UpdateWhatsAppConfigDto,
    @Query('tenantId') queryTenantId?: string,
  ) {
    const targetTenantId =
      user.role === Role.SUPER_ADMIN && queryTenantId ? queryTenantId : currentTenantId;
    return this.agentsService.updateWhatsAppConfig(targetTenantId, agentId, dto, user.id);
  }

  @RequirePermissions(PERMISSIONS.MANAGE_WHATSAPP_CONFIG)
  @Delete(':agentId')
  async remove(
    @CurrentTenant() currentTenantId: string,
    @CurrentUser() user: any,
    @Param('agentId') agentId: string,
    @Query('tenantId') queryTenantId?: string,
  ) {
    const targetTenantId =
      user.role === Role.SUPER_ADMIN && queryTenantId ? queryTenantId : currentTenantId;
    return this.agentsService.deleteAgent(targetTenantId, agentId, user.id);
  }
}

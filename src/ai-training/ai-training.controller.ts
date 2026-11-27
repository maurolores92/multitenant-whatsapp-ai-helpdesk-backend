import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { AiTrainingService } from './ai-training.service';
import { UpdateAiConfigDto } from './dto/update-ai-config.dto';
import { CreateAiRuleDto, UpdateAiRuleDto } from './dto/ai-rule.dto';
import { CreateAiKnowledgeDto, UpdateAiKnowledgeDto } from './dto/ai-knowledge.dto';
import { CreateAiExampleDto, SimulateAiDto } from './dto/ai-example.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../auth/constants/permissions.constant';
import { AgentArea, Role } from '@prisma/client';

@Controller('tenants/:tenantId/ai-training')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.MANAGE_TECHNICAL_AI)
export class AiTrainingController {
  constructor(private readonly aiTrainingService: AiTrainingService) {}

  private assertTenantAccess(tenantId: string, user: any) {
    if (user.role !== Role.SUPER_ADMIN && user.tenantId !== tenantId) {
      throw new ForbiddenException(
        'No tienes acceso a la configuración y entrenamiento de IA de esta empresa',
      );
    }
  }

  // 1. Configuración de IA y API Key
  @Get('config')
  async getAiConfig(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: any,
    @Query('agentId') agentId?: string,
    @Query('area') area?: AgentArea,
  ) {
    this.assertTenantAccess(tenantId, user);
    return this.aiTrainingService.getAiConfig(tenantId, { agentId, area });
  }

  @Patch('config')
  async updateAiConfig(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateAiConfigDto,
    @CurrentUser() user: any,
    @Query('agentId') agentId?: string,
    @Query('area') area?: AgentArea,
  ) {
    this.assertTenantAccess(tenantId, user);
    return this.aiTrainingService.updateAiConfig(tenantId, dto, user.id, { agentId, area });
  }

  // 2. Reglas de Comportamiento
  @Get('rules')
  async getRules(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: any,
    @Query('agentId') agentId?: string,
    @Query('area') area?: AgentArea,
  ) {
    this.assertTenantAccess(tenantId, user);
    return this.aiTrainingService.getRules(tenantId, { agentId, area });
  }

  @Post('rules')
  async createRule(
    @Param('tenantId') tenantId: string,
    @Body() dto: CreateAiRuleDto,
    @CurrentUser() user: any,
    @Query('agentId') agentId?: string,
    @Query('area') area?: AgentArea,
  ) {
    this.assertTenantAccess(tenantId, user);
    return this.aiTrainingService.createRule(tenantId, dto, user.id, { agentId, area });
  }

  @Patch('rules/:ruleId')
  async updateRule(
    @Param('tenantId') tenantId: string,
    @Param('ruleId') ruleId: string,
    @Body() dto: UpdateAiRuleDto,
    @CurrentUser() user: any,
  ) {
    this.assertTenantAccess(tenantId, user);
    return this.aiTrainingService.updateRule(tenantId, ruleId, dto, user.id);
  }

  @Delete('rules/:ruleId')
  async deleteRule(
    @Param('tenantId') tenantId: string,
    @Param('ruleId') ruleId: string,
    @CurrentUser() user: any,
  ) {
    this.assertTenantAccess(tenantId, user);
    return this.aiTrainingService.deleteRule(tenantId, ruleId, user.id);
  }

  // 3. Base de Conocimiento (FAQs)
  @Get('knowledge')
  async getKnowledge(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: any,
    @Query('agentId') agentId?: string,
    @Query('area') area?: AgentArea,
  ) {
    this.assertTenantAccess(tenantId, user);
    return this.aiTrainingService.getKnowledgeItems(tenantId, { agentId, area });
  }

  @Post('knowledge')
  async createKnowledge(
    @Param('tenantId') tenantId: string,
    @Body() dto: CreateAiKnowledgeDto,
    @CurrentUser() user: any,
    @Query('agentId') agentId?: string,
    @Query('area') area?: AgentArea,
  ) {
    this.assertTenantAccess(tenantId, user);
    return this.aiTrainingService.createKnowledgeItem(tenantId, dto, user.id, { agentId, area });
  }

  @Patch('knowledge/:itemId')
  async updateKnowledge(
    @Param('tenantId') tenantId: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateAiKnowledgeDto,
    @CurrentUser() user: any,
  ) {
    this.assertTenantAccess(tenantId, user);
    return this.aiTrainingService.updateKnowledgeItem(tenantId, itemId, dto, user.id);
  }

  @Delete('knowledge/:itemId')
  async deleteKnowledge(
    @Param('tenantId') tenantId: string,
    @Param('itemId') itemId: string,
    @CurrentUser() user: any,
  ) {
    this.assertTenantAccess(tenantId, user);
    return this.aiTrainingService.deleteKnowledgeItem(tenantId, itemId, user.id);
  }

  // 4. Ejemplos de Entrenamiento (Few-Shot)
  @Get('examples')
  async getExamples(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: any,
    @Query('agentId') agentId?: string,
    @Query('area') area?: AgentArea,
  ) {
    this.assertTenantAccess(tenantId, user);
    return this.aiTrainingService.getExamples(tenantId, { agentId, area });
  }

  @Post('examples')
  async createExample(
    @Param('tenantId') tenantId: string,
    @Body() dto: CreateAiExampleDto,
    @CurrentUser() user: any,
    @Query('agentId') agentId?: string,
    @Query('area') area?: AgentArea,
  ) {
    this.assertTenantAccess(tenantId, user);
    return this.aiTrainingService.createExample(tenantId, dto, user.id, { agentId, area });
  }

  @Delete('examples/:exampleId')
  async deleteExample(
    @Param('tenantId') tenantId: string,
    @Param('exampleId') exampleId: string,
    @CurrentUser() user: any,
  ) {
    this.assertTenantAccess(tenantId, user);
    return this.aiTrainingService.deleteExample(tenantId, exampleId, user.id);
  }

  // 5. Playground / Simulador en Vivo
  @Post('simulate')
  async simulate(
    @Param('tenantId') tenantId: string,
    @Body() dto: SimulateAiDto,
    @CurrentUser() user: any,
    @Query('agentId') agentId?: string,
    @Query('area') area?: AgentArea,
  ) {
    this.assertTenantAccess(tenantId, user);
    return this.aiTrainingService.simulate(tenantId, dto.message, { agentId, area });
  }
}

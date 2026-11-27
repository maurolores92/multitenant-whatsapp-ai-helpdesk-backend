import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { AgentArea, WhatsAppStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { UpdateWhatsAppConfigDto } from '../tenants/dto/update-whatsapp-config.dto';
import { CreateAgentDto, UpdateAgentDto } from './dto/agent.dto';
import { ensureDefaultTechnicalAgent } from './agents.helper';

@Injectable()
export class AgentsService {
  private readonly logger = new Logger(AgentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async listAgents(tenantId: string) {
    await ensureDefaultTechnicalAgent(this.prisma, tenantId);

    const agents = await this.prisma.whatsAppAgent.findMany({
      where: { tenantId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      include: {
        _count: {
          select: {
            conversations: true,
            tickets: true,
            aiRules: true,
            aiKnowledgeItems: true,
            aiTrainingExamples: true,
          },
        },
      },
    });

    return agents.map((agent) => ({
      ...agent,
      whatsappAccessToken: agent.whatsappAccessToken ? '••••••••' : null,
      hasWhatsAppToken: Boolean(agent.whatsappAccessToken),
      geminiApiKey: agent.geminiApiKey ? '••••••••' : null,
      hasCustomGeminiKey: Boolean(agent.geminiApiKey),
    }));
  }

  async createAgent(tenantId: string, dto: CreateAgentDto, actorUserId?: string) {
    const rawCode =
      dto.code?.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-') ||
      dto.name.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');

    const code = rawCode || `agent-${Date.now()}`;

    const existing = await this.prisma.whatsAppAgent.findUnique({
      where: { tenantId_code: { tenantId, code } },
    });
    if (existing) {
      throw new ConflictException(`Ya existe un agente con el código '${code}'`);
    }

    if (dto.whatsappPhoneNumberId?.trim()) {
      const takenPhone = await this.prisma.whatsAppAgent.findUnique({
        where: { whatsappPhoneNumberId: dto.whatsappPhoneNumberId.trim() },
      });
      if (takenPhone) {
        throw new ConflictException('Ese WhatsApp Phone Number ID ya está asignado a otro agente');
      }
    }

    const isConnected = Boolean(
      dto.whatsappPhoneNumberId?.trim() && dto.whatsappAccessToken?.trim(),
    );

    const agent = await this.prisma.whatsAppAgent.create({
      data: {
        tenantId,
        code,
        name: dto.name.trim(),
        area: dto.area ?? AgentArea.GENERAL,
        isActive: true,
        isDefault: false,
        whatsappPhone: dto.whatsappPhone?.trim() || null,
        whatsappPhoneNumberId: dto.whatsappPhoneNumberId?.trim() || null,
        whatsappWabaId: dto.whatsappWabaId?.trim() || null,
        whatsappAccessToken: dto.whatsappAccessToken?.trim() || null,
        whatsappStatus: isConnected ? WhatsAppStatus.CONNECTED : WhatsAppStatus.DISCONNECTED,
        aiEnabled: dto.aiEnabled ?? true,
        aiSystemPrompt: dto.aiSystemPrompt?.trim() || null,
      },
      include: {
        _count: {
          select: {
            conversations: true,
            tickets: true,
            aiRules: true,
            aiKnowledgeItems: true,
            aiTrainingExamples: true,
          },
        },
      },
    });

    await this.auditService.log({
      tenantId,
      userId: actorUserId,
      action: 'WHATSAPP_AGENT_CREATED',
      entity: 'WhatsAppAgent',
      entityId: agent.id,
      payload: { name: agent.name, code: agent.code, area: agent.area },
    });

    this.logger.log(`✔ Agente WhatsApp creado: ${agent.name} (${agent.area})`);

    return {
      ...agent,
      whatsappAccessToken: agent.whatsappAccessToken ? '••••••••' : null,
      hasWhatsAppToken: Boolean(agent.whatsappAccessToken),
      geminiApiKey: null,
      hasCustomGeminiKey: false,
    };
  }

  async updateAgent(tenantId: string, agentId: string, dto: UpdateAgentDto, actorUserId?: string) {
    const existing = await this.prisma.whatsAppAgent.findFirst({
      where: { id: agentId, tenantId },
    });
    if (!existing) {
      throw new NotFoundException('Agente no encontrado');
    }

    if (existing.isDefault && dto.isActive === false) {
      throw new ForbiddenException('El agente principal de Servicio Técnico no puede desactivarse');
    }

    const updated = await this.prisma.whatsAppAgent.update({
      where: { id: agentId },
      data: {
        ...(dto.name?.trim() ? { name: dto.name.trim() } : {}),
        ...(dto.area ? { area: dto.area } : {}),
        ...(typeof dto.isActive === 'boolean' ? { isActive: dto.isActive } : {}),
      },
    });

    await this.auditService.log({
      tenantId,
      userId: actorUserId,
      action: 'WHATSAPP_AGENT_UPDATED',
      entity: 'WhatsAppAgent',
      entityId: updated.id,
      payload: { name: updated.name, area: updated.area, isActive: updated.isActive },
    });

    return updated;
  }

  async updateWhatsAppConfig(
    tenantId: string,
    agentId: string,
    dto: UpdateWhatsAppConfigDto,
    actorUserId?: string,
  ) {
    const agent = await this.prisma.whatsAppAgent.findFirst({
      where: { id: agentId, tenantId },
    });
    if (!agent) {
      throw new NotFoundException('Agente no encontrado');
    }

    const phoneNumberId = dto.whatsappPhoneNumberId?.trim() || null;
    if (phoneNumberId) {
      const taken = await this.prisma.whatsAppAgent.findFirst({
        where: {
          whatsappPhoneNumberId: phoneNumberId,
          id: { not: agentId },
        },
      });
      if (taken) {
        throw new ConflictException(`El Phone Number ID ya está asignado al agente '${taken.name}'`);
      }
    }

    // Mantener token anterior si no se reenvió o si vino enmascarado
    const incomingToken = dto.whatsappAccessToken?.trim();
    const nextToken =
      incomingToken && incomingToken !== '••••••••'
        ? incomingToken
        : incomingToken === ''
          ? null
          : agent.whatsappAccessToken;

    const isConnected = Boolean(phoneNumberId && nextToken);

    const updated = await this.prisma.whatsAppAgent.update({
      where: { id: agentId },
      data: {
        whatsappPhoneNumberId: phoneNumberId,
        whatsappWabaId: dto.whatsappWabaId?.trim() || null,
        whatsappAccessToken: nextToken,
        whatsappPhone: dto.whatsappPhone?.trim() || null,
        whatsappStatus: isConnected ? WhatsAppStatus.CONNECTED : WhatsAppStatus.DISCONNECTED,
      },
    });

    // Compatibilidad hacia atrás si es el agente por defecto
    if (updated.isDefault) {
      await this.prisma.tenant.update({
        where: { id: tenantId },
        data: {
          whatsappPhoneNumberId: updated.whatsappPhoneNumberId,
          whatsappWabaId: updated.whatsappWabaId,
          whatsappAccessToken: updated.whatsappAccessToken,
          whatsappPhone: updated.whatsappPhone,
          whatsappStatus: updated.whatsappStatus,
        },
      });
    }

    await this.auditService.log({
      tenantId,
      userId: actorUserId,
      action: 'AGENT_WHATSAPP_CONFIG_UPDATED',
      entity: 'WhatsAppAgent',
      entityId: updated.id,
      payload: {
        agentName: updated.name,
        whatsappPhone: updated.whatsappPhone,
        whatsappPhoneNumberId: updated.whatsappPhoneNumberId,
        status: updated.whatsappStatus,
      },
    });

    return {
      ...updated,
      whatsappAccessToken: updated.whatsappAccessToken ? '••••••••' : null,
      hasWhatsAppToken: Boolean(updated.whatsappAccessToken),
    };
  }

  async deleteAgent(tenantId: string, agentId: string, actorUserId?: string) {
    const existing = await this.prisma.whatsAppAgent.findFirst({
      where: { id: agentId, tenantId },
    });
    if (!existing) {
      throw new NotFoundException('Agente no encontrado');
    }

    if (existing.isDefault || existing.area === AgentArea.TECHNICAL_SERVICE) {
      throw new ForbiddenException(
        'El agente principal de Servicio Técnico está protegido y no puede eliminarse.',
      );
    }

    await this.prisma.whatsAppAgent.delete({ where: { id: agentId } });

    await this.auditService.log({
      tenantId,
      userId: actorUserId,
      action: 'WHATSAPP_AGENT_DELETED',
      entity: 'WhatsAppAgent',
      entityId: agentId,
      payload: { name: existing.name, area: existing.area },
    });

    return { success: true, id: agentId };
  }
}

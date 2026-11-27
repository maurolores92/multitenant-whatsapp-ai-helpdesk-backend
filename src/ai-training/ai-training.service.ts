import {
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { UpdateAiConfigDto } from './dto/update-ai-config.dto';
import { CreateAiRuleDto, UpdateAiRuleDto } from './dto/ai-rule.dto';
import { CreateAiKnowledgeDto, UpdateAiKnowledgeDto } from './dto/ai-knowledge.dto';
import { CreateAiExampleDto, SimulateMessageItemDto } from './dto/ai-example.dto';
import { AgentArea, SenderType } from '@prisma/client';
import {
  buildCustomerConversationContext,
  buildTenantAiSystemInstructions,
  generateGeminiWithEquipmentTools,
  parseEscalationOutput,
  resolveGeminiModel,
  TICKET_ESCALATION_PROTOCOL,
} from '../ai/ai-prompt.helper';
import { resolveTenantAgent } from '../agents/agents.helper';

export interface AgentScopeOptions {
  agentId?: string;
  area?: AgentArea;
}

@Injectable()
export class AiTrainingService {
  private readonly logger = new Logger(AiTrainingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Obtiene la configuración de IA de un agente (o del agente principal de la compañía)
   */
  async getAiConfig(tenantId: string, scope?: AgentScopeOptions) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, geminiApiKey: true, geminiModel: true, aiTemperature: true, aiSystemPrompt: true, aiEnabled: true },
    });

    if (!tenant) {
      throw new NotFoundException('Compañía no encontrada');
    }

    const agent = await resolveTenantAgent(this.prisma, tenantId, scope);
    if (!agent) {
      throw new NotFoundException('Agente de WhatsApp no encontrado');
    }

    const [rulesCount, kbCount, examplesCount] = await Promise.all([
      this.prisma.aiRule.count({ where: { tenantId, agentId: agent.id } }),
      this.prisma.aiKnowledgeItem.count({ where: { tenantId, agentId: agent.id } }),
      this.prisma.aiTrainingExample.count({ where: { tenantId, agentId: agent.id } }),
    ]);

    const effectiveKey = agent.geminiApiKey ?? tenant.geminiApiKey;
    const hasCustomApiKey = Boolean(effectiveKey?.trim());
    let maskedApiKey: string | null = null;
    if (hasCustomApiKey && effectiveKey) {
      const key = effectiveKey.trim();
      maskedApiKey = key.length > 8 ? `${key.substring(0, 4)}...${key.substring(key.length - 4)}` : '••••••••';
    }

    return {
      tenantId: tenant.id,
      tenantName: tenant.name,
      agentId: agent.id,
      agentName: agent.name,
      agentArea: agent.area,
      geminiModel: resolveGeminiModel(
        agent.geminiModel || tenant.geminiModel,
        this.configService.get<string>('GEMINI_MODEL'),
      ),
      aiTemperature: agent.aiTemperature ?? tenant.aiTemperature,
      aiSystemPrompt: agent.aiSystemPrompt ?? tenant.aiSystemPrompt,
      aiEnabled: agent.aiEnabled,
      aiContextHours: agent.aiContextHours ?? 24,
      hasCustomApiKey,
      maskedApiKey,
      counts: {
        aiRules: rulesCount,
        aiKnowledgeItems: kbCount,
        aiTrainingExamples: examplesCount,
      },
    };
  }

  /**
   * Actualiza la configuración de IA y API Key de Gemini de un agente
   */
  async updateAiConfig(
    tenantId: string,
    dto: UpdateAiConfigDto,
    currentUserId?: string,
    scope?: AgentScopeOptions,
  ) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundException('Compañía no encontrada');
    }

    const agent = await resolveTenantAgent(this.prisma, tenantId, scope);
    if (!agent) {
      throw new NotFoundException('Agente de WhatsApp no encontrado');
    }

    const updateData: any = {};
    if (dto.geminiApiKey !== undefined) {
      updateData.geminiApiKey = dto.geminiApiKey?.trim() || null;
    }
    if (dto.geminiModel !== undefined) {
      updateData.geminiModel = dto.geminiModel.trim();
    }
    if (dto.aiTemperature !== undefined) {
      updateData.aiTemperature = dto.aiTemperature;
    }
    if (dto.aiSystemPrompt !== undefined) {
      updateData.aiSystemPrompt = dto.aiSystemPrompt.trim() || null;
    }
    if (dto.aiEnabled !== undefined) {
      updateData.aiEnabled = dto.aiEnabled;
    }
    if (dto.aiContextHours !== undefined) {
      updateData.aiContextHours = dto.aiContextHours;
    }

    const updated = await this.prisma.whatsAppAgent.update({
      where: { id: agent.id },
      data: updateData,
    });

    if (updated.isDefault) {
      const { aiContextHours: _ignoredTenantField, ...tenantMirrorData } = updateData;
      if (Object.keys(tenantMirrorData).length > 0) {
        await this.prisma.tenant.update({
          where: { id: tenantId },
          data: tenantMirrorData,
        });
      }
    }

    await this.auditService.log({
      tenantId,
      userId: currentUserId,
      action: 'AGENT_AI_CONFIG_UPDATED',
      entity: 'WhatsAppAgent',
      entityId: updated.id,
      payload: {
        agentName: updated.name,
        updatedFields: Object.keys(updateData),
        hasCustomApiKey: Boolean(updated.geminiApiKey),
        model: updated.geminiModel,
        aiTemperature: updated.aiTemperature,
      },
    });

    this.logger.log(`✔ Configuración de IA actualizada para agente '${updated.name}'`);

    return this.getAiConfig(tenantId, { agentId: updated.id });
  }

  // ========================================================
  // REGLAS MODULARES DE LA IA (AI RULES)
  // ========================================================

  async getRules(tenantId: string, scope?: AgentScopeOptions) {
    const agent = await resolveTenantAgent(this.prisma, tenantId, scope);
    return this.prisma.aiRule.findMany({
      where: { tenantId, ...(agent ? { agentId: agent.id } : {}) },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    });
  }

  async createRule(
    tenantId: string,
    dto: CreateAiRuleDto,
    currentUserId?: string,
    scope?: AgentScopeOptions,
  ) {
    const agent = await resolveTenantAgent(this.prisma, tenantId, scope);
    const rule = await this.prisma.aiRule.create({
      data: {
        tenantId,
        agentId: agent?.id ?? null,
        title: dto.title.trim(),
        instruction: dto.instruction.trim(),
        category: dto.category,
        priority: dto.priority ?? 1,
        isActive: dto.isActive ?? true,
      },
    });

    await this.auditService.log({
      tenantId,
      userId: currentUserId,
      action: 'AI_RULE_CREATED',
      entity: 'AiRule',
      entityId: rule.id,
      payload: { title: rule.title, category: rule.category },
    });

    return rule;
  }

  async updateRule(tenantId: string, ruleId: string, dto: UpdateAiRuleDto, currentUserId?: string) {
    const existing = await this.prisma.aiRule.findFirst({
      where: { id: ruleId, tenantId },
    });
    if (!existing) {
      throw new NotFoundException('Regla de IA no encontrada');
    }

    const updated = await this.prisma.aiRule.update({
      where: { id: ruleId },
      data: {
        title: dto.title?.trim() ?? existing.title,
        instruction: dto.instruction?.trim() ?? existing.instruction,
        category: dto.category ?? existing.category,
        priority: dto.priority ?? existing.priority,
        isActive: dto.isActive ?? existing.isActive,
      },
    });

    await this.auditService.log({
      tenantId,
      userId: currentUserId,
      action: 'AI_RULE_UPDATED',
      entity: 'AiRule',
      entityId: ruleId,
      payload: { title: updated.title, isActive: updated.isActive },
    });

    return updated;
  }

  async deleteRule(tenantId: string, ruleId: string, currentUserId?: string) {
    const existing = await this.prisma.aiRule.findFirst({
      where: { id: ruleId, tenantId },
    });
    if (!existing) {
      throw new NotFoundException('Regla de IA no encontrada');
    }

    await this.prisma.aiRule.delete({ where: { id: ruleId } });

    await this.auditService.log({
      tenantId,
      userId: currentUserId,
      action: 'AI_RULE_DELETED',
      entity: 'AiRule',
      entityId: ruleId,
      payload: { title: existing.title },
    });

    return { success: true, id: ruleId };
  }

  // ========================================================
  // BASE DE CONOCIMIENTOS / FAQS (AI KNOWLEDGE)
  // ========================================================

  async getKnowledgeItems(tenantId: string, scope?: AgentScopeOptions) {
    const agent = await resolveTenantAgent(this.prisma, tenantId, scope);
    return this.prisma.aiKnowledgeItem.findMany({
      where: { tenantId, ...(agent ? { agentId: agent.id } : {}) },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createKnowledgeItem(
    tenantId: string,
    dto: CreateAiKnowledgeDto,
    currentUserId?: string,
    scope?: AgentScopeOptions,
  ) {
    const agent = await resolveTenantAgent(this.prisma, tenantId, scope);
    const item = await this.prisma.aiKnowledgeItem.create({
      data: {
        tenantId,
        agentId: agent?.id ?? null,
        question: dto.question.trim(),
        answer: dto.answer.trim(),
        tags: dto.tags || [],
        isActive: dto.isActive ?? true,
      },
    });

    await this.auditService.log({
      tenantId,
      userId: currentUserId,
      action: 'AI_KNOWLEDGE_CREATED',
      entity: 'AiKnowledgeItem',
      entityId: item.id,
      payload: { question: item.question },
    });

    return item;
  }

  async updateKnowledgeItem(tenantId: string, itemId: string, dto: UpdateAiKnowledgeDto, currentUserId?: string) {
    const existing = await this.prisma.aiKnowledgeItem.findFirst({
      where: { id: itemId, tenantId },
    });
    if (!existing) {
      throw new NotFoundException('Ítem de conocimiento no encontrado');
    }

    const updated = await this.prisma.aiKnowledgeItem.update({
      where: { id: itemId },
      data: {
        question: dto.question?.trim() ?? existing.question,
        answer: dto.answer?.trim() ?? existing.answer,
        tags: dto.tags ?? existing.tags,
        isActive: dto.isActive ?? existing.isActive,
      },
    });

    await this.auditService.log({
      tenantId,
      userId: currentUserId,
      action: 'AI_KNOWLEDGE_UPDATED',
      entity: 'AiKnowledgeItem',
      entityId: itemId,
      payload: { question: updated.question, isActive: updated.isActive },
    });

    return updated;
  }

  async deleteKnowledgeItem(tenantId: string, itemId: string, currentUserId?: string) {
    const existing = await this.prisma.aiKnowledgeItem.findFirst({
      where: { id: itemId, tenantId },
    });
    if (!existing) {
      throw new NotFoundException('Ítem de conocimiento no encontrado');
    }

    await this.prisma.aiKnowledgeItem.delete({ where: { id: itemId } });

    await this.auditService.log({
      tenantId,
      userId: currentUserId,
      action: 'AI_KNOWLEDGE_DELETED',
      entity: 'AiKnowledgeItem',
      entityId: itemId,
      payload: { question: existing.question },
    });

    return { success: true, id: itemId };
  }

  // ========================================================
  // EJEMPLOS DE ENTRENAMIENTO (FEW-SHOT LEARNING)
  // ========================================================

  async getExamples(tenantId: string, scope?: AgentScopeOptions) {
    const agent = await resolveTenantAgent(this.prisma, tenantId, scope);
    return this.prisma.aiTrainingExample.findMany({
      where: { tenantId, ...(agent ? { agentId: agent.id } : {}) },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createExample(
    tenantId: string,
    dto: CreateAiExampleDto,
    currentUserId?: string,
    scope?: AgentScopeOptions,
  ) {
    const agent = await resolveTenantAgent(this.prisma, tenantId, scope);
    const example = await this.prisma.aiTrainingExample.create({
      data: {
        tenantId,
        agentId: agent?.id ?? null,
        customerInput: dto.customerInput.trim(),
        idealResponse: dto.idealResponse.trim(),
        topic: dto.topic?.trim() || null,
        isApproved: dto.isApproved ?? true,
      },
    });

    await this.auditService.log({
      tenantId,
      userId: currentUserId,
      action: 'AI_EXAMPLE_CREATED',
      entity: 'AiTrainingExample',
      entityId: example.id,
      payload: { topic: example.topic },
    });

    return example;
  }

  async deleteExample(tenantId: string, exampleId: string, currentUserId?: string) {
    const existing = await this.prisma.aiTrainingExample.findFirst({
      where: { id: exampleId, tenantId },
    });
    if (!existing) {
      throw new NotFoundException('Ejemplo de entrenamiento no encontrado');
    }

    await this.prisma.aiTrainingExample.delete({ where: { id: exampleId } });

    await this.auditService.log({
      tenantId,
      userId: currentUserId,
      action: 'AI_EXAMPLE_DELETED',
      entity: 'AiTrainingExample',
      entityId: exampleId,
    });

    return { success: true, id: exampleId };
  }

  // ========================================================
  // PLAYGROUND / SIMULADOR EN VIVO
  // ========================================================

  /**
   * Ejecuta una simulación con el motor de Google Gemini inyectando las reglas activas del agente.
   * Para Servicio Técnico soporta historial multi-turno limitado a la ventana configurada (24 h).
   */
  async simulate(
    tenantId: string,
    message: string,
    scope?: AgentScopeOptions,
    history: SimulateMessageItemDto[] = [],
  ) {
    const startTime = Date.now();

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      include: {
        problemTypes: {
          where: { isActive: true },
          orderBy: { name: 'asc' },
        },
      },
    });

    if (!tenant) {
      throw new NotFoundException('Compañía no encontrada');
    }

    const resolvedAgent = await resolveTenantAgent(this.prisma, tenantId, scope);
    const agent = resolvedAgent
      ? await this.prisma.whatsAppAgent.findUnique({
          where: { id: resolvedAgent.id },
          include: {
            aiRules: {
              where: { isActive: true },
              orderBy: { priority: 'asc' },
            },
            aiKnowledgeItems: {
              where: { isActive: true },
            },
            aiTrainingExamples: {
              where: { isApproved: true },
              take: 5,
            },
          },
        })
      : null;

    const effectiveContext = {
      name: tenant.name,
      aiSystemPrompt: agent?.aiSystemPrompt ?? tenant.aiSystemPrompt,
      aiRules: agent?.aiRules ?? [],
      aiKnowledgeItems: agent?.aiKnowledgeItems ?? [],
      aiTrainingExamples: agent?.aiTrainingExamples ?? [],
      problemTypes: tenant.problemTypes,
    };

    const isTechnicalService = agent?.area === AgentArea.TECHNICAL_SERVICE;
    const contextHours = agent?.aiContextHours ?? 24;
    const cutoffMs = Date.now() - contextHours * 60 * 60 * 1000;

    const recentMessages = isTechnicalService
      ? history
          .filter((item) => {
            if (!item.timestamp) return true;
            const parsedTime = Date.parse(item.timestamp);
            return Number.isNaN(parsedTime) || parsedTime >= cutoffMs;
          })
          .slice(-20)
          .map((item) => ({
            senderType: item.sender === 'user' ? SenderType.CUSTOMER : SenderType.BOT,
            content: item.text,
          }))
      : [];

    // Determinar API Key de Gemini: prioriza la del agente/tenant, con fallback a la del sistema
    const apiKey =
      agent?.geminiApiKey?.trim() ||
      tenant.geminiApiKey?.trim() ||
      this.configService.get<string>('GEMINI_API_KEY');
    let model = resolveGeminiModel(
      agent?.geminiModel || tenant.geminiModel,
      this.configService.get<string>('GEMINI_MODEL'),
    );
    const temperature = agent?.aiTemperature ?? tenant.aiTemperature ?? 0.2;
    const aiEnabled = agent?.aiEnabled ?? tenant.aiEnabled;
    const systemInstructions = `${buildTenantAiSystemInstructions(effectiveContext)}\n\n${TICKET_ESCALATION_PROTOCOL}`;

    let responseText = '';
    let isLiveAi = false;
    let matchedEquipmentSummary: { id: string; name: string; code: string | null; customerName: string | null } | null =
      null;

    if (apiKey && apiKey !== 'your-gemini-api-key') {
      try {
        const client = new GoogleGenAI({ apiKey });
        const userContext = buildCustomerConversationContext({
          customerName: 'Cliente Simulador',
          equipments: [],
          recentMessages,
          latestMessage: message,
        });
        const { text: rawText, modelUsed, matchedEquipmentId } = await generateGeminiWithEquipmentTools({
          client,
          prisma: this.prisma,
          tenantId: tenant.id,
          preferredModel: model,
          systemInstruction: systemInstructions,
          userContext,
          temperature,
        });
        model = modelUsed;
        if (matchedEquipmentId) {
          const eq = await this.prisma.equipment.findUnique({
            where: { id: matchedEquipmentId },
            include: { customer: { select: { name: true, companyName: true } } },
          });
          if (eq) {
            const specs = (eq.specifications && typeof eq.specifications === 'object'
              ? eq.specifications
              : {}) as Record<string, any>;
            matchedEquipmentSummary = {
              id: eq.id,
              name: eq.name,
              code: specs.internalCode ? String(specs.internalCode) : eq.externalCode,
              customerName: eq.customer?.companyName || eq.customer?.name || null,
            };
          }
        }
        const parsed = parseEscalationOutput(rawText);
        responseText = parsed.escalationPayload
          ? `${parsed.replyText}\n\n[Simulación de Ticket IA]: ${JSON.stringify(parsed.escalationPayload)}`
          : parsed.replyText || 'No se recibió respuesta del modelo';
        isLiveAi = true;
      } catch (err: any) {
        this.logger.error(`Error en simulación Gemini: ${err.message}`);
        responseText = `[Modo Simulación Fallback]: Error API Gemini (${err.message}).`;
      }
    } else {
      responseText = `[Modo Simulación Sin API Key]: ${agent?.name || tenant.name} tiene ${effectiveContext.aiRules.length} reglas, ${effectiveContext.aiKnowledgeItems.length} conocimientos y ${tenant.problemTypes.length} problemas ERP activos. Configura GEMINI_API_KEY para probar la respuesta en vivo.`;
    }

    const executionTimeMs = Date.now() - startTime;

    return {
      response: responseText,
      modelUsed: model,
      aiEnabled,
      isLiveAi,
      contextHours: isTechnicalService ? contextHours : null,
      historyMessagesUsed: recentMessages.length,
      matchedEquipment: matchedEquipmentSummary,
      rulesCount: effectiveContext.aiRules.length,
      knowledgeCount: effectiveContext.aiKnowledgeItems.length,
      examplesCount: effectiveContext.aiTrainingExamples.length,
      problemsCount: tenant.problemTypes.length,
      executionTimeMs,
    };
  }
}

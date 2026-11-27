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
import { CreateAiExampleDto } from './dto/ai-example.dto';
import {
  buildTenantAiSystemInstructions,
  parseEscalationOutput,
  resolveGeminiModel,
  TICKET_ESCALATION_PROTOCOL,
} from '../ai/ai-prompt.helper';

@Injectable()
export class AiTrainingService {
  private readonly logger = new Logger(AiTrainingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Obtiene la configuración de IA de una compañía (sin exponer el API Key completo)
   */
  async getAiConfig(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        geminiApiKey: true,
        geminiModel: true,
        aiTemperature: true,
        aiSystemPrompt: true,
        aiEnabled: true,
        _count: {
          select: {
            aiRules: true,
            aiKnowledgeItems: true,
            aiTrainingExamples: true,
          },
        },
      },
    });

    if (!tenant) {
      throw new NotFoundException('Compañía no encontrada');
    }

    const hasCustomApiKey = Boolean(tenant.geminiApiKey?.trim());
    let maskedApiKey: string | null = null;
    if (hasCustomApiKey && tenant.geminiApiKey) {
      const key = tenant.geminiApiKey.trim();
      maskedApiKey = key.length > 8 ? `${key.substring(0, 4)}...${key.substring(key.length - 4)}` : '••••••••';
    }

    return {
      tenantId: tenant.id,
      tenantName: tenant.name,
      geminiModel: resolveGeminiModel(
        tenant.geminiModel,
        this.configService.get<string>('GEMINI_MODEL'),
      ),
      aiTemperature: tenant.aiTemperature,
      aiSystemPrompt: tenant.aiSystemPrompt,
      aiEnabled: tenant.aiEnabled,
      hasCustomApiKey,
      maskedApiKey,
      counts: tenant._count,
    };
  }

  /**
   * Actualiza la configuración de IA y API Key de Gemini de una compañía (Exclusivo Superadmin)
   */
  async updateAiConfig(tenantId: string, dto: UpdateAiConfigDto, currentUserId?: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundException('Compañía no encontrada');
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

    const updated = await this.prisma.tenant.update({
      where: { id: tenantId },
      data: updateData,
    });

    await this.auditService.log({
      tenantId,
      userId: currentUserId,
      action: 'TENANT_AI_CONFIG_UPDATED',
      entity: 'Tenant',
      entityId: tenantId,
      payload: {
        updatedFields: Object.keys(updateData),
        hasCustomApiKey: Boolean(updated.geminiApiKey),
        model: updated.geminiModel,
        aiTemperature: updated.aiTemperature,
      },
    });

    this.logger.log(`✔ Configuración de IA actualizada para tenant '${tenant.name}'`);

    return this.getAiConfig(tenantId);
  }

  // ========================================================
  // REGLAS MODULARES DE LA IA (AI RULES)
  // ========================================================

  async getRules(tenantId: string) {
    return this.prisma.aiRule.findMany({
      where: { tenantId },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    });
  }

  async createRule(tenantId: string, dto: CreateAiRuleDto, currentUserId?: string) {
    const rule = await this.prisma.aiRule.create({
      data: {
        tenantId,
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

  async getKnowledgeItems(tenantId: string) {
    return this.prisma.aiKnowledgeItem.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createKnowledgeItem(tenantId: string, dto: CreateAiKnowledgeDto, currentUserId?: string) {
    const item = await this.prisma.aiKnowledgeItem.create({
      data: {
        tenantId,
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

  async getExamples(tenantId: string) {
    return this.prisma.aiTrainingExample.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createExample(tenantId: string, dto: CreateAiExampleDto, currentUserId?: string) {
    const example = await this.prisma.aiTrainingExample.create({
      data: {
        tenantId,
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
   * Ejecuta una simulación con el motor de Google Gemini inyectando las reglas activas de la empresa
   */
  async simulate(tenantId: string, message: string) {
    const startTime = Date.now();

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
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
        problemTypes: {
          where: { isActive: true },
          orderBy: { name: 'asc' },
        },
      },
    });

    if (!tenant) {
      throw new NotFoundException('Compañía no encontrada');
    }

    // Determinar API Key de Gemini: prioriza la del tenant, con fallback a la del sistema
    const apiKey = tenant.geminiApiKey?.trim() || this.configService.get<string>('GEMINI_API_KEY');
    const model = resolveGeminiModel(
      tenant.geminiModel,
      this.configService.get<string>('GEMINI_MODEL'),
    );
    const systemInstructions = `${buildTenantAiSystemInstructions(tenant)}\n\n${TICKET_ESCALATION_PROTOCOL}`;

    let responseText = '';
    let isLiveAi = false;

    if (apiKey && apiKey !== 'your-gemini-api-key') {
      try {
        const client = new GoogleGenAI({ apiKey });
        const res = await client.models.generateContent({
          model,
          contents: `Mensaje recibido del cliente en el simulador:\n"${message}"`,
          config: {
            systemInstruction: systemInstructions,
            temperature: tenant.aiTemperature ?? 0.2,
          },
        });
        const parsed = parseEscalationOutput(res.text || '');
        responseText = parsed.escalationPayload
          ? `${parsed.replyText}\n\n[Simulación de Ticket IA]: ${JSON.stringify(parsed.escalationPayload)}`
          : parsed.replyText || 'No se recibió respuesta del modelo';
        isLiveAi = true;
      } catch (err: any) {
        this.logger.error(`Error en simulación Gemini: ${err.message}`);
        responseText = `[Modo Simulación Fallback]: Error API Gemini (${err.message}).`;
      }
    } else {
      responseText = `[Modo Simulación Sin API Key]: ${tenant.name} tiene ${tenant.aiRules.length} reglas, ${tenant.aiKnowledgeItems.length} conocimientos y ${tenant.problemTypes.length} problemas ERP activos. Configura GEMINI_API_KEY para probar la respuesta en vivo.`;
    }

    const executionTimeMs = Date.now() - startTime;

    return {
      response: responseText,
      modelUsed: model,
      aiEnabled: tenant.aiEnabled,
      isLiveAi,
      rulesCount: tenant.aiRules.length,
      knowledgeCount: tenant.aiKnowledgeItems.length,
      examplesCount: tenant.aiTrainingExamples.length,
      problemsCount: tenant.problemTypes.length,
      executionTimeMs,
    };
  }
}

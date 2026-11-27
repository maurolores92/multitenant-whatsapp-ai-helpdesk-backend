import { AgentArea } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_GEMINI_MODEL, resolveGeminiModel } from '../ai/ai-prompt.helper';

export const DEFAULT_TECHNICAL_AGENT_CODE = 'technical-service';

/**
 * Garantiza que exista el agente principal de Servicio Técnico para la empresa,
 * migrando cualquier configuración previa desde Tenant y vinculando registros huérfanos.
 */
export async function ensureDefaultTechnicalAgent(prisma: PrismaService, tenantId: string) {
  let agent = await prisma.whatsAppAgent.findFirst({
    where: {
      tenantId,
      OR: [
        { code: DEFAULT_TECHNICAL_AGENT_CODE },
        { area: AgentArea.TECHNICAL_SERVICE, isDefault: true },
        { isDefault: true },
      ],
    },
    orderBy: { createdAt: 'asc' },
  });

  if (!agent) {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant) {
      return null;
    }

    // Evitar conflicto de unique si otro agente ya tomó el phoneNumberId
    let candidatePhoneNumberId = tenant.whatsappPhoneNumberId || null;
    if (candidatePhoneNumberId) {
      const taken = await prisma.whatsAppAgent.findUnique({
        where: { whatsappPhoneNumberId: candidatePhoneNumberId },
        select: { id: true },
      });
      if (taken) {
        candidatePhoneNumberId = null;
      }
    }

    agent = await prisma.whatsAppAgent.create({
      data: {
        tenantId,
        code: DEFAULT_TECHNICAL_AGENT_CODE,
        name: 'Agente Servicio Técnico',
        area: AgentArea.TECHNICAL_SERVICE,
        isActive: true,
        isDefault: true,
        whatsappPhoneNumberId: candidatePhoneNumberId,
        whatsappWabaId: tenant.whatsappWabaId,
        whatsappAccessToken: tenant.whatsappAccessToken,
        whatsappPhone: tenant.whatsappPhone,
        whatsappStatus: tenant.whatsappStatus,
        geminiApiKey: tenant.geminiApiKey,
        geminiModel: resolveGeminiModel(tenant.geminiModel, DEFAULT_GEMINI_MODEL),
        aiTemperature: tenant.aiTemperature ?? 0.2,
        aiSystemPrompt: tenant.aiSystemPrompt,
        aiEnabled: tenant.aiEnabled ?? true,
      },
    });
  }

  // Vincular registros históricos sin agentId al agente principal de Servicio Técnico
  await Promise.all([
    prisma.aiRule.updateMany({
      where: { tenantId, agentId: null },
      data: { agentId: agent.id },
    }),
    prisma.aiKnowledgeItem.updateMany({
      where: { tenantId, agentId: null },
      data: { agentId: agent.id },
    }),
    prisma.aiTrainingExample.updateMany({
      where: { tenantId, agentId: null },
      data: { agentId: agent.id },
    }),
    prisma.conversation.updateMany({
      where: { tenantId, agentId: null },
      data: { agentId: agent.id },
    }),
    prisma.ticket.updateMany({
      where: { tenantId, agentId: null },
      data: { agentId: agent.id },
    }),
  ]);

  return agent;
}

/**
 * Resuelve el agente objetivo: el agentId indicado (validado contra tenantId),
 * o por área, o el agente principal por defecto de Servicio Técnico.
 */
export async function resolveTenantAgent(
  prisma: PrismaService,
  tenantId: string,
  options?: { agentId?: string; area?: AgentArea },
) {
  if (options?.agentId) {
    const direct = await prisma.whatsAppAgent.findFirst({
      where: { id: options.agentId, tenantId },
    });
    if (direct) return direct;
  }

  if (options?.area) {
    const byArea = await prisma.whatsAppAgent.findFirst({
      where: { tenantId, area: options.area },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    if (byArea) return byArea;
  }

  return ensureDefaultTechnicalAgent(prisma, tenantId);
}

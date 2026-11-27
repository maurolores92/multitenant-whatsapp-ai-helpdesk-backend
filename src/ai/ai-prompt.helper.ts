import {
  AiKnowledgeItem,
  AiRule,
  AiRuleCategory,
  AiTrainingExample,
  Equipment,
  Message,
  ProblemType,
  SenderType,
} from '@prisma/client';

const RULE_CATEGORY_LABEL: Record<AiRuleCategory, string> = {
  TONE: 'Tono y Estilo',
  RESTRICTION: 'Restricción / Límite',
  BUSINESS: 'Regla de Negocio',
  ESCALATION: 'Criterio de Derivación',
};

export interface TenantAiPromptContext {
  name: string;
  aiSystemPrompt?: string | null;
  aiRules: Pick<AiRule, 'category' | 'title' | 'instruction'>[];
  aiKnowledgeItems: Pick<AiKnowledgeItem, 'question' | 'answer'>[];
  aiTrainingExamples: Pick<AiTrainingExample, 'customerInput' | 'idealResponse'>[];
  problemTypes?: Pick<ProblemType, 'id' | 'name' | 'description' | 'defaultReason' | 'defaultServiceType'>[];
}

export const TICKET_ESCALATION_PROTOCOL = `
PROTOCOLO TÉCNICO INTERNO DE DERIVACIÓN (NO MOSTRAR AL CLIENTE):
- Evalúa la consulta usando exclusivamente la DIRECTIVA BASE, las REGLAS DE OBLIGATORIO CUMPLIMIENTO (en especial las de Criterio de Derivación), la BASE DE CONOCIMIENTOS y el CATÁLOGO DE PROBLEMAS configurados para la empresa.
- Si puedes resolver o responder la consulta sin crear un ticket según esas reglas, responde normalmente al cliente SIN agregar el JSON de escalación.
- Únicamente si corresponde derivar y crear un ticket, agrega al final de tu respuesta una única línea exacta sin bloques de código Markdown:
ESCALATION_JSON:{"shouldEscalate":true,"reason":"Resumen corto del motivo","ticketReason":"MECHANICAL_FAILURE"|"ELECTRICAL_ERROR"|"TONER_SUPPLIES"|"CALIBRATION_SOFTWARE"|"PREVENTIVE_MAINTENANCE"|"ADMINISTRATIVE"|"OTHER","problemTypeId":"ID del catálogo ERP o null","serviceType":"REMOTE_WHATSAPP"|"ONSITE_PHYSICAL","priority":"LOW"|"MEDIUM"|"HIGH"|"CRITICAL","diagnosticSummary":"Diagnóstico técnico detallado para el operador","equipmentId":"ID del equipo afectado o null"}
`.trim();

/**
 * Construye las instrucciones oficiales de la compañía configuradas por el SuperAdmin.
 * Se comparte entre WhatsApp en vivo y el Simulador para garantizar paridad 1:1.
 */
export function buildTenantAiSystemInstructions(tenant: TenantAiPromptContext): string {
  const sections: string[] = [];

  sections.push(
    tenant.aiSystemPrompt?.trim()
      ? `DIRECTIVA BASE DE "${tenant.name}":\n${tenant.aiSystemPrompt.trim()}`
      : `Eres el asistente virtual oficial de atención por WhatsApp de la empresa "${tenant.name}". Responde en español de forma clara y cordial según la información y reglas de la empresa.`,
  );

  if (tenant.aiRules.length > 0) {
    const lines = tenant.aiRules.map(
      (rule, idx) =>
        `${idx + 1}. [${RULE_CATEGORY_LABEL[rule.category] || rule.category}] ${rule.title}: ${rule.instruction}`,
    );
    sections.push(`REGLAS DE OBLIGATORIO CUMPLIMIENTO:\n${lines.join('\n')}`);
  }

  if (tenant.aiKnowledgeItems.length > 0) {
    const kbLines = tenant.aiKnowledgeItems.map((kb) => `P: ${kb.question}\nR: ${kb.answer}`);
    sections.push(`BASE DE CONOCIMIENTOS OFICIAL:\n${kbLines.join('\n')}`);
  }

  if (tenant.aiTrainingExamples.length > 0) {
    const exLines = tenant.aiTrainingExamples.map(
      (ex) => `Cliente: "${ex.customerInput}" ➔ Asistente: "${ex.idealResponse}"`,
    );
    sections.push(`EJEMPLOS DE RESPUESTAS APROBADAS:\n${exLines.join('\n')}`);
  }

  if (tenant.problemTypes && tenant.problemTypes.length > 0) {
    const problemLines = tenant.problemTypes.map(
      (pt) =>
        `- [ID: ${pt.id}] ${pt.name}${pt.description ? `: ${pt.description}` : ''} (Categoría: ${pt.defaultReason}, Modalidad sugerida: ${pt.defaultServiceType})`,
    );
    sections.push(`CATÁLOGO DE PROBLEMAS DEL ERP:\n${problemLines.join('\n')}`);
  }

  return sections.join('\n\n');
}

/**
 * Construye el contexto dinámico del cliente, sus equipos y el historial de chat.
 */
export function buildCustomerConversationContext(params: {
  customerName: string;
  equipments: Pick<Equipment, 'id' | 'name' | 'brand' | 'model' | 'serialNumber'>[];
  recentMessages: Pick<Message, 'senderType' | 'content'>[];
  latestMessage: string;
}): string {
  const { customerName, equipments, recentMessages, latestMessage } = params;

  const eqText =
    equipments.length > 0
      ? equipments
          .map(
            (eq) =>
              `- [ID: ${eq.id}] ${eq.name} (Marca: ${eq.brand || 'N/A'}, Modelo: ${eq.model || 'N/A'}, S/N: ${eq.serialNumber || 'N/A'})`,
          )
          .join('\n')
      : 'Sin equipos registrados en la ficha del cliente.';

  const senderLabel: Record<SenderType, string> = {
    CUSTOMER: 'Cliente',
    BOT: 'Asistente IA',
    AGENT: 'Operador',
    SYSTEM: 'Sistema',
  };

  const historyLines = recentMessages
    .slice(-8)
    .map((m) => `${senderLabel[m.senderType] || m.senderType}: ${m.content}`);

  return [
    `CLIENTE ACTUAL: ${customerName}`,
    `EQUIPOS REGISTRADOS DEL CLIENTE:\n${eqText}`,
    historyLines.length > 0 ? `HISTORIAL RECIENTE DE LA CONVERSACIÓN:\n${historyLines.join('\n')}` : '',
    `ÚLTIMO MENSAJE DEL CLIENTE:\n"${latestMessage}"`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Extrae respuesta limpia y payload JSON si la IA decidió derivar a ticket.
 */
export function parseEscalationOutput(rawText: string): {
  replyText: string;
  escalationPayload: Record<string, any> | null;
} {
  if (!rawText.includes('ESCALATION_JSON:')) {
    return { replyText: rawText.trim(), escalationPayload: null };
  }

  const [replyPart, rawJsonPart] = rawText.split('ESCALATION_JSON:');
  const cleanJson = rawJsonPart
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    return {
      replyText: replyPart.trim(),
      escalationPayload: JSON.parse(cleanJson),
    };
  } catch {
    return { replyText: replyPart.trim() || rawText.trim(), escalationPayload: null };
  }
}

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

const DEPRECATED_GEMINI_MODELS = new Set([
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
]);

/**
 * Resuelve el modelo de Gemini vigente, reemplazando modelos retirados por el modelo por defecto.
 */
export function resolveGeminiModel(
  tenantModel?: string | null,
  envModel?: string | null,
): string {
  const candidates = [tenantModel, envModel, DEFAULT_GEMINI_MODEL];
  for (const candidate of candidates) {
    const normalized = candidate?.trim();
    if (normalized && !DEPRECATED_GEMINI_MODELS.has(normalized)) {
      return normalized;
    }
  }
  return DEFAULT_GEMINI_MODEL;
}

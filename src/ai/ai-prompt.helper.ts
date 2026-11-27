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
import {
  Content,
  createPartFromFunctionResponse,
  FunctionDeclaration,
  GoogleGenAI,
  Part,
  Type,
} from '@google/genai';
import type { PrismaService } from '../prisma/prisma.service';

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
PROTOCOLO TÉCNICO INTERNO DE IDENTIFICACIÓN DE EQUIPO Y DERIVACIÓN (NO MOSTRAR AL CLIENTE):
- Evalúa la consulta usando exclusivamente la DIRECTIVA BASE, las REGLAS DE OBLIGATORIO CUMPLIMIENTO, la BASE DE CONOCIMIENTOS y el CATÁLOGO DE PROBLEMAS DEL ERP configurados para la empresa.
- IMPORTANTE SOBRE IDENTIFICACIÓN DEL CLIENTE: No asumas quién es el cliente por su número de WhatsApp. El cliente y la máquina se identifican mediante el **ID, código interno o número de serie del equipo**.
- Si el cliente todavía no indicó el ID/código/serie del equipo afectado, pídeselo amablemente antes de crear el ticket (salvo que la consulta sea meramente general o administrativa que no requiera equipo).
- Apenas el cliente mencione un ID, código o número de serie de máquina, DEBES llamar primero a la herramienta \`buscar_equipo_por_id\` para consultar la base de datos y obtener el \`equipmentId\` real y los datos del cliente propietario (vía \`codClient\`).
- Una vez identificado el equipo y conocido el problema (y si no pudiste resolverlo según las reglas de la empresa), clasifica el problema usando el CATÁLOGO DE PROBLEMAS DEL ERP y agrega al final de tu respuesta una única línea exacta sin bloques de código Markdown:
ESCALATION_JSON:{"shouldEscalate":true,"reason":"Resumen corto del motivo","ticketReason":"MECHANICAL_FAILURE"|"ELECTRICAL_ERROR"|"TONER_SUPPLIES"|"CALIBRATION_SOFTWARE"|"PREVENTIVE_MAINTENANCE"|"ADMINISTRATIVE"|"OTHER","problemTypeId":"ID exacto del catálogo de problemas ERP o null","serviceType":"REMOTE_WHATSAPP"|"ONSITE_PHYSICAL","priority":"LOW"|"MEDIUM"|"HIGH"|"CRITICAL","diagnosticSummary":"Diagnóstico técnico detallado incluyendo equipo y cliente identificado","equipmentId":"ID exacto (UUID) del equipo obtenido con buscar_equipo_por_id o null"}
`.trim();

/**
 * Construye las instrucciones oficiales de la compañía configuradas por el SuperAdmin.
 * Se comparte entre WhatsApp en vivo y el Simulador para garantizar paridad 1:1.
 */
export function buildTenantAiSystemInstructions(
  tenant: TenantAiPromptContext,
  options?: { latestMessage?: string },
): string {
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
    let selectedKb = tenant.aiKnowledgeItems;
    if (selectedKb.length > 15 && options?.latestMessage) {
      const tokens = options.latestMessage
        .toLowerCase()
        .split(/[^a-záéíóúüñ0-9]+/i)
        .filter((t) => t.length >= 3);
      if (tokens.length > 0) {
        selectedKb = [...selectedKb]
          .sort((a, b) => {
            const textA = `${a.question} ${a.answer}`.toLowerCase();
            const textB = `${b.question} ${b.answer}`.toLowerCase();
            const scoreA = tokens.reduce((acc, tk) => (textA.includes(tk) ? acc + 1 : acc), 0);
            const scoreB = tokens.reduce((acc, tk) => (textB.includes(tk) ? acc + 1 : acc), 0);
            return scoreB - scoreA;
          })
          .slice(0, 15);
      } else {
        selectedKb = selectedKb.slice(0, 15);
      }
    }
    const kbLines = selectedKb.map((kb) => `P: ${kb.question}\nR: ${kb.answer}`);
    sections.push(`BASE DE CONOCIMIENTOS OFICIAL:\n${kbLines.join('\n')}`);
  }

  if (tenant.aiTrainingExamples.length > 0) {
    const exLines = tenant.aiTrainingExamples.map(
      (ex) => `Cliente: "${ex.customerInput}" ➔ Asistente: "${ex.idealResponse}"`,
    );
    sections.push(`EJEMPLOS DE RESPUESTAS APROBADAS:\n${exLines.join('\n')}`);
  }

  if (tenant.problemTypes && tenant.problemTypes.length > 0) {
    const compact = tenant.problemTypes.length > 20;
    const problemLines = tenant.problemTypes.map((pt) =>
      compact
        ? `- [ID: ${pt.id}] ${pt.name} (${pt.defaultReason} / ${pt.defaultServiceType})`
        : `- [ID: ${pt.id}] ${pt.name}${pt.description ? `: ${pt.description}` : ''} (Categoría: ${pt.defaultReason}, Modalidad sugerida: ${pt.defaultServiceType})`,
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
  customerExternalCode?: string | null;
  equipments: Array<{
    id: string;
    name: string;
    brand?: string | null;
    model?: string | null;
    serialNumber?: string | null;
    externalCode?: string | null;
    internalCode?: string | null;
    clientCode?: string | null;
    codClient?: string | null;
    customerCompanyName?: string | null;
    customerName?: string | null;
  }>;
  recentMessages: Pick<Message, 'senderType' | 'content'>[];
  latestMessage: string;
}): string {
  const { customerName, customerExternalCode, equipments, recentMessages, latestMessage } = params;

  const eqText =
    equipments.length > 0
      ? equipments
          .map(
            (eq) =>
              `- [ID: ${eq.id}] ${eq.name} (N°/Cod. máquina: ${eq.internalCode || eq.externalCode || 'N/A'}, codClient: ${eq.codClient || eq.clientCode || 'N/A'}, Cliente dueño: ${eq.customerCompanyName || eq.customerName || 'N/A'}, Marca: ${eq.brand || 'N/A'}, Modelo: ${eq.model || 'N/A'}, S/N: ${eq.serialNumber || 'N/A'})`,
          )
          .join('\n')
      : 'Pendiente: aún no se identificó el equipo. Solicita el ID/código/serie del equipo y usa la herramienta buscar_equipo_por_id.';

  const senderLabel: Record<SenderType, string> = {
    CUSTOMER: 'Cliente',
    BOT: 'Asistente IA',
    AGENT: 'Operador',
    SYSTEM: 'Sistema',
  };

  const historyLines = recentMessages
    .slice(-20)
    .map((m) => `${senderLabel[m.senderType] || m.senderType}: ${m.content}`);

  const clientHeader = customerExternalCode
    ? `${customerName} (codClient: ${customerExternalCode})`
    : `${customerName} (cliente aún no identificado por equipo; pedir ID/código del equipo)`;

  return [
    `CONTACTO EN CHAT: ${clientHeader}`,
    `EQUIPOS ASOCIADOS:\n${eqText}`,
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
export const FALLBACK_GEMINI_MODEL = 'gemini-3.5-flash-lite';

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

function isTransientGeminiError(err: any): boolean {
  const msg = String(err?.message || '');
  return (
    err?.status === 503 ||
    err?.status === 429 ||
    msg.includes('"code":503') ||
    msg.includes('"code":429') ||
    msg.includes('UNAVAILABLE')
  );
}

/**
 * Ejecuta una llamada a Gemini con reintentos breves ante picos temporales de demanda (503 / 429).
 */
export async function callGeminiWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 1,
  baseDelayMs = 1200,
): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (!isTransientGeminiError(err) || attempt === maxRetries) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (attempt + 1)));
    }
  }
  throw lastError;
}

export const LOOKUP_EQUIPMENT_TOOL: FunctionDeclaration = {
  name: 'buscar_equipo_por_id',
  description:
    'Consulta la base de datos de máquinas/equipos del tenant por ID, código externo, código interno, ID legado o número de serie. Devuelve los datos del equipo y del cliente propietario asociado mediante codClient.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      codigoEquipo: {
        type: Type.STRING,
        description:
          'ID, código interno, código externo del ERP o número de serie de la máquina suministrado por el cliente.',
      },
    },
    required: ['codigoEquipo'],
  },
};

/**
 * Busca una máquina en la base de datos por ID/código/serie y resuelve su cliente asociado vía codClient/customerId.
 */
export async function findEquipmentAndClientByCode(
  prisma: PrismaService,
  tenantId: string,
  rawCode: string,
): Promise<{
  found: boolean;
  searchedCode: string;
  matches: Array<{
    equipmentId: string;
    externalCode: string | null;
    internalCode: string | null;
    name: string;
    brand: string | null;
    model: string | null;
    serialNumber: string | null;
    status: string;
    codClient: string | null;
    customer: {
      customerId: string;
      externalCode: string | null;
      name: string;
      companyName: string | null;
      cuit: string | null;
      address: string | null;
      locality: string | null;
    } | null;
  }>;
}> {
  const clean = rawCode.trim().replace(/^#/, '');
  if (!clean) {
    return { found: false, searchedCode: rawCode, matches: [] };
  }

  const strippedZeros = clean.replace(/^0+/, '') || clean;
  const numericCandidate = /^\d+$/.test(clean) ? Number(clean) : null;

  // 1. Priorizar búsqueda por machine.code (specifications.internalCode), que es el N° de equipo visible para el cliente
  let equipments = await prisma.equipment.findMany({
    where: {
      tenantId,
      OR: [
        { specifications: { path: ['internalCode'], equals: clean } },
        { specifications: { path: ['internalCode'], equals: strippedZeros } },
        ...(numericCandidate !== null
          ? [{ specifications: { path: ['internalCode'], equals: numericCandidate } }]
          : []),
        { name: { contains: `(Int. ${clean})`, mode: 'insensitive' } },
      ],
    },
    include: { customer: true },
    take: 5,
  });

  // 2. Fallback por número de serie, UUID interno o ID numérico del ERP (externalCode / legacyMachineId)
  if (equipments.length === 0) {
    equipments = await prisma.equipment.findMany({
      where: {
        tenantId,
        OR: [
          { serialNumber: { equals: clean, mode: 'insensitive' } },
          { id: clean },
          { externalCode: { equals: clean, mode: 'insensitive' } },
          { externalCode: { equals: strippedZeros, mode: 'insensitive' } },
          { specifications: { path: ['legacyMachineId'], equals: clean } },
          { specifications: { path: ['erpId'], equals: clean } },
          ...(numericCandidate !== null
            ? [
                { specifications: { path: ['erpId'], equals: numericCandidate } },
                { specifications: { path: ['legacyMachineId'], equals: numericCandidate } },
              ]
            : []),
        ],
      },
      include: { customer: true },
      take: 5,
    });
  }

  const matches = await Promise.all(
    equipments.map(async (eq) => {
      let resolvedCustomer = eq.customer;
      if ((!resolvedCustomer || !resolvedCustomer.externalCode) && eq.clientCode) {
        const cleanCod = eq.clientCode.trim();
        const strippedCod = cleanCod.replace(/^0+/, '') || cleanCod;
        const byCod = await prisma.customer.findFirst({
          where: {
            tenantId,
            OR: [{ externalCode: cleanCod }, { externalCode: strippedCod }],
          },
        });
        if (byCod) {
          resolvedCustomer = byCod;
        }
      }

      const specs = (eq.specifications && typeof eq.specifications === 'object' ? eq.specifications : {}) as Record<
        string,
        any
      >;

      return {
        equipmentId: eq.id,
        externalCode: eq.externalCode,
        internalCode: specs.internalCode ? String(specs.internalCode) : null,
        name: eq.name,
        brand: eq.brand,
        model: eq.model,
        serialNumber: eq.serialNumber,
        status: eq.status,
        codClient: eq.clientCode || resolvedCustomer?.externalCode || null,
        customer: resolvedCustomer
          ? {
              customerId: resolvedCustomer.id,
              externalCode: resolvedCustomer.externalCode,
              name: resolvedCustomer.name,
              companyName: resolvedCustomer.companyName,
              cuit: resolvedCustomer.cuit,
              address: resolvedCustomer.address,
              locality: resolvedCustomer.locality,
            }
          : null,
      };
    }),
  );

  return {
    found: matches.length > 0,
    searchedCode: clean,
    matches,
  };
}

/**
 * Pre-consulta códigos/IDs candidatos en el mensaje del cliente antes de llamar a Gemini
 * para evitar la segunda ida de tool-calling cuando el código ya viene explícito.
 */
export async function prelookupEquipmentsFromTexts(
  prisma: PrismaService,
  tenantId: string,
  texts: string[],
) {
  const joined = texts.filter(Boolean).join(' ');
  const rawTokens = joined.match(/#?[A-Za-z0-9][A-Za-z0-9-]{2,15}/g) || [];

  // Priorizar tokens numéricos o alfanuméricos con al menos un dígito (evitar palabras comunes)
  const candidates = Array.from(
    new Set(
      rawTokens
        .map((t) => t.replace(/^#/, '').trim())
        .filter((t) => /\d/.test(t) && t.length >= 2 && t.length <= 15),
    ),
  ).slice(0, 4);

  if (candidates.length === 0) {
    return [];
  }

  const results = await Promise.all(
    candidates.map((code) => findEquipmentAndClientByCode(prisma, tenantId, code)),
  );

  const byId = new Map<string, (typeof results)[number]['matches'][number]>();
  for (const res of results) {
    for (const match of res.matches) {
      if (!byId.has(match.equipmentId)) {
        byId.set(match.equipmentId, match);
      }
    }
  }

  return Array.from(byId.values()).slice(0, 5);
}

/**
 * Ejecuta Gemini habilitando la herramienta buscar_equipo_por_id para consultar máquinas y su cliente (codClient).
 */
export async function generateGeminiWithEquipmentTools(params: {
  client: GoogleGenAI;
  prisma: PrismaService;
  tenantId: string;
  preferredModel: string;
  systemInstruction: string;
  userContext: string;
  temperature: number;
  initialMatchedEquipmentId?: string;
  initialMatchedCustomerId?: string;
}): Promise<{
  text: string;
  modelUsed: string;
  matchedEquipmentId?: string;
  matchedCustomerId?: string;
}> {
  const {
    client,
    prisma,
    tenantId,
    preferredModel,
    systemInstruction,
    userContext,
    temperature,
    initialMatchedEquipmentId,
    initialMatchedCustomerId,
  } = params;
  const contents: Content[] = [{ role: 'user', parts: [{ text: userContext }] }];
  let lastModelUsed = preferredModel;
  let matchedEquipmentId: string | undefined = initialMatchedEquipmentId;
  let matchedCustomerId: string | undefined = initialMatchedCustomerId;

  const callModel = async (model: string) => {
    try {
      return await client.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
          temperature,
          thinkingConfig: { thinkingBudget: 0 },
          tools: [{ functionDeclarations: [LOOKUP_EQUIPMENT_TOOL] }],
        },
      });
    } catch (err: any) {
      if (err?.status === 400 || String(err?.message || '').toLowerCase().includes('thinking')) {
        return client.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction,
            temperature,
            tools: [{ functionDeclarations: [LOOKUP_EQUIPMENT_TOOL] }],
          },
        });
      }
      throw err;
    }
  };

  for (let round = 0; round < 3; round++) {
    const { result: response, modelUsed } = await generateGeminiWithFallback(preferredModel, callModel);
    lastModelUsed = modelUsed;

    const functionCalls = response.functionCalls;
    if (!functionCalls || functionCalls.length === 0) {
      return {
        text: response.text || '',
        modelUsed: lastModelUsed,
        matchedEquipmentId,
        matchedCustomerId,
      };
    }

    const modelContent = response.candidates?.[0]?.content;
    if (modelContent) {
      contents.push(modelContent);
    }

    const responseParts: Part[] = [];
    for (const call of functionCalls) {
      if (call.name === 'buscar_equipo_por_id') {
        const codigo = String(call.args?.codigoEquipo || '');
        const lookup = await findEquipmentAndClientByCode(prisma, tenantId, codigo);
        if (lookup.matches.length === 1) {
          matchedEquipmentId = lookup.matches[0].equipmentId;
          matchedCustomerId = lookup.matches[0].customer?.customerId;
        }
        responseParts.push(
          createPartFromFunctionResponse(
            call.id || call.name,
            call.name,
            lookup as unknown as Record<string, unknown>,
          ),
        );
      }
    }

    if (responseParts.length === 0) {
      return {
        text: response.text || '',
        modelUsed: lastModelUsed,
        matchedEquipmentId,
        matchedCustomerId,
      };
    }

    contents.push({ role: 'user', parts: responseParts });
  }

  return {
    text: '',
    modelUsed: lastModelUsed,
    matchedEquipmentId,
    matchedCustomerId,
  };
}

/**
 * Ejecuta Gemini probando el modelo principal y haciendo fallback a gemini-3.5-flash-lite
 * si el modelo principal responde saturación temporal (503 / 429).
 */
export async function generateGeminiWithFallback<T>(
  primaryModel: string,
  invoke: (model: string) => Promise<T>,
): Promise<{ result: T; modelUsed: string }> {
  try {
    const result = await callGeminiWithRetry(() => invoke(primaryModel), 1, 1000);
    return { result, modelUsed: primaryModel };
  } catch (err: any) {
    if (!isTransientGeminiError(err) || primaryModel === FALLBACK_GEMINI_MODEL) {
      throw err;
    }
    const result = await callGeminiWithRetry(() => invoke(FALLBACK_GEMINI_MODEL), 1, 1000);
    return { result, modelUsed: FALLBACK_GEMINI_MODEL };
  }
}

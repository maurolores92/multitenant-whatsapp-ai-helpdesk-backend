import { EquipmentStatus, ServiceType, TicketReason } from '@prisma/client';

export interface NormalizedErpCustomer {
  externalCode: string;
  name: string;
  companyName: string | null;
  phone: string;
  email: string | null;
  cuit: string | null;
  address: string | null;
  locality: string | null;
  notes: string | null;
}

export interface NormalizedErpEquipment {
  externalCode: string;
  clientCode: string;
  name: string;
  brand: string | null;
  model: string | null;
  serialNumber: string | null;
  status: EquipmentStatus;
  notes: string | null;
  specifications: Record<string, any>;
  embeddedClient?: Record<string, any> | null;
}

export interface NormalizedErpProblem {
  externalCode: string | null;
  name: string;
  description: string | null;
  defaultReason: TicketReason;
  defaultServiceType: ServiceType;
  isActive: boolean;
}

function pickStr(record: Record<string, any>, keys: string[]): string | null {
  for (const key of keys) {
    const val = record?.[key];
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      return String(val).trim();
    }
  }
  return null;
}

/**
 * Normaliza código de cliente para hacer matching con o sin ceros a la izquierda ("000123" == "123")
 */
export function normalizeClientCodeKey(code: string): string {
  const trimmed = code.trim();
  const stripped = trimmed.replace(/^0+/, '');
  return stripped || '0';
}

export function unwrapErpCollection(payload: any): {
  items: Record<string, any>[];
  total: number | null;
} {
  if (Array.isArray(payload)) {
    return { items: payload, total: payload.length };
  }
  if (!payload || typeof payload !== 'object') {
    return { items: [], total: 0 };
  }

  for (const key of ['data', 'items', 'results', 'rows', 'clients', 'machines', 'problems']) {
    if (Array.isArray(payload[key])) {
      const total = typeof payload.total === 'number' ? payload.total : null;
      return { items: payload[key], total };
    }
  }

  return { items: [], total: 0 };
}

export function joinErpUrl(baseUrl: string, endpoint: string): string {
  const cleanBase = baseUrl.trim().replace(/\/+$/, '');
  const cleanPath = endpoint.trim().startsWith('/') ? endpoint.trim() : `/${endpoint.trim()}`;
  return `${cleanBase}${cleanPath}`;
}

export function normalizeErpPhone(rawPhone: string | null, fallbackCode: string): string {
  if (!rawPhone) return `erp-sin-tel-${fallbackCode}`;
  const digits = rawPhone.replace(/\D/g, '');
  if (!digits) return `erp-sin-tel-${fallbackCode}`;
  return rawPhone.trim().startsWith('+') ? `+${digits}` : `+${digits}`;
}

/**
 * Mapea respuesta real de GET /clients en api.helpcopies.com/api
 */
export function mapErpCustomer(row: Record<string, any>, index: number): NormalizedErpCustomer | null {
  const externalCode =
    pickStr(row, ['codigoCliente', 'codClient', 'COD_CLIENT', 'externalCode', 'codigo', 'code', 'id']) ||
    `CLI-${index + 1}`;
  const razonSocial = pickStr(row, ['razonSocial', 'companyName', 'RAZON_SOC', 'empresa']);
  const nombreFantasia = pickStr(row, ['nombreFantasia', 'name', 'nombre', 'NOM_COM']);
  const name = nombreFantasia || razonSocial;
  if (!name) return null;

  const rawPhone = pickStr(row, ['whatsapp', 'telefono', 'phone', 'TELEFONO', 'celular', 'mobile']);
  const cp = pickStr(row, ['codigoPostal']);
  const statusLabel = row?.statusInfo?.label || row?.status;

  return {
    externalCode,
    name,
    companyName: razonSocial || nombreFantasia || name,
    phone: normalizeErpPhone(rawPhone, externalCode),
    email: pickStr(row, ['email', 'E_MAIL', 'correo']),
    cuit: pickStr(row, ['cuit', 'CUIT', 'N_CUIT']),
    address: pickStr(row, ['direccion', 'address', 'domicilio', 'DOMICILIO']),
    locality: pickStr(row, ['localidad', 'locality', 'LOCALIDAD', 'ciudad']),
    notes: [cp ? `CP: ${cp}` : null, statusLabel ? `Estado ERP: ${statusLabel}` : null].filter(Boolean).join(' • ') || null,
  };
}

/**
 * Mapea respuesta real de GET /machines en api.helpcopies.com/api
 */
export function mapErpEquipment(row: Record<string, any>, index: number): NormalizedErpEquipment | null {
  const clientCode =
    pickStr(row, ['codClient', 'COD_CLIENT', 'clientCode', 'customerCode', 'codigoCliente']) ||
    pickStr(row?.client || {}, ['codigoCliente', 'codClient', 'id']);
  if (!clientCode) return null;

  const idStr = pickStr(row, ['id', 'legacyMachineId']);
  const codeStr = pickStr(row, ['code']);
  const externalCode = idStr || codeStr || `EQ-${clientCode}-${index + 1}`;

  const brandName =
    typeof row?.model === 'object' && row.model !== null
      ? pickStr(row.model?.brand || {}, ['name'])
      : pickStr(row, ['brand', 'marca']);

  const modelName =
    typeof row?.model === 'object' && row.model !== null
      ? pickStr(row.model, ['name'])
      : pickStr(row, ['model', 'modelo']);

  const machineTypeName =
    typeof row?.machineType === 'object' && row.machineType !== null
      ? pickStr(row.machineType, ['name'])
      : null;

  const serialNumber = pickStr(row, ['serialNumber', 'serie', 'nroSerie', 'NRO_SERIE']);

  const displayName =
    [brandName, modelName].filter(Boolean).join(' ').trim() ||
    machineTypeName ||
    pickStr(row, ['name', 'nombre', 'descripcion']) ||
    `Equipo #${codeStr || externalCode}`;

  const fullName = codeStr ? `${displayName} (Int. ${codeStr})` : displayName;

  const statusRaw = String(row?.status || 'ACTIVE').toUpperCase();
  const status: EquipmentStatus =
    statusRaw === 'INACTIVE' || statusRaw === 'DECOMMISSIONED'
      ? EquipmentStatus.DECOMMISSIONED
      : statusRaw === 'IN_REPAIR'
      ? EquipmentStatus.IN_REPAIR
      : EquipmentStatus.ACTIVE;

  return {
    externalCode,
    clientCode,
    name: fullName,
    brand: brandName,
    model: modelName,
    serialNumber,
    status,
    notes: pickStr(row, ['notes']),
    specifications: {
      erpId: row?.id ?? null,
      legacyMachineId: row?.legacyMachineId ?? null,
      internalCode: codeStr,
      machineType: machineTypeName,
      hasContract: row?.machineType?.hasContract ?? null,
      address: row?.address ?? null,
      location: row?.location ?? null,
      copies: row?.copies ?? 0,
      isColor: Boolean(row?.isColor),
      colorCopies: row?.colorCopies ?? 0,
      includeTechnicalService: Boolean(row?.includeTechnicalService),
      includeParts: Boolean(row?.includeParts),
      includeToner: Boolean(row?.includeToner),
      installationDate: row?.installationDate ?? null,
      origin: row?.origin ?? null,
    },
    embeddedClient: row?.client && typeof row.client === 'object' ? row.client : null,
  };
}

export function inferTicketReason(text: string, rawReason?: string | null): TicketReason {
  if (rawReason && Object.values(TicketReason).includes(rawReason as TicketReason)) {
    return rawReason as TicketReason;
  }

  const lower = text.toLowerCase();
  if (/atasco|rodillo|fusor|mecan|engra|bandeja|hoja|traba|puerta/.test(lower)) return TicketReason.MECHANICAL_FAILURE;
  if (/electr|energia|tension|enciende|fusible|quemad|corto|error|codigo|sc/.test(lower))
    return TicketReason.ELECTRICAL_ERROR;
  if (/toner|tinta|cartucho|insumo|drum|cilindro|revelador/.test(lower)) return TicketReason.TONER_SUPPLIES;
  if (/red|wifi|ip|driver|escaneo|scan|calibr|soft|config/.test(lower)) return TicketReason.CALIBRATION_SOFTWARE;
  if (/prevent|limpieza|mantenimiento|service/.test(lower)) return TicketReason.PREVENTIVE_MAINTENANCE;
  if (/factur|admin|contrato|abono|presupuesto|contador/.test(lower)) return TicketReason.ADMINISTRATIVE;

  return TicketReason.OTHER;
}

/**
 * Mapea respuesta real de GET /problems en api.helpcopies.com/api
 */
export function mapErpProblem(row: Record<string, any>): NormalizedErpProblem | null {
  const name = pickStr(row, ['description', 'name', 'nombre', 'DESCRIPCION', 'titulo']);
  if (!name) return null;

  const externalCode = pickStr(row, ['id', 'externalCode', 'codigo', 'code']);
  const legacyId = pickStr(row, ['legacyProblemId']);
  const rawReason = pickStr(row, ['defaultReason', 'reason', 'categoria']);
  const rawServiceType = pickStr(row, ['defaultServiceType', 'serviceType']);
  const statusRaw = String(row?.status || 'ACTIVE').toUpperCase();

  return {
    externalCode,
    name,
    description: legacyId ? `Código legado ERP: ${legacyId}` : null,
    defaultReason: inferTicketReason(name, rawReason),
    defaultServiceType:
      rawServiceType === ServiceType.REMOTE_WHATSAPP ? ServiceType.REMOTE_WHATSAPP : ServiceType.ONSITE_PHYSICAL,
    isActive: statusRaw !== 'INACTIVE',
  };
}

import { Role } from '@prisma/client';

export const PERMISSIONS = {
  // Módulo Servicio Técnico
  ACCESS_TECHNICAL_SERVICE: 'ACCESS_TECHNICAL_SERVICE',
  MANAGE_TECHNICAL_AI: 'MANAGE_TECHNICAL_AI',

  // Conversaciones y Chat WhatsApp
  READ_CHATS: 'READ_CHATS',
  SEND_CHAT_MESSAGE: 'SEND_CHAT_MESSAGE',
  ASSIGN_CONVERSATION: 'ASSIGN_CONVERSATION',
  RESOLVE_CONVERSATION: 'RESOLVE_CONVERSATION',

  // Gestión de Equipos de Clientes
  VIEW_EQUIPMENT: 'VIEW_EQUIPMENT',
  MANAGE_EQUIPMENT: 'MANAGE_EQUIPMENT',

  // Tickets y Soporte Técnico
  CREATE_TICKET: 'CREATE_TICKET',
  UPDATE_TICKET: 'UPDATE_TICKET',

  // Administración del Sistema & Configuración
  MANAGE_WHATSAPP_CONFIG: 'MANAGE_WHATSAPP_CONFIG',
  MANAGE_USERS_ROLES: 'MANAGE_USERS_ROLES',
  VIEW_AUDIT_LOGS: 'VIEW_AUDIT_LOGS',
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const PERMISSION_DEFINITIONS = [
  {
    code: PERMISSIONS.ACCESS_TECHNICAL_SERVICE,
    name: 'Acceso a Servicio Técnico',
    description: 'Habilita el módulo de Servicio Técnico (Chats de IA y Tickets)',
    category: 'technical_service',
  },
  {
    code: PERMISSIONS.MANAGE_TECHNICAL_AI,
    name: 'Configurar y Entrenar IA Técnica',
    description: 'Permite editar prompts, reglas, base de conocimiento y simular el agente de Servicio Técnico',
    category: 'technical_service',
  },
  {
    code: PERMISSIONS.READ_CHATS,
    name: 'Ver Chats de IA',
    description: 'Permite leer los mensajes y conversaciones de WhatsApp e IA',
    category: 'chat',
  },
  {
    code: PERMISSIONS.SEND_CHAT_MESSAGE,
    name: 'Responder Chats de WhatsApp',
    description: 'Permite responder manualmente a clientes desde la línea corporativa',
    category: 'chat',
  },
  {
    code: PERMISSIONS.ASSIGN_CONVERSATION,
    name: 'Asignar Conversaciones',
    description: 'Permite reasignar conversaciones a otros agentes o técnicos',
    category: 'chat',
  },
  {
    code: PERMISSIONS.RESOLVE_CONVERSATION,
    name: 'Cerrar Conversaciones',
    description: 'Permite marcar una conversación como resuelta',
    category: 'chat',
  },
  {
    code: PERMISSIONS.VIEW_EQUIPMENT,
    name: 'Ver Equipos de Clientes',
    description: 'Permite consultar fichas y códigos de máquinas',
    category: 'equipments',
  },
  {
    code: PERMISSIONS.MANAGE_EQUIPMENT,
    name: 'Gestionar Equipos',
    description: 'Permite registrar, editar o dar de baja equipos técnicos',
    category: 'equipments',
  },
  {
    code: PERMISSIONS.CREATE_TICKET,
    name: 'Crear Tickets / Órdenes',
    description: 'Permite abrir tickets de asistencia remota o física',
    category: 'tickets',
  },
  {
    code: PERMISSIONS.UPDATE_TICKET,
    name: 'Actualizar Tickets',
    description: 'Permite cambiar estados, resoluciones y asociar órdenes de servicio',
    category: 'tickets',
  },
  {
    code: PERMISSIONS.MANAGE_WHATSAPP_CONFIG,
    name: 'Configurar WhatsApp y Empresa',
    description: 'Permite configurar credenciales de Meta Cloud API y sincronización ERP',
    category: 'admin',
  },
  {
    code: PERMISSIONS.MANAGE_USERS_ROLES,
    name: 'Administrar Usuarios y Permisos',
    description: 'Permite dar de alta usuarios y asignar permisos por módulo',
    category: 'admin',
  },
  {
    code: PERMISSIONS.VIEW_AUDIT_LOGS,
    name: 'Consultar Registros de Auditoría',
    description: 'Permite auditar qué usuario realizó cada acción en el sistema',
    category: 'admin',
  },
];

export const TECHNICAL_SERVICE_BUNDLE: PermissionCode[] = [
  PERMISSIONS.ACCESS_TECHNICAL_SERVICE,
  PERMISSIONS.MANAGE_TECHNICAL_AI,
  PERMISSIONS.READ_CHATS,
  PERMISSIONS.SEND_CHAT_MESSAGE,
  PERMISSIONS.ASSIGN_CONVERSATION,
  PERMISSIONS.RESOLVE_CONVERSATION,
  PERMISSIONS.VIEW_EQUIPMENT,
  PERMISSIONS.MANAGE_EQUIPMENT,
  PERMISSIONS.CREATE_TICKET,
  PERMISSIONS.UPDATE_TICKET,
];

export const ROLE_DEFAULT_PERMISSIONS: Record<Role, PermissionCode[]> = {
  SUPER_ADMIN: Object.values(PERMISSIONS),
  ADMIN: Object.values(PERMISSIONS),
  TECHNICIAN: [...TECHNICAL_SERVICE_BUNDLE],
  AGENT: [
    PERMISSIONS.ACCESS_TECHNICAL_SERVICE,
    PERMISSIONS.READ_CHATS,
    PERMISSIONS.SEND_CHAT_MESSAGE,
    PERMISSIONS.RESOLVE_CONVERSATION,
    PERMISSIONS.VIEW_EQUIPMENT,
    PERMISSIONS.CREATE_TICKET,
  ],
};

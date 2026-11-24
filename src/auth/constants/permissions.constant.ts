import { Role } from '@prisma/client';

export const PERMISSIONS = {
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
    code: PERMISSIONS.READ_CHATS,
    name: 'Ver Conversaciones',
    description: 'Permite leer los mensajes y chats de WhatsApp de la empresa',
    category: 'chat',
  },
  {
    code: PERMISSIONS.SEND_CHAT_MESSAGE,
    name: 'Enviar Mensajes de WhatsApp',
    description: 'Permite responder a clientes desde la línea corporativa',
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
    description: 'Permite consultar fichas y números de serie de equipos',
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
    name: 'Crear Órdenes de Servicio',
    description: 'Permite abrir tickets de asistencia remota o física',
    category: 'tickets',
  },
  {
    code: PERMISSIONS.UPDATE_TICKET,
    name: 'Actualizar Tickets',
    description: 'Permite cambiar estados, resoluciones y técnicos asignados',
    category: 'tickets',
  },
  {
    code: PERMISSIONS.MANAGE_WHATSAPP_CONFIG,
    name: 'Configurar WhatsApp',
    description: 'Permite conectar/desconectar el código QR y ajustar prompts de IA',
    category: 'admin',
  },
  {
    code: PERMISSIONS.MANAGE_USERS_ROLES,
    name: 'Administrar Usuarios y Roles',
    description: 'Permite invitar nuevos técnicos, agentes y asignar roles',
    category: 'admin',
  },
  {
    code: PERMISSIONS.VIEW_AUDIT_LOGS,
    name: 'Consultar Registros de Auditoría',
    description: 'Permite auditar qué usuario realizó cada acción en el sistema',
    category: 'admin',
  },
];

export const ROLE_DEFAULT_PERMISSIONS: Record<Role, PermissionCode[]> = {
  SUPER_ADMIN: Object.values(PERMISSIONS),
  ADMIN: Object.values(PERMISSIONS),
  TECHNICIAN: [
    PERMISSIONS.READ_CHATS,
    PERMISSIONS.SEND_CHAT_MESSAGE,
    PERMISSIONS.ASSIGN_CONVERSATION,
    PERMISSIONS.RESOLVE_CONVERSATION,
    PERMISSIONS.VIEW_EQUIPMENT,
    PERMISSIONS.MANAGE_EQUIPMENT,
    PERMISSIONS.CREATE_TICKET,
    PERMISSIONS.UPDATE_TICKET,
  ],
  AGENT: [
    PERMISSIONS.READ_CHATS,
    PERMISSIONS.SEND_CHAT_MESSAGE,
    PERMISSIONS.RESOLVE_CONVERSATION,
    PERMISSIONS.VIEW_EQUIPMENT,
    PERMISSIONS.CREATE_TICKET,
  ],
};

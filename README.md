# 🚀 Backend - WhatsApp AI CRM & Technical Service API

API REST y servidor WebSockets construido con **NestJS 11**, **Prisma ORM** y **PostgreSQL**. Administra la lógica de negocio multi-inquilino, el motor de triaje y diagnóstico con IA (Google Gemini), y la integración oficial con **Meta WhatsApp Business Cloud API**.

---

## 🛠️ Stack Tecnológico

- **Framework**: [NestJS 11](https://nestjs.com/)
- **ORM**: [Prisma 6](https://www.prisma.io/)
- **Base de Datos**: PostgreSQL 16
- **Motor de IA**: [@google/genai](https://github.com/google-gemini/generative-ai-js) (Google Gemini 2.0 Flash)
- **Mensajería Oficial**: Meta Graph API v21.0
- **Comunicación en Tiempo Real**: Socket.IO Gateway (`@nestjs/websockets`)
- **Autenticación & Seguridad**: Passport JWT, BcryptJS, Class-Validator, RBAC

---

## 📂 Estructura de Módulos

```
src/
├── ai/                     # Motor de diagnóstico Nivel 1 y triaje con Google Gemini
├── ai-training/            # Configuración dinámica de reglas, base técnica y ejemplos
├── audit/                  # Registro de auditoría multi-tenant (AuditLog)
├── auth/                   # Autenticación, JWT, roles y permisos (RBAC)
├── chat/                   # Gestión de conversaciones, mensajes y human takeover
├── notifications/          # Gateway WebSocket para actualización en tiempo real
├── prisma/                 # Servicio y configuración centralizada de Prisma
├── tenants/                # Compañías, API Keys y configuración de WhatsApp
├── tickets/                # Órdenes de servicio y notificaciones de WhatsApp
├── users/                  # CRUD de usuarios, roles y contraseñas
└── whatsapp/               # Controlador de Webhooks de Meta y cliente Graph API
```

---

## ⚙️ Variables de Entorno (`.env`)

Crea un archivo `.env` en la raíz de `backend/` con la siguiente estructura:

```ini
# Base de Datos PostgreSQL
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/postgres?schema=public"
DATABASE_READONLY_URL="postgresql://postgres:postgres@127.0.0.1:5432/postgres?schema=public"

# Configuración del Servidor
PORT=5000
JWT_SECRET="tu-clave-secreta-jwt-super-segura"
JWT_EXPIRES_IN="7d"

# Meta WhatsApp Cloud API
META_API_VERSION="v21.0"
META_GRAPH_URL="https://graph.facebook.com"
META_WEBHOOK_VERIFY_TOKEN="meta_webhook_verify_token_whatsapp_crm"

# Credenciales por defecto para pruebas locales (Opcional si se configuran por empresa en la UI)
META_DEFAULT_PHONE_NUMBER_ID=""
META_DEFAULT_ACCESS_TOKEN=""

# Proveedor de Inteligencia Artificial
AI_PROVIDER="gemini"
GEMINI_MODEL="gemini-2.0-flash"
GEMINI_API_KEY="tu-api-key-de-gemini"
```

---

## 📦 Comandos Disponibles

### Instalación y Base de Datos
```bash
# Instalar dependencias
pnpm install

# Generar cliente tipado de Prisma
pnpm prisma generate

# Aplicar cambios del esquema a PostgreSQL
pnpm prisma db push

# Poblar datos base (permisos, roles, HelpCopies SRL y usuarios)
pnpm exec prisma db seed

# Abrir Prisma Studio (explorador visual de la base de datos)
pnpm prisma studio
```

### Ejecución
```bash
# Modo desarrollo con recarga automática
pnpm start:dev

# Compilación de producción
pnpm run build

# Ejecución en producción
pnpm run start:prod
```

### Pruebas Unitarias y E2E
```bash
# Pruebas unitarias
pnpm test

# Cobertura de pruebas
pnpm test:cov
```

---

## 📡 Endpoints Principales

### Autenticación (`/api/auth`)
- `POST /api/auth/login`: Autenticación con email y contraseña.
- `GET /api/auth/me`: Obtener perfil del usuario autenticado.

### Usuarios (`/api/users` - Solo Administradores)
- `GET /api/users`: Listar usuarios de la empresa.
- `POST /api/users`: Dar de alta un nuevo usuario (`ADMIN`, `TECHNICIAN`, `AGENT`).
- `PATCH /api/users/:id`: Actualizar datos o rol de un usuario.
- `PATCH /api/users/:id/password`: Cambiar contraseña de un usuario.
- `PATCH /api/users/:id/toggle-status`: Alternar estado activo / inactivo.

### Chat & WhatsApp (`/api/chat`)
- `GET /api/chat/conversations`: Listado de conversaciones con filtros de estado.
- `GET /api/chat/conversations/:id/messages`: Historial de mensajes.
- `POST /api/chat/messages`: Envío de mensaje manual por agente humano.
- `PATCH /api/chat/conversations/:id/take-over`: Tomar conversación (silenciar IA).
- `PATCH /api/chat/conversations/:id/release-to-bot`: Devolver conversación al bot.

### Tickets & Órdenes de Servicio (`/api/tickets`)
- `GET /api/tickets`: Listado de tickets clasificados por la IA.
- `PATCH /api/tickets/:id`: Actualizar estado, prioridad o modalidad.
- `POST /api/tickets/:id/notify-service-order`: Asociar N° de Orden de Servicio y enviar notificación WhatsApp al cliente.

### Entrenamiento de IA (`/api/ai-training` - Superadmin)
- `GET /api/ai-training/:tenantId`: Obtener reglas, conocimiento técnico y ejemplos.
- `PATCH /api/ai-training/:tenantId/config`: Actualizar API Key, modelo y prompt base.
- `POST /api/ai-training/:tenantId/rules`: Agregar regla de comportamiento.
- `POST /api/ai-training/:tenantId/knowledge`: Agregar ficha de conocimiento técnico.
- `POST /api/ai-training/:tenantId/examples`: Agregar ejemplo de pregunta/respuesta.

### Meta Webhook (`/api/whatsapp/webhook`)
- `GET /api/whatsapp/webhook`: Handshake de verificación requerido por Meta.
- `POST /api/whatsapp/webhook`: Receptor de mensajes y notificaciones de entrega.

---

## 🧪 Simulación de Mensaje de WhatsApp (Pruebas Locales)

Puedes simular el ingreso de un mensaje de WhatsApp ejecutando este comando en PowerShell:

```powershell
Invoke-RestMethod -Uri "http://localhost:5000/api/whatsapp/webhook" -Method POST -Headers @{"Content-Type"="application/json"} -Body '{
  "object": "whatsapp_business_account",
  "entry": [{
    "changes": [{
      "value": {
        "messaging_product": "whatsapp",
        "metadata": { "phone_number_id": "test_id" },
        "contacts": [{ "wa_id": "5491144442233", "profile": { "name": "Roberto Gómez" } }],
        "messages": [{
          "id": "msg_001",
          "from": "+5491144442233",
          "type": "text",
          "text": { "body": "Hola, la impresora Ricoh me tira código de error SC-542 y se trabó la hoja. ¿Pueden mandar un técnico?" }
        }]
      }
    }]
  }]
}'
```

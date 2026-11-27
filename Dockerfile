# ============================================================
# HelpDesk IA - Backend (NestJS + Prisma + PostgreSQL)
# ============================================================

FROM node:22-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@11.25.0 --activate

WORKDIR /app

# Copiar manifiestos y configuración de pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma/

# Instalar dependencias y generar cliente Prisma
RUN pnpm install --frozen-lockfile

# Copiar código fuente y compilar NestJS
COPY . .
RUN pnpm exec prisma generate && pnpm build

# ------------------------------------------------------------
# Etapa de ejecución
# ------------------------------------------------------------
FROM node:22-slim AS runner

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@11.25.0 --activate

WORKDIR /app

ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma/
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

EXPOSE 5000

CMD ["sh", "-c", "pnpm exec prisma db push --skip-generate && pnpm start:prod"]

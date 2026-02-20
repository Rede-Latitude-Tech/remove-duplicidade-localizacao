# ── Stage 1: Build ──────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

# Dummy DATABASE_URL para prisma generate (não conecta, só gera o client)
ARG DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy"

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ── Stage 2: Production ────────────────────────────────────────
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Prisma client gerado no builder
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# Código compilado
COPY --from=builder /app/dist ./dist

# Schema do Prisma (necessário para migrate deploy)
COPY prisma ./prisma

# Diagnóstico (fallback se o app crashar)
COPY diagnostic.cjs ./diagnostic.cjs

# Entrypoint
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 3003

ENTRYPOINT ["/docker-entrypoint.sh"]

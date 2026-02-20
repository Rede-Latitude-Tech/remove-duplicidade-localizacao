#!/bin/bash

echo "=== remove-duplicidade-localizacao ==="
echo ">> Node: $(node --version)"
echo ">> PORT: ${PORT:-3003}"
echo ">> DATABASE_URL definida: $([ -n "$DATABASE_URL" ] && echo 'sim' || echo 'NAO')"
echo ">> REDIS_URL definida: $([ -n "$REDIS_URL" ] && echo 'sim' || echo 'NAO')"

# 1. Sincronizar schema do Prisma (cria/atualiza tabelas ms_*)
echo ">> Sincronizando schema Prisma..."
npx prisma db push --skip-generate --accept-data-loss 2>&1 || echo ">> WARN: prisma db push falhou (continuando mesmo assim)"

# 2. Iniciar aplicação
echo ">> Iniciando servidor na porta ${PORT:-3003}..."
exec node dist/app.js

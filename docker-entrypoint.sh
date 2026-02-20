#!/bin/bash

echo "=== remove-duplicidade-localizacao ==="
echo ">> Node: $(node --version)"
echo ">> PORT: ${PORT:-3003}"
echo ">> DATABASE_URL definida: $([ -n "$DATABASE_URL" ] && echo 'sim' || echo 'NAO')"
echo ">> REDIS_URL definida: $([ -n "$REDIS_URL" ] && echo 'sim' || echo 'NAO')"

# 1. Prisma db push (desabilitado — tabelas já existem no Azure HML)
# Para criar tabelas na primeira vez, rodar manualmente:
#   npx prisma db push --skip-generate --accept-data-loss

# 2. Iniciar aplicação
echo ">> Iniciando servidor na porta ${PORT:-3003}..."
exec node dist/app.js

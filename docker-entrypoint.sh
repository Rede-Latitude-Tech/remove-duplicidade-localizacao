#!/bin/bash
set -e

echo "=== remove-duplicidade-localizacao ==="

# 1. Sincronizar schema do Prisma (cria/atualiza tabelas ms_*)
echo ">> Sincronizando schema Prisma..."
npx prisma db push --skip-generate --accept-data-loss 2>&1 || echo ">> WARN: prisma db push falhou"

# 2. Iniciar aplicação
echo ">> Iniciando servidor na porta ${PORT:-3003}..."
exec node dist/app.js

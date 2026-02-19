#!/bin/bash
set -e

echo "=== remove-duplicidade-localizacao ==="

# 1. Rodar migrations do Prisma
echo ">> Rodando Prisma migrations..."
npx prisma migrate deploy || echo ">> WARN: migrations falharam (pode ser primeira execução)"

# 2. Iniciar aplicação
echo ">> Iniciando servidor na porta ${PORT:-3003}..."
exec node dist/app.js

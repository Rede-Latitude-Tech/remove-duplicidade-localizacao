#!/bin/bash

echo "=== remove-duplicidade-localizacao ==="
echo ">> Node: $(node --version)"
echo ">> PORT: ${PORT:-3003}"
echo ">> DATABASE_URL definida: $([ -n "$DATABASE_URL" ] && echo 'sim' || echo 'NAO')"
echo ">> REDIS_URL definida: $([ -n "$REDIS_URL" ] && echo 'sim' || echo 'NAO')"

# 1. Prisma db push (desabilitado — tabelas já existem no Azure HML)
# Para criar tabelas na primeira vez, rodar manualmente:
#   npx prisma db push --skip-generate --accept-data-loss

# 2. Iniciar aplicação com fallback de diagnóstico
echo ">> Iniciando servidor na porta ${PORT:-3003}..."
node dist/app.js > /tmp/app.log 2>&1 &
APP_PID=$!

# Aguarda até 15 segundos para o app responder
for i in $(seq 1 15); do
    sleep 1
    # Verifica se o processo ainda está vivo
    if ! kill -0 $APP_PID 2>/dev/null; then
        echo ">> ERRO: App crashou após ${i}s"
        echo ">> Log:"
        cat /tmp/app.log
        echo ">> Iniciando servidor de diagnóstico..."
        exec node diagnostic.cjs
    fi
    # Verifica se o app responde
    if curl -sf http://localhost:${PORT:-3003}/health > /dev/null 2>&1; then
        echo ">> App respondendo OK após ${i}s"
        # Reconecta stdout ao processo do app
        wait $APP_PID
        exit $?
    fi
done

# Timeout — app está vivo mas não responde (pode estar travado)
echo ">> AVISO: App não respondeu em 15s, mas processo ainda vivo"
echo ">> Log até agora:"
cat /tmp/app.log
echo ">> Mantendo app em foreground..."
wait $APP_PID
exit $?

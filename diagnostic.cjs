// diagnostic.cjs — Servidor HTTP de diagnóstico (CJS puro, sem dependências)
// Se o app principal crashar, este server expõe o log de erro na porta 3003.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3003;
const LOG_FILE = "/tmp/app.log";

const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });

    let output = "=== DIAGNOSTIC SERVER ===\n";
    output += "O app principal FALHOU ao iniciar.\n";
    output += `Data: ${new Date().toISOString()}\n`;
    output += `Node: ${process.version}\n`;
    output += `PORT: ${PORT}\n\n`;

    // Mostrar variáveis de ambiente (sem secrets)
    output += "=== ENV VARS ===\n";
    for (const [k, v] of Object.entries(process.env)) {
        if (/KEY|PASSWORD|SECRET|URL/i.test(k)) {
            output += `${k}=<redacted len=${(v || "").length}>\n`;
        } else {
            output += `${k}=${v}\n`;
        }
    }
    output += "\n";

    // Mostrar log do app
    output += "=== APP LOG ===\n";
    try {
        output += fs.readFileSync(LOG_FILE, "utf8");
    } catch (e) {
        output += `(Arquivo ${LOG_FILE} não encontrado)\n`;
    }

    res.end(output);
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`[diagnostic] Servidor de diagnóstico rodando na porta ${PORT}`);
});

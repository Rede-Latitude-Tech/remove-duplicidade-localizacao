import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { env } from "./config/env.js";
import { prisma } from "./config/database.js";
import { healthRoutes } from "./routes/health.routes.js";
import { gruposRoutes } from "./routes/grupos.routes.js";
import { mergeRoutes } from "./routes/merge.routes.js";
import { scanRoutes } from "./routes/scan.routes.js";
import { statsRoutes } from "./routes/stats.routes.js";
import { relatorioRoutes } from "./routes/relatorio.routes.js";

// Bootstrap do servidor Fastify
const app = Fastify({
    logger: {
        level: env.NODE_ENV === "development" ? "info" : "warn",
    },
});

// Plugins de segurança e CORS (methods inclui PUT/DELETE para merge/reversão/descarte)
await app.register(cors, { origin: true, methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"] });
await app.register(helmet);

// Rotas
await app.register(healthRoutes, { prefix: "/" });
await app.register(gruposRoutes, { prefix: "/grupos" });
await app.register(mergeRoutes, { prefix: "/grupos" });
await app.register(scanRoutes, { prefix: "/scan" });
await app.register(statsRoutes, { prefix: "/stats" });
await app.register(relatorioRoutes, { prefix: "/relatorio" });

// Graceful shutdown — fecha Prisma ao parar o servidor
app.addHook("onClose", async () => {
    await prisma.$disconnect();
});

// Iniciar servidor
try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    console.log(
        `remove-duplicidade-localizacao rodando em http://localhost:${env.PORT}`
    );
} catch (err) {
    app.log.error(err);
    process.exit(1);
}

export default app;

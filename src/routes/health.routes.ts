import { FastifyInstance } from "fastify";

// Rota de health check
export async function healthRoutes(app: FastifyInstance) {
    app.get("/health", async () => {
        return {
            status: "ok",
            service: "remove-duplicidade-localizacao",
            version: "0.1.0",
            uptime: process.uptime(),
        };
    });
}

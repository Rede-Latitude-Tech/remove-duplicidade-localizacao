import { FastifyInstance } from "fastify";
import { deteccaoService } from "../services/deteccao.service.js";
import { prisma } from "../config/database.js";

// Rotas de detecção (scan) de duplicatas
export async function scanRoutes(app: FastifyInstance) {
    // POST /scan — enfileira job de detecção batch (async)
    app.post("/", async (request, reply) => {
        const { tipo } = request.body as { tipo?: number };

        // Por enquanto executa síncrono — BullMQ será adicionado na Fase 8
        const resultado = await deteccaoService.executarDeteccao(tipo ?? null);
        return resultado;
    });

    // POST /scan/sync — executa detecção síncrona (para debug/teste)
    app.post("/sync", async (request, reply) => {
        const { tipo, parentId } = request.body as {
            tipo: number;
            parentId?: string;
        };

        if (!tipo) {
            return reply
                .status(400)
                .send({ erro: "tipo é obrigatório (2=Bairro, 3=Logradouro, 4=Condominio)" });
        }

        const grupos = await deteccaoService.detectarPorTipo(
            tipo,
            parentId ?? null
        );
        return { grupos, total: grupos.length };
    });

    // GET /scan/historico — lista execuções anteriores
    app.get("/historico", async (request, reply) => {
        const historico = await prisma.ms_execucao_log.findMany({
            orderBy: { data_execucao: "desc" },
            take: 20,
        });
        return { data: historico };
    });
}

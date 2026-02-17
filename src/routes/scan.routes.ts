import { FastifyInstance } from "fastify";
import { deteccaoService } from "../services/deteccao.service.js";
import { enriquecimentoService } from "../services/enriquecimento.service.js";
import { prisma } from "../config/database.js";

// Rotas de detecção (scan) e enriquecimento de duplicatas
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

    // POST /scan/enriquecer — enriquece todos os grupos pendentes que ainda não têm nome_oficial
    // Busca grupos sem enriquecimento e processa em lotes de 10
    app.post("/enriquecer", async (request, reply) => {
        const gruposSemEnriquecimento = await prisma.ms_grupo_duplicata.findMany({
            where: {
                nome_oficial: null,
                status: 1, // Pendente
            },
            select: { id: true },
        });

        const ids = gruposSemEnriquecimento.map((g) => g.id);
        const totalGrupos = ids.length;

        if (totalGrupos === 0) {
            return { mensagem: "Todos os grupos já estão enriquecidos", total: 0 };
        }

        console.log(`[Enriquecer Batch] Iniciando enriquecimento de ${totalGrupos} grupo(s)...`);

        // Processa em lotes de 10 para não sobrecarregar APIs externas
        const LOTE = 10;
        let processados = 0;

        for (let i = 0; i < ids.length; i += LOTE) {
            const lote = ids.slice(i, i + LOTE);
            await enriquecimentoService.enriquecer(lote);
            processados += lote.length;
            console.log(`[Enriquecer Batch] Progresso: ${processados}/${totalGrupos}`);
        }

        console.log(`[Enriquecer Batch] Concluído — ${totalGrupos} grupo(s) enriquecidos`);
        return { mensagem: `${totalGrupos} grupo(s) enriquecidos`, total: totalGrupos };
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

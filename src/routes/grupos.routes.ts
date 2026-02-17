import { FastifyInstance } from "fastify";
import { prisma } from "../config/database.js";
import { StatusGrupo } from "../types/index.js";
import { impactoService } from "../services/impacto.service.js";

// Rotas de listagem e detalhe de grupos de duplicatas
export async function gruposRoutes(app: FastifyInstance) {
    // GET /grupos — lista grupos de duplicatas com filtros
    app.get("/", async (request, reply) => {
        const { tipo, status, pagina, tamanhoPagina } = request.query as {
            tipo?: string;
            status?: string;
            pagina?: string;
            tamanhoPagina?: string;
        };

        const page = parseInt(pagina ?? "1");
        const size = parseInt(tamanhoPagina ?? "20");

        // Monta filtro dinâmico
        const where: Record<string, unknown> = {};
        if (tipo) where.tipo_entidade = parseInt(tipo);
        if (status) where.status = parseInt(status);
        else where.status = StatusGrupo.Pendente; // padrão: apenas pendentes

        const [data, total] = await Promise.all([
            prisma.ms_grupo_duplicata.findMany({
                where,
                orderBy: { data_criacao: "desc" },
                skip: (page - 1) * size,
                take: size,
            }),
            prisma.ms_grupo_duplicata.count({ where }),
        ]);

        return { data, total };
    });

    // GET /grupos/:id — detalhe de um grupo com membros e impacto
    app.get("/:id", async (request, reply) => {
        const { id } = request.params as { id: string };

        const grupo = await prisma.ms_grupo_duplicata.findUnique({
            where: { id },
            include: { logs: true },
        });

        if (!grupo) {
            return reply.status(404).send({ erro: "Grupo não encontrado" });
        }

        // Calcula impacto por membro (contagem de FKs)
        const membros = await impactoService.calcularImpactoGrupo(
            grupo.tipo_entidade,
            grupo.registro_ids,
            grupo.nomes_membros
        );

        return { grupo, membros };
    });

    // GET /grupos/:id/impacto — contagem detalhada de impacto por membro
    app.get("/:id/impacto", async (request, reply) => {
        const { id } = request.params as { id: string };

        const grupo = await prisma.ms_grupo_duplicata.findUnique({
            where: { id },
        });

        if (!grupo) {
            return reply.status(404).send({ erro: "Grupo não encontrado" });
        }

        const membros = await impactoService.calcularImpactoGrupo(
            grupo.tipo_entidade,
            grupo.registro_ids,
            grupo.nomes_membros
        );

        return { membros };
    });
}

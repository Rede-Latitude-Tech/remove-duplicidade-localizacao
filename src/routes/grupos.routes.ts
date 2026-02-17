import { FastifyInstance } from "fastify";
import { prisma } from "../config/database.js";
import { StatusGrupo } from "../types/index.js";
import { impactoService } from "../services/impacto.service.js";

// Rotas de listagem e detalhe de grupos de duplicatas
export async function gruposRoutes(app: FastifyInstance) {
    // GET /grupos — lista grupos de duplicatas com filtros (tipo, status, parentId, busca)
    app.get("/", async (request, reply) => {
        const { tipo, status, pagina, tamanhoPagina, parentId, busca } = request.query as {
            tipo?: string;
            status?: string;
            pagina?: string;
            tamanhoPagina?: string;
            parentId?: string;  // Filtro por cidade (parent_id)
            busca?: string;     // Busca por nome
        };

        const page = parseInt(pagina ?? "1");
        const size = parseInt(tamanhoPagina ?? "20");

        // Monta filtro dinâmico
        const where: Record<string, unknown> = {};
        if (tipo) where.tipo_entidade = parseInt(tipo);
        if (status) where.status = parseInt(status);
        else where.status = StatusGrupo.Pendente; // padrão: apenas pendentes
        if (parentId) where.parent_id = parentId;  // Filtra por cidade
        if (busca) where.nome_normalizado = { contains: busca.toLowerCase() };

        const [data, total] = await Promise.all([
            prisma.ms_grupo_duplicata.findMany({
                where,
                orderBy: { data_criacao: "desc" },
                skip: (page - 1) * size,
                take: size,
            }),
            prisma.ms_grupo_duplicata.count({ where }),
        ]);

        // Preenche parent_nome com o nome da cidade via SQL (bairros e logradouros têm parent_id numérico = cidade_id)
        const parentIds = [...new Set(data.map((g) => g.parent_id).filter(Boolean))];
        // Filtra apenas IDs numéricos (condomínios têm UUID como parent_id)
        const parentIdsNumericos = parentIds.filter((id) => /^\d+$/.test(id!));
        let cidadeNomes: Record<string, string> = {};
        if (parentIdsNumericos.length > 0) {
            try {
                const cidades = await prisma.$queryRawUnsafe<Array<{ id: string; nome: string }>>(
                    `SELECT id::text, nome FROM cidade WHERE id = ANY($1::int[])`,
                    parentIdsNumericos.map((id) => parseInt(id!, 10))
                );
                cidadeNomes = Object.fromEntries(cidades.map((c) => [c.id, c.nome]));
            } catch {
                // Ignora erro inesperado
            }
        }

        // Anexa parent_nome a cada grupo
        const dataComNome = data.map((g) => ({
            ...g,
            parent_nome: g.parent_id ? cidadeNomes[g.parent_id] ?? null : null,
        }));

        return { data: dataComNome, total };
    });

    // GET /grupos/:id — detalhe de um grupo com membros, impacto e contexto hierárquico
    app.get("/:id", async (request, reply) => {
        const { id } = request.params as { id: string };

        // Busca grupo com contextos dos membros (ms_membro_contexto)
        const grupo = await prisma.ms_grupo_duplicata.findUnique({
            where: { id },
            include: {
                logs: true,
                contextos: true,
            },
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

        // Anexa contexto hierárquico a cada membro (match por registro_id)
        const membrosComContexto = membros.map((membro) => {
            const ctx = grupo.contextos.find((c) => c.registro_id === membro.id);
            return {
                ...membro,
                contexto: ctx
                    ? {
                          cidade_nome: ctx.cidade_nome,
                          cidade_id: ctx.cidade_id,
                          estado_sigla: ctx.estado_sigla,
                          bairro_nome: ctx.bairro_nome,
                          bairro_id: ctx.bairro_id,
                          logradouro_nome: ctx.logradouro_nome,
                          logradouro_id: ctx.logradouro_id,
                          ceps: ctx.ceps,
                          total_logradouros: ctx.total_logradouros,
                          total_condominios: ctx.total_condominios,
                          total_bairros: ctx.total_bairros,
                      }
                    : null,
            };
        });

        // Remove o array de contextos cru do grupo (já está nos membros)
        const { contextos: _, ...grupoLimpo } = grupo;

        return { grupo: grupoLimpo, membros: membrosComContexto };
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

import { FastifyInstance } from "fastify";
import { prisma } from "../config/database.js";
import { StatusGrupo, TipoEntidade } from "../types/index.js";

// Rotas de estatísticas e dashboard
export async function statsRoutes(app: FastifyInstance) {
    // GET /stats — resumo geral para o dashboard
    app.get("/", async () => {
        // Conta grupos por status e tipo em paralelo
        const [
            pendentes,
            executados,
            bairros,
            logradouros,
            condominios,
            cidades,
            ultimaExecucao,
        ] = await Promise.all([
            prisma.ms_grupo_duplicata.count({
                where: { status: StatusGrupo.Pendente },
            }),
            prisma.ms_grupo_duplicata.count({
                where: { status: StatusGrupo.Executado },
            }),
            prisma.ms_grupo_duplicata.count({
                where: {
                    tipo_entidade: TipoEntidade.Bairro,
                    status: StatusGrupo.Pendente,
                },
            }),
            prisma.ms_grupo_duplicata.count({
                where: {
                    tipo_entidade: TipoEntidade.Logradouro,
                    status: StatusGrupo.Pendente,
                },
            }),
            prisma.ms_grupo_duplicata.count({
                where: {
                    tipo_entidade: TipoEntidade.Condominio,
                    status: StatusGrupo.Pendente,
                },
            }),
            prisma.ms_grupo_duplicata.count({
                where: {
                    tipo_entidade: TipoEntidade.Cidade,
                    status: StatusGrupo.Pendente,
                },
            }),
            prisma.ms_execucao_log.findFirst({
                orderBy: { data_execucao: "desc" },
            }),
        ]);

        // Total de registros unificados (soma dos logs de merge)
        const totalRegistrosUnificados = await prisma.ms_merge_log.count({
            where: { revertido: false },
        });

        // Conta grupos auto-aprováveis: pendentes com sugestão + nome oficial + IA confiança >= 90%
        const candidatosAuto = await prisma.ms_grupo_duplicata.findMany({
            where: {
                status: StatusGrupo.Pendente,
                canonico_sugerido_id: { not: null },
                nome_oficial: { not: null },
                detalhes_llm: { not: null },
            },
            select: { detalhes_llm: true },
        });
        let totalAutoAprovaveis = 0;
        for (const g of candidatosAuto) {
            try {
                const llm = JSON.parse(g.detalhes_llm!);
                if (llm.saoDuplicatas === true && typeof llm.confianca === "number" && llm.confianca >= 0.90) {
                    totalAutoAprovaveis++;
                }
            } catch { /* ignora */ }
        }

        return {
            totalGruposPendentes: pendentes,
            totalMergesExecutados: executados,
            totalRegistrosUnificados,
            totalAutoAprovaveis, // Grupos seguros para auto-aprovação (IA >= 90% + nome oficial)
            porTipo: { bairros, logradouros, condominios, cidades },
            ultimaDeteccao: ultimaExecucao?.data_execucao ?? null,
        };
    });

    // GET /stats/ranking-cidades — ranking de cidades com mais grupos de duplicatas pendentes
    app.get("/ranking-cidades", async () => {
        // Agrupa por parent_id (cidade) e conta grupos pendentes
        const ranking = await prisma.$queryRawUnsafe<
            Array<{
                parent_id: string;
                cidade_nome: string;
                estado_sigla: string;
                total_grupos: bigint;
                total_bairros: bigint;
                total_logradouros: bigint;
                total_condominios: bigint;
            }>
        >(`
            SELECT
                g.parent_id,
                c.nome as cidade_nome,
                c.estado_id as estado_sigla,
                COUNT(*) as total_grupos,
                COUNT(*) FILTER (WHERE g.tipo_entidade = 2) as total_bairros,
                COUNT(*) FILTER (WHERE g.tipo_entidade = 3) as total_logradouros,
                0::bigint as total_condominios
            FROM ms_grupo_duplicata g
            JOIN cidade c ON c.id = g.parent_id::int
            WHERE g.status = 1
            AND g.parent_id IS NOT NULL
            AND g.tipo_entidade IN (2, 3)
            AND g.parent_id ~ '^[0-9]{1,9}$'
            GROUP BY g.parent_id, c.nome, c.estado_id
            ORDER BY COUNT(*) DESC
            LIMIT 50
        `);

        return {
            data: ranking.map((r) => ({
                parentId: r.parent_id,
                cidadeNome: r.cidade_nome,
                estadoSigla: r.estado_sigla,
                totalGrupos: Number(r.total_grupos),
                totalBairros: Number(r.total_bairros),
                totalLogradouros: Number(r.total_logradouros),
                totalCondominios: Number(r.total_condominios),
            })),
        };
    });

    // GET /stats/cidades — lista cidades que têm grupos (para dropdown de filtro)
    app.get("/cidades", async () => {
        const cidades = await prisma.$queryRawUnsafe<
            Array<{ parent_id: string; cidade_nome: string; estado_sigla: string; total: bigint }>
        >(`
            SELECT
                g.parent_id,
                c.nome as cidade_nome,
                c.estado_id as estado_sigla,
                COUNT(*) as total
            FROM ms_grupo_duplicata g
            JOIN cidade c ON c.id = g.parent_id::int
            WHERE g.status = 1
            AND g.parent_id IS NOT NULL
            AND g.tipo_entidade IN (2, 3)
            AND g.parent_id ~ '^[0-9]{1,9}$'
            GROUP BY g.parent_id, c.nome, c.estado_id
            ORDER BY c.nome
        `);

        return {
            data: cidades.map((c) => ({
                id: c.parent_id,
                nome: `${c.cidade_nome} - ${c.estado_sigla}`,
                total: Number(c.total),
            })),
        };
    });
}

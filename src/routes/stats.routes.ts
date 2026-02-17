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

        return {
            totalGruposPendentes: pendentes,
            totalMergesExecutados: executados,
            totalRegistrosUnificados,
            porTipo: { bairros, logradouros, condominios, cidades },
            ultimaDeteccao: ultimaExecucao?.data_execucao ?? null,
        };
    });
}

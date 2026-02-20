import { FastifyInstance } from "fastify";
import { prisma } from "../config/database.js";
import { StatusGrupo, TipoEntidade, TIPO_ENTIDADE_LABEL } from "../types/index.js";

// Labels legíveis para cada tabela afetada no merge_log
const TABELA_LABEL: Record<string, string> = {
    bairro: "Bairros",
    logradouro: "Logradouros",
    condominio: "Condomínios",
    cidade: "Cidades",
    imovel: "Imóveis",
    imovel_endereco: "Endereços de imóveis",
    empresa: "Empresas",
    pessoa: "Pessoas",
    pessoa_fisica: "Pessoas físicas",
    building: "Buildings",
    building_address: "Endereços de building",
    property_drafts: "Rascunhos de imóveis",
    property_draft_addresses: "Endereços de rascunhos",
    benfeitoria_condominio: "Benfeitorias de condomínio",
    condominio_imagem: "Imagens de condomínio",
};

// Mapeia coluna FK → tabela de lookup para resolver IDs → nomes
const COLUNA_TABELA_LOOKUP: Record<string, { tabela: string; tipoId: "uuid" | "int" }> = {
    bairro_comercial_id: { tabela: "bairro", tipoId: "uuid" },
    bairro_id: { tabela: "bairro", tipoId: "uuid" },
    logradouro_id: { tabela: "logradouro", tipoId: "uuid" },
    condominio_id: { tabela: "condominio", tipoId: "uuid" },
    condominios_id: { tabela: "condominio", tipoId: "uuid" },
    cidade_id: { tabela: "cidade", tipoId: "int" },
    naturalidade_id: { tabela: "cidade", tipoId: "int" },
    endereco_logradouro_id: { tabela: "logradouro", tipoId: "uuid" },
};

// Rotas de relatório de auditoria — mostra impacto completo das unificações
export async function relatorioRoutes(app: FastifyInstance) {
    // GET /relatorio/resumo — resumo geral para os cards do topo da página
    app.get("/resumo", async () => {
        const [bairros, logradouros, condominios, cidades] = await Promise.all([
            prisma.ms_grupo_duplicata.count({
                where: { status: StatusGrupo.Executado, tipo_entidade: TipoEntidade.Bairro },
            }),
            prisma.ms_grupo_duplicata.count({
                where: { status: StatusGrupo.Executado, tipo_entidade: TipoEntidade.Logradouro },
            }),
            prisma.ms_grupo_duplicata.count({
                where: { status: StatusGrupo.Executado, tipo_entidade: TipoEntidade.Condominio },
            }),
            prisma.ms_grupo_duplicata.count({
                where: { status: StatusGrupo.Executado, tipo_entidade: TipoEntidade.Cidade },
            }),
        ]);

        const totalGruposExecutados = bairros + logradouros + condominios + cidades;

        // Total de registros afetados POR TABELA (todas as tabelas, não só imóveis)
        const impactoPorTabela = await prisma.$queryRawUnsafe<
            Array<{ tabela_afetada: string; total: bigint }>
        >(`
            SELECT ml.tabela_afetada, COUNT(DISTINCT ml.registro_afetado_id) as total
            FROM ms_merge_log ml
            JOIN ms_grupo_duplicata g ON g.id = ml.grupo_id
            WHERE g.status = ${StatusGrupo.Executado}
            AND ml.revertido = false
            GROUP BY ml.tabela_afetada
            ORDER BY total DESC
        `);

        // Total geral de FKs redirecionadas
        const totalFksResult = await prisma.$queryRawUnsafe<[{ total: bigint }]>(`
            SELECT COUNT(*) as total
            FROM ms_merge_log ml
            JOIN ms_grupo_duplicata g ON g.id = ml.grupo_id
            WHERE g.status = ${StatusGrupo.Executado} AND ml.revertido = false
        `);

        return {
            totalGruposExecutados,
            totalFksRedirecionadas: Number(totalFksResult[0]?.total ?? 0),
            porTipo: { bairros, logradouros, condominios, cidades },
            impactoPorTabela: impactoPorTabela.map((r) => ({
                tabela: r.tabela_afetada,
                label: TABELA_LABEL[r.tabela_afetada] ?? r.tabela_afetada,
                totalRegistros: Number(r.total),
            })),
        };
    });

    // GET /relatorio/por-empresa — tabela de impacto agregado por empresa
    // Inclui tanto imóveis quanto alterações diretas na tabela empresa
    app.get("/por-empresa", async () => {
        const resultado = await prisma.$queryRawUnsafe<
            Array<{
                empresa_id: string;
                empresa_nome: string;
                total_imoveis: bigint;
                total_alteracoes_diretas: bigint;
                total_grupos: bigint;
                bairros: bigint;
                logradouros: bigint;
                condominios: bigint;
                cidades: bigint;
            }>
        >(`
            WITH imoveis_afetados AS (
                SELECT DISTINCT
                    COALESCE(i.empresa_id, i2.empresa_id) as empresa_id,
                    COALESCE(i.id, i2.id) as imovel_id,
                    g.id as grupo_id,
                    g.tipo_entidade
                FROM ms_merge_log ml
                JOIN ms_grupo_duplicata g ON g.id = ml.grupo_id
                LEFT JOIN imovel i ON i.id = ml.registro_afetado_id::uuid AND ml.tabela_afetada = 'imovel'
                LEFT JOIN imovel_endereco ie ON ie.imovel_id = ml.registro_afetado_id::uuid AND ml.tabela_afetada = 'imovel_endereco'
                LEFT JOIN imovel i2 ON i2.id = ie.imovel_id
                WHERE g.status = ${StatusGrupo.Executado}
                AND ml.revertido = false
                AND ml.tabela_afetada IN ('imovel', 'imovel_endereco')
                AND COALESCE(i.empresa_id, i2.empresa_id) IS NOT NULL
            ),
            empresas_diretas AS (
                SELECT DISTINCT
                    ml.registro_afetado_id::uuid as empresa_id,
                    g.id as grupo_id,
                    g.tipo_entidade
                FROM ms_merge_log ml
                JOIN ms_grupo_duplicata g ON g.id = ml.grupo_id
                WHERE g.status = ${StatusGrupo.Executado}
                AND ml.revertido = false
                AND ml.tabela_afetada = 'empresa'
            ),
            tudo AS (
                SELECT empresa_id, imovel_id, grupo_id, tipo_entidade, 'imovel' as via
                FROM imoveis_afetados
                UNION ALL
                SELECT empresa_id, NULL, grupo_id, tipo_entidade, 'direto'
                FROM empresas_diretas
            )
            SELECT
                e.id as empresa_id,
                COALESCE(e.nome_fantasia, e.nome) as empresa_nome,
                COUNT(DISTINCT t.imovel_id) FILTER (WHERE t.via = 'imovel') as total_imoveis,
                COUNT(DISTINCT t.grupo_id) FILTER (WHERE t.via = 'direto') as total_alteracoes_diretas,
                COUNT(DISTINCT t.grupo_id) as total_grupos,
                COUNT(DISTINCT t.grupo_id) FILTER (WHERE t.tipo_entidade = ${TipoEntidade.Bairro}) as bairros,
                COUNT(DISTINCT t.grupo_id) FILTER (WHERE t.tipo_entidade = ${TipoEntidade.Logradouro}) as logradouros,
                COUNT(DISTINCT t.grupo_id) FILTER (WHERE t.tipo_entidade = ${TipoEntidade.Condominio}) as condominios,
                COUNT(DISTINCT t.grupo_id) FILTER (WHERE t.tipo_entidade = ${TipoEntidade.Cidade}) as cidades
            FROM tudo t
            JOIN empresa e ON e.id = t.empresa_id
            GROUP BY e.id, e.nome_fantasia, e.nome
            ORDER BY total_grupos DESC
        `);

        return {
            data: resultado.map((r) => ({
                empresaId: r.empresa_id,
                empresaNome: r.empresa_nome,
                totalImoveis: Number(r.total_imoveis),
                totalAlteracoesDiretas: Number(r.total_alteracoes_diretas),
                totalGrupos: Number(r.total_grupos),
                bairros: Number(r.bairros),
                logradouros: Number(r.logradouros),
                condominios: Number(r.condominios),
                cidades: Number(r.cidades),
            })),
        };
    });

    // GET /relatorio/grupos-executados — lista paginada de grupos executados
    // Cada grupo mostra breakdown de TODAS as tabelas afetadas (não só imóveis)
    app.get("/grupos-executados", async (request) => {
        const { pagina, tamanhoPagina, tipo, empresaId, busca } = request.query as {
            pagina?: string;
            tamanhoPagina?: string;
            tipo?: string;
            empresaId?: string;
            busca?: string;
        };

        const page = parseInt(pagina ?? "1");
        const size = parseInt(tamanhoPagina ?? "20");
        const offset = (page - 1) * size;

        const conditions: string[] = [`g.status = ${StatusGrupo.Executado}`];
        const params: unknown[] = [];
        let paramIndex = 1;

        if (tipo) {
            conditions.push(`g.tipo_entidade = $${paramIndex}`);
            params.push(parseInt(tipo));
            paramIndex++;
        }

        if (busca && busca.trim()) {
            conditions.push(`(
                unaccent(COALESCE(g.nome_canonico, g.nome_normalizado)) ILIKE '%' || unaccent($${paramIndex}) || '%'
                OR EXISTS (
                    SELECT 1 FROM unnest(g.nomes_membros) AS m
                    WHERE unaccent(m) ILIKE '%' || unaccent($${paramIndex}) || '%'
                )
            )`);
            params.push(busca.trim());
            paramIndex++;
        }

        // Filtro por empresa — agora inclui imóveis E alterações diretas na empresa
        let empresaJoin = "";
        if (empresaId) {
            empresaJoin = `
                JOIN ms_merge_log ml_filter ON ml_filter.grupo_id = g.id AND ml_filter.revertido = false
                LEFT JOIN imovel i_filter ON i_filter.id = ml_filter.registro_afetado_id::uuid
                    AND ml_filter.tabela_afetada = 'imovel'
                LEFT JOIN imovel_endereco ie_filter ON ie_filter.imovel_id = ml_filter.registro_afetado_id::uuid
                    AND ml_filter.tabela_afetada = 'imovel_endereco'
                LEFT JOIN imovel i2_filter ON i2_filter.id = ie_filter.imovel_id
            `;
            conditions.push(`(
                COALESCE(i_filter.empresa_id, i2_filter.empresa_id) = $${paramIndex}::uuid
                OR (ml_filter.tabela_afetada = 'empresa' AND ml_filter.registro_afetado_id = $${paramIndex})
            )`);
            params.push(empresaId);
            paramIndex++;
        }

        const whereClause = conditions.join(" AND ");

        // Query principal — contagem por tabela afetada via JSON aggregation
        const grupos = await prisma.$queryRawUnsafe<
            Array<{
                id: string;
                tipo_entidade: number;
                nome_normalizado: string;
                nome_canonico: string | null;
                nomes_membros: string[];
                registro_ids: string[];
                registro_canonico_id: string | null;
                data_execucao: Date | null;
                total_registros_afetados: number;
                executado_por: string | null;
                impacto_json: string;
            }>
        >(
            `SELECT
                g.id,
                g.tipo_entidade,
                g.nome_normalizado,
                g.nome_canonico,
                g.nomes_membros,
                g.registro_ids,
                g.registro_canonico_id,
                g.data_execucao,
                g.total_registros_afetados,
                g.executado_por,
                COALESCE(
                    (SELECT json_agg(json_build_object(
                        'tabela', sub.tabela_afetada,
                        'total', sub.cnt
                    ))
                    FROM (
                        SELECT ml2.tabela_afetada, COUNT(DISTINCT ml2.registro_afetado_id) as cnt
                        FROM ms_merge_log ml2
                        WHERE ml2.grupo_id = g.id AND ml2.revertido = false
                        GROUP BY ml2.tabela_afetada
                    ) sub),
                    '[]'::json
                )::text as impacto_json
            FROM ms_grupo_duplicata g
            ${empresaJoin}
            WHERE ${whereClause}
            GROUP BY g.id
            ORDER BY g.data_execucao DESC NULLS LAST
            LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
            ...params,
            size,
            offset
        );

        const totalResult = await prisma.$queryRawUnsafe<[{ total: bigint }]>(
            `SELECT COUNT(DISTINCT g.id) as total
            FROM ms_grupo_duplicata g
            ${empresaJoin}
            WHERE ${whereClause}`,
            ...params
        );

        return {
            data: grupos.map((g) => {
                // Parse impacto por tabela
                let impactoPorTabela: Array<{ tabela: string; label: string; total: number }> = [];
                try {
                    const raw = JSON.parse(g.impacto_json) as Array<{ tabela: string; total: number }>;
                    impactoPorTabela = raw.map((r) => ({
                        tabela: r.tabela,
                        label: TABELA_LABEL[r.tabela] ?? r.tabela,
                        total: Number(r.total),
                    }));
                } catch { /* fallback vazio */ }

                return {
                    id: g.id,
                    tipoEntidade: g.tipo_entidade,
                    tipoLabel: TIPO_ENTIDADE_LABEL[g.tipo_entidade as TipoEntidade] ?? "Desconhecido",
                    nomeNormalizado: g.nome_normalizado,
                    nomeCanonico: g.nome_canonico,
                    nomesMembros: g.nomes_membros,
                    registroIds: g.registro_ids,
                    registroCanonicoId: g.registro_canonico_id,
                    dataExecucao: g.data_execucao?.toISOString() ?? null,
                    totalRegistrosAfetados: g.total_registros_afetados,
                    executadoPor: g.executado_por,
                    impactoPorTabela,
                    totalFks: impactoPorTabela.reduce((sum, t) => sum + t.total, 0),
                };
            }),
            total: Number(totalResult[0]?.total ?? 0),
        };
    });

    // GET /relatorio/grupo/:id/detalhes — TODOS os registros afetados por um grupo
    // Organizado por tabela, com resolução de nomes para IDs de entidades
    app.get("/grupo/:id/detalhes", async (request) => {
        const { id } = request.params as { id: string };

        // Busca TODOS os merge_log do grupo (não só imóveis)
        const logs = await prisma.$queryRawUnsafe<
            Array<{
                id: string;
                tabela_afetada: string;
                registro_afetado_id: string;
                coluna_alterada: string;
                valor_anterior: string;
                valor_novo: string;
                data_execucao: Date;
                revertido: boolean;
            }>
        >(
            `SELECT ml.id, ml.tabela_afetada, ml.registro_afetado_id,
                    ml.coluna_alterada, ml.valor_anterior, ml.valor_novo,
                    ml.data_execucao, ml.revertido
             FROM ms_merge_log ml
             WHERE ml.grupo_id = $1::uuid
             ORDER BY ml.tabela_afetada, ml.registro_afetado_id`,
            id
        );

        if (logs.length === 0) {
            return { data: [], porTabela: [], grupo: null };
        }

        // Busca info do grupo
        const grupo = await prisma.ms_grupo_duplicata.findUnique({
            where: { id },
            select: {
                id: true,
                tipo_entidade: true,
                nome_normalizado: true,
                nome_canonico: true,
                nomes_membros: true,
                registro_ids: true,
                registro_canonico_id: true,
                status: true,
                data_execucao: true,
                executado_por: true,
                total_registros_afetados: true,
            },
        });

        // Resolve IDs de entidades → nomes (bairro, logradouro, condomínio, cidade)
        const idsPorLookup: Record<string, Set<string>> = {};
        for (const log of logs) {
            const lookup = COLUNA_TABELA_LOOKUP[log.coluna_alterada];
            if (!lookup) continue;
            const key = `${lookup.tabela}:${lookup.tipoId}`;
            if (!idsPorLookup[key]) idsPorLookup[key] = new Set();
            idsPorLookup[key].add(log.valor_anterior);
            idsPorLookup[key].add(log.valor_novo);
        }

        const nomesPorId: Record<string, string> = {};
        await Promise.all(
            Object.entries(idsPorLookup).map(async ([key, idsSet]) => {
                const [tabela, tipoId] = key.split(":");
                const ids = [...idsSet].filter(Boolean);
                if (ids.length === 0) return;
                try {
                    const cast = tipoId === "int" ? "bigint[]" : "uuid[]";
                    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; nome: string }>>(
                        `SELECT id::text, nome FROM ${tabela} WHERE id = ANY($1::${cast})`,
                        ids
                    );
                    for (const row of rows) {
                        nomesPorId[row.id] = row.nome;
                    }
                } catch {
                    // Ignora (tabela pode não ter coluna nome, ou IDs inválidos)
                }
            })
        );

        // Resolve nomes de registros afetados onde possível
        // Ex: para imovel, buscar titulo_amigavel; para pessoa, buscar nome; para empresa, buscar nome_fantasia
        const registrosPorTabela: Record<string, Set<string>> = {};
        for (const log of logs) {
            if (!registrosPorTabela[log.tabela_afetada]) registrosPorTabela[log.tabela_afetada] = new Set();
            registrosPorTabela[log.tabela_afetada].add(log.registro_afetado_id);
        }

        const TABELA_NOME_QUERY: Record<string, { colunaNome: string; pkColuna: string; cast: string }> = {
            imovel: { colunaNome: "titulo_amigavel", pkColuna: "id", cast: "uuid[]" },
            empresa: { colunaNome: "COALESCE(nome_fantasia, nome)", pkColuna: "id", cast: "uuid[]" },
            pessoa: { colunaNome: "nome", pkColuna: "id", cast: "uuid[]" },
            pessoa_fisica: { colunaNome: "nome", pkColuna: "pessoa_id", cast: "uuid[]" },
            bairro: { colunaNome: "nome", pkColuna: "id", cast: "uuid[]" },
            logradouro: { colunaNome: "nome", pkColuna: "id", cast: "uuid[]" },
            condominio: { colunaNome: "nome", pkColuna: "id", cast: "uuid[]" },
            building: { colunaNome: "nome", pkColuna: "id", cast: "uuid[]" },
        };

        const nomesRegistro: Record<string, string> = {};
        await Promise.all(
            Object.entries(registrosPorTabela).map(async ([tabela, idsSet]) => {
                const config = TABELA_NOME_QUERY[tabela];
                if (!config) return;
                const ids = [...idsSet].filter(Boolean);
                if (ids.length === 0) return;
                try {
                    const rows = await prisma.$queryRawUnsafe<Array<{ pk: string; nome: string }>>(
                        `SELECT ${config.pkColuna}::text as pk, ${config.colunaNome} as nome
                         FROM ${tabela}
                         WHERE ${config.pkColuna} = ANY($1::${config.cast})`,
                        ids
                    );
                    for (const row of rows) {
                        nomesRegistro[`${tabela}:${row.pk}`] = row.nome;
                    }
                } catch {
                    // Ignora
                }
            })
        );

        // Agrupa por tabela para exibição organizada
        const porTabela: Record<string, Array<{
            logId: string;
            registroAfetadoId: string;
            registroNome: string | null;
            colunaAlterada: string;
            valorAnterior: string;
            valorNovo: string;
            nomeAnterior: string | null;
            nomeNovo: string | null;
            revertido: boolean;
        }>> = {};

        for (const log of logs) {
            if (!porTabela[log.tabela_afetada]) porTabela[log.tabela_afetada] = [];
            porTabela[log.tabela_afetada].push({
                logId: log.id,
                registroAfetadoId: log.registro_afetado_id,
                registroNome: nomesRegistro[`${log.tabela_afetada}:${log.registro_afetado_id}`] ?? null,
                colunaAlterada: log.coluna_alterada,
                valorAnterior: log.valor_anterior,
                valorNovo: log.valor_novo,
                nomeAnterior: nomesPorId[log.valor_anterior] ?? null,
                nomeNovo: nomesPorId[log.valor_novo] ?? null,
                revertido: log.revertido,
            });
        }

        // Transforma em array ordenado
        const tabelasAfetadas = Object.entries(porTabela).map(([tabela, registros]) => ({
            tabela,
            label: TABELA_LABEL[tabela] ?? tabela,
            totalRegistros: registros.length,
            registros,
        })).sort((a, b) => b.totalRegistros - a.totalRegistros);

        return {
            grupo: grupo ? {
                ...grupo,
                tipoLabel: TIPO_ENTIDADE_LABEL[grupo.tipo_entidade as TipoEntidade] ?? "Desconhecido",
                dataExecucao: grupo.data_execucao?.toISOString() ?? null,
            } : null,
            totalAlteracoes: logs.length,
            totalRevertidas: logs.filter((l) => l.revertido).length,
            porTabela: tabelasAfetadas,
        };
    });

    // GET /relatorio/grupo/:id/imoveis — MANTIDO para retrocompatibilidade
    // Redireciona para /detalhes (que é mais completo)
    app.get("/grupo/:id/imoveis", async (request, reply) => {
        const { id } = request.params as { id: string };
        return reply.redirect(`/relatorio/grupo/${id}/detalhes`);
    });
}

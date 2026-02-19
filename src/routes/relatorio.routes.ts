import { FastifyInstance } from "fastify";
import { prisma } from "../config/database.js";
import { StatusGrupo, TipoEntidade, TIPO_ENTIDADE_LABEL } from "../types/index.js";

// Rotas de relatório de auditoria — mostra impacto das unificações em imóveis e empresas
export async function relatorioRoutes(app: FastifyInstance) {
    // GET /relatorio/resumo — resumo geral para os cards do topo da página
    // Retorna total de grupos executados por tipo, imóveis e empresas afetadas
    app.get("/resumo", async () => {
        // Conta grupos executados por tipo em paralelo
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

        // Total de grupos executados (soma de todos os tipos)
        const totalGruposExecutados = bairros + logradouros + condominios + cidades;

        // Total de imóveis afetados — conta registros distintos no merge_log
        // que apontam para tabelas de imóvel (imovel e imovel_endereco)
        const imoveisResult = await prisma.$queryRawUnsafe<[{ total: bigint }]>(`
            SELECT COUNT(DISTINCT ml.registro_afetado_id) as total
            FROM ms_merge_log ml
            JOIN ms_grupo_duplicata g ON g.id = ml.grupo_id
            WHERE g.status = ${StatusGrupo.Executado}
            AND ml.revertido = false
            AND ml.tabela_afetada IN ('imovel', 'imovel_endereco')
        `);

        // Total de empresas afetadas — rastreia via imovel.empresa_id
        // Faz JOIN com imovel para descobrir a empresa dona de cada imóvel afetado
        const empresasResult = await prisma.$queryRawUnsafe<[{ total: bigint }]>(`
            SELECT COUNT(DISTINCT i.empresa_id) as total
            FROM ms_merge_log ml
            JOIN ms_grupo_duplicata g ON g.id = ml.grupo_id
            LEFT JOIN imovel i ON i.id = ml.registro_afetado_id::uuid
            LEFT JOIN imovel_endereco ie ON ie.imovel_id = ml.registro_afetado_id::uuid
            LEFT JOIN imovel i2 ON i2.id = ie.imovel_id
            WHERE g.status = ${StatusGrupo.Executado}
            AND ml.revertido = false
            AND ml.tabela_afetada IN ('imovel', 'imovel_endereco')
            AND COALESCE(i.empresa_id, i2.empresa_id) IS NOT NULL
        `);

        return {
            totalGruposExecutados,
            porTipo: { bairros, logradouros, condominios, cidades },
            totalImoveisAfetados: Number(imoveisResult[0]?.total ?? 0),
            totalEmpresasAfetadas: Number(empresasResult[0]?.total ?? 0),
        };
    });

    // GET /relatorio/por-empresa — tabela de impacto agregado por empresa
    // Mostra quantos imóveis e grupos afetaram cada empresa
    app.get("/por-empresa", async () => {
        // Query agrega merge_log → imovel → empresa, contando imóveis e tipos por empresa
        const resultado = await prisma.$queryRawUnsafe<
            Array<{
                empresa_id: string;
                empresa_nome: string;
                total_imoveis: bigint;
                total_grupos: bigint;
                bairros: bigint;
                logradouros: bigint;
                condominios: bigint;
            }>
        >(`
            SELECT
                e.id as empresa_id,
                COALESCE(e.nome_fantasia, e.nome) as empresa_nome,
                COUNT(DISTINCT ml.registro_afetado_id) as total_imoveis,
                COUNT(DISTINCT g.id) as total_grupos,
                COUNT(DISTINCT g.id) FILTER (WHERE g.tipo_entidade = ${TipoEntidade.Bairro}) as bairros,
                COUNT(DISTINCT g.id) FILTER (WHERE g.tipo_entidade = ${TipoEntidade.Logradouro}) as logradouros,
                COUNT(DISTINCT g.id) FILTER (WHERE g.tipo_entidade = ${TipoEntidade.Condominio}) as condominios
            FROM ms_merge_log ml
            JOIN ms_grupo_duplicata g ON g.id = ml.grupo_id
            LEFT JOIN imovel i ON i.id = ml.registro_afetado_id::uuid AND ml.tabela_afetada = 'imovel'
            LEFT JOIN imovel_endereco ie ON ie.imovel_id = ml.registro_afetado_id::uuid AND ml.tabela_afetada = 'imovel_endereco'
            LEFT JOIN imovel i2 ON i2.id = ie.imovel_id
            JOIN empresa e ON e.id = COALESCE(i.empresa_id, i2.empresa_id)
            WHERE g.status = ${StatusGrupo.Executado}
            AND ml.revertido = false
            AND ml.tabela_afetada IN ('imovel', 'imovel_endereco')
            GROUP BY e.id, e.nome_fantasia, e.nome
            ORDER BY total_imoveis DESC
        `);

        return {
            data: resultado.map((r) => ({
                empresaId: r.empresa_id,
                empresaNome: r.empresa_nome,
                totalImoveis: Number(r.total_imoveis),
                totalGrupos: Number(r.total_grupos),
                bairros: Number(r.bairros),
                logradouros: Number(r.logradouros),
                condominios: Number(r.condominios),
            })),
        };
    });

    // GET /relatorio/grupos-executados — lista paginada de grupos executados
    // Suporta filtros por tipo e empresaId, com contagem de imóveis afetados por grupo
    app.get("/grupos-executados", async (request) => {
        const { pagina, tamanhoPagina, tipo, empresaId, busca } = request.query as {
            pagina?: string;
            tamanhoPagina?: string;
            tipo?: string;       // Filtro por tipo_entidade (1=Cidade, 2=Bairro, 3=Logradouro, 4=Condominio)
            empresaId?: string;  // Filtro por empresa (via merge_log → imovel)
            busca?: string;      // Busca por nome (ignora acentos e case)
        };

        const page = parseInt(pagina ?? "1");
        const size = parseInt(tamanhoPagina ?? "20");
        const offset = (page - 1) * size;

        // Monta cláusulas WHERE dinâmicas
        const conditions: string[] = [`g.status = ${StatusGrupo.Executado}`];
        const params: unknown[] = [];
        let paramIndex = 1;

        // Filtro por tipo de entidade
        if (tipo) {
            conditions.push(`g.tipo_entidade = $${paramIndex}`);
            params.push(parseInt(tipo));
            paramIndex++;
        }

        // Filtro por busca de nome — ignora acentos e case usando unaccent + ILIKE
        if (busca && busca.trim()) {
            conditions.push(`unaccent(COALESCE(g.nome_canonico, g.nome_normalizado)) ILIKE '%' || unaccent($${paramIndex}) || '%'`);
            params.push(busca.trim());
            paramIndex++;
        }

        // Filtro por empresa — requer JOIN com merge_log e imovel
        let empresaJoin = "";
        if (empresaId) {
            empresaJoin = `
                JOIN ms_merge_log ml_filter ON ml_filter.grupo_id = g.id AND ml_filter.revertido = false
                    AND ml_filter.tabela_afetada IN ('imovel', 'imovel_endereco')
                LEFT JOIN imovel i_filter ON i_filter.id = ml_filter.registro_afetado_id::uuid AND ml_filter.tabela_afetada = 'imovel'
                LEFT JOIN imovel_endereco ie_filter ON ie_filter.imovel_id = ml_filter.registro_afetado_id::uuid AND ml_filter.tabela_afetada = 'imovel_endereco'
                LEFT JOIN imovel i2_filter ON i2_filter.id = ie_filter.imovel_id
            `;
            conditions.push(`COALESCE(i_filter.empresa_id, i2_filter.empresa_id) = $${paramIndex}::uuid`);
            params.push(empresaId);
            paramIndex++;
        }

        const whereClause = conditions.join(" AND ");

        // Query principal — busca grupos com contagem de imóveis afetados via LEFT JOIN
        const grupos = await prisma.$queryRawUnsafe<
            Array<{
                id: string;
                tipo_entidade: number;
                nome_normalizado: string;
                nome_canonico: string | null;
                nomes_membros: string[];
                data_execucao: Date | null;
                total_registros_afetados: number;
                executado_por: string | null;
                total_imoveis: bigint;
            }>
        >(
            `SELECT
                g.id,
                g.tipo_entidade,
                g.nome_normalizado,
                g.nome_canonico,
                g.nomes_membros,
                g.data_execucao,
                g.total_registros_afetados,
                g.executado_por,
                COUNT(DISTINCT CASE
                    WHEN ml.tabela_afetada IN ('imovel','imovel_endereco') THEN ml.registro_afetado_id
                END) as total_imoveis
            FROM ms_grupo_duplicata g
            ${empresaJoin}
            LEFT JOIN ms_merge_log ml ON ml.grupo_id = g.id AND ml.revertido = false
            WHERE ${whereClause}
            GROUP BY g.id
            ORDER BY g.data_execucao DESC NULLS LAST
            LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
            ...params,
            size,
            offset
        );

        // Total de registros (para paginação)
        const totalResult = await prisma.$queryRawUnsafe<[{ total: bigint }]>(
            `SELECT COUNT(DISTINCT g.id) as total
            FROM ms_grupo_duplicata g
            ${empresaJoin}
            WHERE ${whereClause}`,
            ...params
        );

        return {
            data: grupos.map((g) => ({
                ...g,
                total_imoveis: Number(g.total_imoveis),
                // Formata data_execucao como ISO string
                data_execucao: g.data_execucao?.toISOString() ?? null,
            })),
            total: Number(totalResult[0]?.total ?? 0),
        };
    });

    // GET /relatorio/grupo/:id/imoveis — lista imóveis afetados por um grupo específico
    // Usado ao expandir uma linha na tabela de unificações realizadas
    // Resolve IDs de bairro/logradouro/condomínio para nomes legíveis
    app.get("/grupo/:id/imoveis", async (request, reply) => {
        const { id } = request.params as { id: string };

        // Busca imóveis afetados pelo grupo via merge_log, com dados da empresa
        const imoveis = await prisma.$queryRawUnsafe<
            Array<{
                imovel_id: string;
                titulo_amigavel: string | null;
                empresa_id: string;
                empresa_nome: string;
                coluna_alterada: string;
                valor_anterior: string;
                valor_novo: string;
            }>
        >(
            `SELECT DISTINCT
                COALESCE(i.id, i2.id) as imovel_id,
                COALESCE(i.titulo_amigavel, i2.titulo_amigavel) as titulo_amigavel,
                COALESCE(i.empresa_id, i2.empresa_id) as empresa_id,
                COALESCE(e.nome_fantasia, e.nome) as empresa_nome,
                ml.coluna_alterada,
                ml.valor_anterior,
                ml.valor_novo
            FROM ms_merge_log ml
            LEFT JOIN imovel i ON i.id = ml.registro_afetado_id::uuid AND ml.tabela_afetada = 'imovel'
            LEFT JOIN imovel_endereco ie ON ie.imovel_id = ml.registro_afetado_id::uuid AND ml.tabela_afetada = 'imovel_endereco'
            LEFT JOIN imovel i2 ON i2.id = ie.imovel_id
            JOIN empresa e ON e.id = COALESCE(i.empresa_id, i2.empresa_id)
            WHERE ml.grupo_id = $1::uuid
            AND ml.revertido = false
            AND ml.tabela_afetada IN ('imovel', 'imovel_endereco')
            ORDER BY empresa_nome, titulo_amigavel`,
            id
        );

        // Coleta todos os IDs únicos de valor_anterior e valor_novo para resolver nomes
        // Mapeia coluna_alterada → tabela de lookup (bairro, logradouro, condomínio)
        const COLUNA_TABELA: Record<string, string> = {
            bairro_comercial_id: "bairro",
            bairro_id: "bairro",
            logradouro_id: "logradouro",
            condominio_id: "condominio",
            condominios_id: "condominio",
        };

        // Agrupa IDs por tabela para fazer queries em batch
        const idsPorTabela: Record<string, Set<string>> = {};
        for (const im of imoveis) {
            const tabela = COLUNA_TABELA[im.coluna_alterada];
            if (!tabela) continue;
            if (!idsPorTabela[tabela]) idsPorTabela[tabela] = new Set();
            idsPorTabela[tabela].add(im.valor_anterior);
            idsPorTabela[tabela].add(im.valor_novo);
        }

        // Resolve IDs → nomes em paralelo (uma query por tabela)
        const nomesPorId: Record<string, string> = {};
        await Promise.all(
            Object.entries(idsPorTabela).map(async ([tabela, idsSet]) => {
                const ids = [...idsSet].filter(Boolean);
                if (ids.length === 0) return;
                try {
                    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; nome: string }>>(
                        `SELECT id::text, nome FROM ${tabela} WHERE id = ANY($1::uuid[])`,
                        ids
                    );
                    for (const row of rows) {
                        nomesPorId[row.id] = row.nome;
                    }
                } catch {
                    // Ignora erro (tabela pode não existir ou ID inválido)
                }
            })
        );

        return {
            data: imoveis.map((im) => ({
                imovelId: im.imovel_id,
                tituloAmigavel: im.titulo_amigavel,
                empresaId: im.empresa_id,
                empresaNome: im.empresa_nome,
                colunaAlterada: im.coluna_alterada,
                valorAnterior: im.valor_anterior,
                valorNovo: im.valor_novo,
                // Nomes resolvidos dos IDs (para exibir "Setor Marista" em vez de só o UUID)
                nomeAnterior: nomesPorId[im.valor_anterior] ?? null,
                nomeNovo: nomesPorId[im.valor_novo] ?? null,
            })),
        };
    });
}

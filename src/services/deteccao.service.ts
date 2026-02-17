/**
 * DeteccaoService — Detecta grupos de localidades duplicadas usando pg_trgm.
 *
 * Executa queries de similaridade trigram no PostgreSQL para encontrar pares
 * semelhantes dentro do mesmo contexto-pai (ex: bairros dentro da mesma cidade).
 * Os pares são clusterizados em grupos (union-find) e persistidos em ms_grupo_duplicata.
 */

import { prisma } from "../config/database.js";
import { env } from "../config/env.js";
import {
    TipoEntidade,
    TIPO_ENTIDADE_TABELA,
    TIPO_ENTIDADE_PARENT_COL,
    type ParSimilar,
} from "../types/index.js";
import { normalizadorService } from "./normalizador.service.js";

// Tipo retornado pela query raw de similaridade pg_trgm
interface ParSimilarRaw {
    id_a: string;
    id_b: string;
    nome_a: string;
    nome_b: string;
    parent_id: string | null;
    score: number;
}

// Grupo criado e pronto para persistência
interface GrupoCriado {
    tipoEntidade: number;
    parentId: string | null;
    nomeNormalizado: string;
    registroIds: string[];
    nomesMembros: string[];
    scoreMedio: number;
}

class DeteccaoService {
    /**
     * Detecta pares similares para um tipo de entidade específico,
     * opcionalmente filtrado por parentId. Retorna grupos já clusterizados.
     */
    async detectarPorTipo(
        tipo: number,
        parentId: string | null
    ): Promise<GrupoCriado[]> {
        // Obtém o nome da tabela e coluna pai a partir dos mapas de tipo
        const tabela = TIPO_ENTIDADE_TABELA[tipo as TipoEntidade];
        const parentCol = TIPO_ENTIDADE_PARENT_COL[tipo as TipoEntidade];

        // Monta e executa a query de similaridade pg_trgm
        const pares = await this.buscarParesSimilares(
            tabela,
            parentCol,
            parentId
        );

        // Se não encontrou pares, retorna vazio
        if (pares.length === 0) {
            return [];
        }

        // Filtra pares que já estão em grupos existentes (evita duplicação de grupos)
        const paresFiltrados = await this.filtrarParesExistentes(pares, tipo);

        if (paresFiltrados.length === 0) {
            return [];
        }

        // Clusteriza pares em grupos (A~B + B~C = {A,B,C})
        const grupos = this.clusterizarPares(paresFiltrados, tipo);

        return grupos;
    }

    /**
     * Executa a detecção completa para todos os tipos de entidade (ou um específico).
     * Persiste os grupos encontrados e loga a execução.
     */
    async executarDeteccao(
        tipo: number | null
    ): Promise<{ totalAnalisados: number; totalGrupos: number }> {
        const inicio = Date.now();
        let totalAnalisados = 0;
        let totalGrupos = 0;

        // Cria log de execução com status "iniciado"
        const execLog = await prisma.ms_execucao_log.create({
            data: {
                tipo: "deteccao-batch",
                status: "iniciado",
            },
        });

        try {
            // Define quais tipos processar (todos ou um específico)
            const tipos: number[] = tipo
                ? [tipo]
                : [
                      TipoEntidade.Cidade,
                      TipoEntidade.Bairro,
                      TipoEntidade.Logradouro,
                      TipoEntidade.Condominio,
                  ];

            // Processa cada tipo de entidade sequencialmente
            for (const tipoAtual of tipos) {
                console.log(
                    `[DeteccaoService] Processando tipo ${TIPO_ENTIDADE_TABELA[tipoAtual as TipoEntidade]}...`
                );

                // Detecta grupos para esse tipo (sem filtro de parentId, pega todos)
                const grupos = await this.detectarPorTipo(tipoAtual, null);

                // Persiste cada grupo no banco
                for (const grupo of grupos) {
                    await prisma.ms_grupo_duplicata.create({
                        data: {
                            tipo_entidade: grupo.tipoEntidade,
                            parent_id: grupo.parentId,
                            nome_normalizado: grupo.nomeNormalizado,
                            registro_ids: grupo.registroIds,
                            nomes_membros: grupo.nomesMembros,
                            score_medio: grupo.scoreMedio,
                            fonte: "pg_trgm",
                            status: 1, // Pendente
                        },
                    });
                }

                totalGrupos += grupos.length;
                totalAnalisados += grupos.reduce(
                    (acc, g) => acc + g.registroIds.length,
                    0
                );

                console.log(
                    `[DeteccaoService] Tipo ${TIPO_ENTIDADE_TABELA[tipoAtual as TipoEntidade]}: ${grupos.length} grupos encontrados`
                );
            }

            // Atualiza o log de execução com resultado final
            const duracao = Date.now() - inicio;
            await prisma.ms_execucao_log.update({
                where: { id: execLog.id },
                data: {
                    status: "concluido",
                    total_analisados: totalAnalisados,
                    total_grupos: totalGrupos,
                    duracao_ms: duracao,
                },
            });

            console.log(
                `[DeteccaoService] Detecção concluída em ${duracao}ms — ${totalGrupos} grupos, ${totalAnalisados} registros`
            );
        } catch (err) {
            // Em caso de erro, loga no registro de execução
            const duracao = Date.now() - inicio;
            await prisma.ms_execucao_log.update({
                where: { id: execLog.id },
                data: {
                    status: "erro",
                    duracao_ms: duracao,
                    erro: err instanceof Error ? err.message : String(err),
                },
            });

            throw err;
        }

        return { totalAnalisados, totalGrupos };
    }

    /**
     * Executa query pg_trgm para encontrar pares de registros similares
     * dentro da mesma tabela e mesmo contexto-pai.
     */
    private async buscarParesSimilares(
        tabela: string,
        parentCol: string | null,
        parentId: string | null
    ): Promise<ParSimilar[]> {
        // Threshold mínimo de similaridade (configurável via env)
        const threshold = env.THRESHOLD_SIMILARIDADE;
        // Limite de pares por execução para evitar sobrecarga
        const limite = env.LIMITE_PARES_POR_EXECUCAO;

        let query: string;

        if (parentCol) {
            // Para entidades com pai (bairro→cidade, logradouro→bairro, etc.)
            // Compara apenas registros que compartilham o mesmo pai
            query = `
                SELECT
                    a.id::text AS id_a,
                    b.id::text AS id_b,
                    a.nome AS nome_a,
                    b.nome AS nome_b,
                    a.${parentCol}::text AS parent_id,
                    similarity(lower(unaccent(a.nome)), lower(unaccent(b.nome))) AS score
                FROM ${tabela} a, ${tabela} b
                WHERE a.${parentCol} = b.${parentCol}
                  AND a.id < b.id
                  AND (a.excluido = false OR a.excluido IS NULL)
                  AND (b.excluido = false OR b.excluido IS NULL)
                  ${parentId ? `AND a.${parentCol}::text = $3` : ""}
                  AND similarity(lower(unaccent(a.nome)), lower(unaccent(b.nome))) > $1
                ORDER BY score DESC
                LIMIT $2
            `;
        } else {
            // Para Cidade: agrupa por estado_id (sem coluna parent genérica)
            // Nota: tabela cidade NÃO tem coluna "excluido", então omitimos esse filtro
            query = `
                SELECT
                    a.id::text AS id_a,
                    b.id::text AS id_b,
                    a.nome AS nome_a,
                    b.nome AS nome_b,
                    a.estado_id::text AS parent_id,
                    similarity(lower(unaccent(a.nome)), lower(unaccent(b.nome))) AS score
                FROM ${tabela} a, ${tabela} b
                WHERE a.estado_id = b.estado_id
                  AND a.id < b.id
                  ${parentId ? `AND a.estado_id::text = $3` : ""}
                  AND similarity(lower(unaccent(a.nome)), lower(unaccent(b.nome))) > $1
                ORDER BY score DESC
                LIMIT $2
            `;
        }

        // Executa a query raw com os parâmetros posicionais
        const params: (number | string)[] = [threshold, limite];
        if (parentId) {
            params.push(parentId);
        }

        const resultados = await prisma.$queryRawUnsafe<ParSimilarRaw[]>(
            query,
            ...params
        );

        // Mapeia para a interface ParSimilar da aplicação
        return resultados.map((r) => ({
            idA: r.id_a,
            idB: r.id_b,
            nomeA: r.nome_a,
            nomeB: r.nome_b,
            parentId: r.parent_id ?? "",
            score: Number(r.score),
        }));
    }

    /**
     * Filtra pares cujos IDs já aparecem em grupos existentes (ms_grupo_duplicata)
     * para evitar criar grupos duplicados sobre os mesmos registros.
     */
    private async filtrarParesExistentes(
        pares: ParSimilar[],
        tipo: number
    ): Promise<ParSimilar[]> {
        // Busca todos os grupos existentes (não descartados) do mesmo tipo
        const gruposExistentes = await prisma.ms_grupo_duplicata.findMany({
            where: {
                tipo_entidade: tipo,
                status: { in: [1, 2] }, // Pendente ou Executado
            },
            select: {
                registro_ids: true,
            },
        });

        // Monta um Set com todos os IDs já agrupados para lookup O(1)
        const idsJaAgrupados = new Set<string>();
        for (const grupo of gruposExistentes) {
            for (const id of grupo.registro_ids) {
                idsJaAgrupados.add(id);
            }
        }

        // Remove pares onde AMBOS os IDs já estão em algum grupo existente
        return pares.filter((par) => {
            const aJaExiste = idsJaAgrupados.has(par.idA);
            const bJaExiste = idsJaAgrupados.has(par.idB);
            // Mantém o par se pelo menos um dos IDs é novo
            return !(aJaExiste && bJaExiste);
        });
    }

    /**
     * Clusteriza pares em grupos transitivos usando Union-Find.
     * Se A~B e B~C, então {A, B, C} formam um único grupo.
     */
    private clusterizarPares(
        pares: ParSimilar[],
        tipo: number
    ): GrupoCriado[] {
        // Estrutura Union-Find para agrupamento eficiente
        const parent = new Map<string, string>();
        // Armazena nome original de cada ID
        const nomes = new Map<string, string>();
        // Acumula scores para calcular média por grupo
        const scores = new Map<string, number[]>();
        // Armazena parentId de cada registro
        const parentIds = new Map<string, string>();

        /**
         * Find com path compression — encontra a raiz do conjunto.
         */
        const find = (x: string): string => {
            if (!parent.has(x)) {
                parent.set(x, x);
            }
            if (parent.get(x) !== x) {
                parent.set(x, find(parent.get(x)!));
            }
            return parent.get(x)!;
        };

        /**
         * Union — une dois conjuntos.
         */
        const union = (x: string, y: string): void => {
            const rootX = find(x);
            const rootY = find(y);
            if (rootX !== rootY) {
                parent.set(rootY, rootX);
            }
        };

        // Processa cada par: registra nomes, parentIds e une os conjuntos
        for (const par of pares) {
            nomes.set(par.idA, par.nomeA);
            nomes.set(par.idB, par.nomeB);
            parentIds.set(par.idA, par.parentId);
            parentIds.set(par.idB, par.parentId);

            union(par.idA, par.idB);

            // Acumula score para cálculo de média do grupo
            const raiz = find(par.idA);
            if (!scores.has(raiz)) {
                scores.set(raiz, []);
            }
            scores.get(raiz)!.push(par.score);
        }

        // Agrupa IDs por raiz do union-find
        const gruposPorRaiz = new Map<string, string[]>();
        for (const id of nomes.keys()) {
            const raiz = find(id);
            if (!gruposPorRaiz.has(raiz)) {
                gruposPorRaiz.set(raiz, []);
            }
            gruposPorRaiz.get(raiz)!.push(id);
        }

        // Converte cada cluster em um GrupoCriado
        const grupos: GrupoCriado[] = [];
        for (const [raiz, ids] of gruposPorRaiz.entries()) {
            // Precisa de pelo menos 2 membros para ser um grupo de duplicatas
            if (ids.length < 2) {
                continue;
            }

            // Coleta nomes dos membros (mesma ordem dos IDs)
            const nomesMembros = ids.map((id) => nomes.get(id)!);

            // Gera nome normalizado usando o primeiro membro como referência
            const nomeNormalizado = normalizadorService.normalizarComPrefixos(
                nomesMembros[0],
                tipo as TipoEntidade
            );

            // Calcula score médio do grupo
            const scoresGrupo = scores.get(raiz) ?? [];
            const scoreMedio =
                scoresGrupo.length > 0
                    ? scoresGrupo.reduce((a, b) => a + b, 0) /
                      scoresGrupo.length
                    : 0;

            grupos.push({
                tipoEntidade: tipo,
                parentId: parentIds.get(ids[0]) ?? null,
                nomeNormalizado,
                registroIds: ids,
                nomesMembros,
                // Arredonda para 2 casas decimais
                scoreMedio: Math.round(scoreMedio * 100) / 100,
            });
        }

        return grupos;
    }
}

// Exporta como singleton para uso em toda a aplicação
export const deteccaoService = new DeteccaoService();

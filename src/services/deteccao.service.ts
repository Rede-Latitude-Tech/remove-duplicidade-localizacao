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
import { enriquecimentoService } from "./enriquecimento.service.js";
import { openaiValidationService } from "./apis/openai.service.js";

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
        // Passa o tipoEntidade para tratar condomínios com query especial (cidade_id como parent)
        const pares = await this.buscarParesSimilares(
            tabela,
            parentCol,
            parentId,
            tipo as TipoEntidade
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

                console.log(
                    `[DeteccaoService] Tipo ${TIPO_ENTIDADE_TABELA[tipoAtual as TipoEntidade]}: ${grupos.length} candidatos encontrados pelo pg_trgm`
                );

                // Coleta IDs dos grupos criados para enriquecimento posterior
                const grupoIdsCriados: string[] = [];
                let descartadosLlm = 0;

                // Validação LLM em batch: processa lotes de 10 grupos por chamada ao GPT-5.2
                const BATCH_SIZE = 10;
                const tipoLabel = TIPO_ENTIDADE_TABELA[tipoAtual as TipoEntidade];
                // Array de validações LLM paralelo aos grupos (null = sem validação)
                const validacoesLlm: Array<Record<string, unknown> | null> = new Array(grupos.length).fill(null);

                if (openaiValidationService.disponivel) {
                    for (let batchStart = 0; batchStart < grupos.length; batchStart += BATCH_SIZE) {
                        const batchGrupos = grupos.slice(batchStart, batchStart + BATCH_SIZE);

                        // Busca contexto geográfico de cada grupo do lote
                        const gruposParaLlm = [];
                        for (const grupo of batchGrupos) {
                            const contexto = await this.buscarContextoParaLLM(
                                tipoAtual as TipoEntidade,
                                grupo.parentId,
                                grupo.registroIds[0]
                            );
                            gruposParaLlm.push({
                                nomesMembros: grupo.nomesMembros,
                                registroIds: grupo.registroIds,
                                contexto,
                            });
                        }

                        // Envia lote de até 10 grupos ao LLM numa única chamada
                        const resultadosBatch = await openaiValidationService.validarGruposBatch(
                            gruposParaLlm,
                            tipoLabel
                        );

                        // Mapeia resultados de volta para os índices originais
                        for (const [batchIdx, validacao] of resultadosBatch) {
                            const originalIdx = batchStart + batchIdx;
                            validacoesLlm[originalIdx] = {
                                saoDuplicatas: validacao.saoDuplicatas,
                                confianca: validacao.confianca,
                                nomeCanonico: validacao.nomeCanonico,
                                justificativa: validacao.justificativa,
                                membrosValidos: validacao.membrosValidos,
                            };
                        }

                        console.log(
                            `[DeteccaoService] LLM batch ${Math.floor(batchStart / BATCH_SIZE) + 1}/${Math.ceil(grupos.length / BATCH_SIZE)} processado`
                        );
                    }
                }

                // Persiste apenas grupos confirmados pelo LLM (ou todos se LLM indisponível)
                for (let i = 0; i < grupos.length; i++) {
                    const grupo = grupos[i];
                    const detalhesLlm = validacoesLlm[i];

                    if (detalhesLlm) {
                        // LLM descartou o grupo — não persiste
                        if (!(detalhesLlm as any).saoDuplicatas) {
                            descartadosLlm++;
                            console.log(
                                `[DeteccaoService] LLM descartou: [${grupo.nomesMembros.join(", ")}] — ${(detalhesLlm as any).justificativa}`
                            );
                            continue;
                        }

                        const membrosValidos = (detalhesLlm as any).membrosValidos as string[];

                        // LLM confirmou mas pode ter removido membros falso-positivos
                        if (membrosValidos && membrosValidos.length >= 2 &&
                            membrosValidos.length < grupo.registroIds.length) {
                            const indicesValidos = grupo.registroIds
                                .map((id, idx) => membrosValidos.includes(id) ? idx : -1)
                                .filter(idx => idx >= 0);
                            grupo.registroIds = indicesValidos.map(idx => grupo.registroIds[idx]);
                            grupo.nomesMembros = indicesValidos.map(idx => grupo.nomesMembros[idx]);
                        }

                        // Usa nome canônico sugerido pelo LLM
                        const nomeCanonico = (detalhesLlm as any).nomeCanonico;
                        if (nomeCanonico) grupo.nomeNormalizado = nomeCanonico;
                    }

                    // Persiste o grupo confirmado
                    const criado = await prisma.ms_grupo_duplicata.create({
                        data: {
                            tipo_entidade: grupo.tipoEntidade,
                            parent_id: grupo.parentId,
                            nome_normalizado: grupo.nomeNormalizado,
                            registro_ids: grupo.registroIds,
                            nomes_membros: grupo.nomesMembros,
                            score_medio: grupo.scoreMedio,
                            fonte: openaiValidationService.disponivel ? "pg_trgm+llm" : "pg_trgm",
                            // Serializa detalhes LLM como JSON string (campo é text no banco)
                            detalhes_llm: detalhesLlm ? JSON.stringify(detalhesLlm) : undefined,
                            status: 1,
                        },
                    });
                    grupoIdsCriados.push(criado.id);
                }

                totalGrupos += grupoIdsCriados.length;
                totalAnalisados += grupos.reduce(
                    (acc, g) => acc + g.registroIds.length,
                    0
                );

                console.log(
                    `[DeteccaoService] Tipo ${TIPO_ENTIDADE_TABELA[tipoAtual as TipoEntidade]}: ` +
                    `${grupoIdsCriados.length} grupos confirmados` +
                    (descartadosLlm > 0 ? `, ${descartadosLlm} descartados pelo LLM` : "")
                );

                // Enriquece os grupos recém-criados com hierarquia e nome oficial
                if (grupoIdsCriados.length > 0) {
                    await enriquecimentoService.enriquecer(grupoIdsCriados);
                }
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
     * Para condomínios, usa query especial que navega até cidade_id como parent_id.
     */
    private async buscarParesSimilares(
        tabela: string,
        parentCol: string | null,
        parentId: string | null,
        tipoEntidade?: TipoEntidade
    ): Promise<ParSimilar[]> {
        // Threshold mínimo de similaridade (configurável via env)
        const threshold = env.THRESHOLD_SIMILARIDADE;
        // Limite de pares por execução para evitar sobrecarga
        const limite = env.LIMITE_PARES_POR_EXECUCAO;

        let query: string;

        if (tipoEntidade === TipoEntidade.Condominio) {
            // Condomínio: compara dentro do mesmo logradouro, mas retorna cidade_id como parent_id
            // JOIN: condominio → logradouro → bairro → cidade para extrair cidade_id numérico
            // pg_trgm é o filtro bruto — a validação fina é feita pelo LLM depois
            query = `
                SELECT
                    a.id::text AS id_a,
                    b.id::text AS id_b,
                    a.nome AS nome_a,
                    b.nome AS nome_b,
                    ci.id::text AS parent_id,
                    similarity(lower(unaccent(a.nome)), lower(unaccent(b.nome))) AS score
                FROM condominio a
                JOIN logradouro la ON la.id = a.logradouro_id
                JOIN bairro ba ON ba.id = la.bairro_id
                JOIN cidade ci ON ci.id = ba.cidade_id,
                condominio b
                WHERE a.logradouro_id = b.logradouro_id
                  AND a.id < b.id
                  AND (a.excluido = false OR a.excluido IS NULL)
                  AND (b.excluido = false OR b.excluido IS NULL)
                  ${parentId ? `AND ci.id::text = $3` : ""}
                  AND similarity(lower(unaccent(a.nome)), lower(unaccent(b.nome))) > $1
                ORDER BY score DESC
                LIMIT $2
            `;
        } else if (parentCol) {
            // Para entidades com pai (bairro→cidade, logradouro→bairro)
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

    /**
     * Busca contexto geográfico de um registro para enviar ao LLM.
     * Navega pela hierarquia para obter cidade, estado, bairro e logradouro.
     */
    private async buscarContextoParaLLM(
        tipo: TipoEntidade,
        parentId: string | null,
        primeiroMembroId: string
    ): Promise<{ cidade?: string; estado?: string; bairro?: string; logradouro?: string }> {
        try {
            if (tipo === TipoEntidade.Cidade && parentId) {
                // Cidade: parent_id é o estado_id (sigla)
                return { estado: parentId };
            }

            if (tipo === TipoEntidade.Bairro && parentId) {
                // Bairro: parent_id é cidade_id (numérico)
                const rows = await prisma.$queryRawUnsafe<Array<{ nome: string; estado_id: string }>>(
                    `SELECT nome, estado_id FROM cidade WHERE id = $1::int`,
                    parseInt(parentId, 10)
                );
                if (rows.length > 0) {
                    return { cidade: rows[0].nome, estado: rows[0].estado_id };
                }
            }

            if (tipo === TipoEntidade.Logradouro) {
                // Logradouro: busca bairro e cidade via membro
                const rows = await prisma.$queryRawUnsafe<Array<{
                    bairro_nome: string; cidade_nome: string; estado_id: string;
                }>>(
                    `SELECT b.nome as bairro_nome, c.nome as cidade_nome, c.estado_id
                     FROM logradouro l JOIN bairro b ON b.id = l.bairro_id JOIN cidade c ON c.id = b.cidade_id
                     WHERE l.id = $1::uuid`,
                    primeiroMembroId
                );
                if (rows.length > 0) {
                    return { bairro: rows[0].bairro_nome, cidade: rows[0].cidade_nome, estado: rows[0].estado_id };
                }
            }

            if (tipo === TipoEntidade.Condominio) {
                // Condomínio: busca logradouro, bairro e cidade via membro
                const rows = await prisma.$queryRawUnsafe<Array<{
                    logradouro_nome: string; bairro_nome: string; cidade_nome: string; estado_id: string;
                }>>(
                    `SELECT l.nome as logradouro_nome, b.nome as bairro_nome, c.nome as cidade_nome, c.estado_id
                     FROM condominio co JOIN logradouro l ON l.id = co.logradouro_id
                     JOIN bairro b ON b.id = l.bairro_id JOIN cidade c ON c.id = b.cidade_id
                     WHERE co.id = $1::uuid`,
                    primeiroMembroId
                );
                if (rows.length > 0) {
                    return {
                        logradouro: rows[0].logradouro_nome,
                        bairro: rows[0].bairro_nome,
                        cidade: rows[0].cidade_nome,
                        estado: rows[0].estado_id,
                    };
                }
            }
        } catch (err) {
            console.warn(`[DeteccaoService] Erro ao buscar contexto para LLM:`, err);
        }

        return {};
    }
}

// Exporta como singleton para uso em toda a aplicação
export const deteccaoService = new DeteccaoService();

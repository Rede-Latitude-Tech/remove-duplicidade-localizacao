/**
 * EnriquecimentoService — Orquestrador de enriquecimento de grupos de duplicatas.
 *
 * Para cada grupo detectado, busca o contexto hierarquico de cada membro
 * (cidade, bairro, logradouro, condominio), consulta APIs externas para
 * obter o nome oficial e sugere qual membro deve ser o canonico.
 *
 * Fluxo: contexto SQL -> API externa (IBGE/ViaCEP/Google) -> sugestao automatica.
 */

import { prisma } from "../config/database.js";
import { env } from "../config/env.js";
import { TipoEntidade } from "../types/index.js";
import { ibgeService } from "./apis/ibge.service.js";
import { viaCepService } from "./apis/viacep.service.js";
import { googleGeocodingService } from "./apis/google.service.js";
import type { ResultadoOficial } from "./apis/ibge.service.js";

// Contexto hierarquico de um membro do grupo (tipo interno, nao exportado)
interface ContextoMembro {
    registroId: string;
    cidadeNome: string | null;
    cidadeId: string | null;
    estadoSigla: string | null;
    bairroNome: string | null;
    bairroId: string | null;
    logradouroNome: string | null;
    logradouroId: string | null;
    ceps: string[];
    totalLogradouros: number | null;
    totalCondominios: number | null;
    totalBairros: number | null;
}

class EnriquecimentoService {
    /**
     * Enriquece uma lista de grupos de duplicatas.
     * Se o enriquecimento estiver desabilitado via env, loga e pula.
     * Erros em um grupo nao bloqueiam os demais.
     */
    async enriquecer(grupoIds: string[]): Promise<void> {
        // Verifica se o enriquecimento esta habilitado na configuracao
        if (!env.ENRIQUECIMENTO_HABILITADO) {
            console.log(
                "[Enriquecimento] Desabilitado via ENRIQUECIMENTO_HABILITADO=false — pulando"
            );
            return;
        }

        console.log(
            `[Enriquecimento] Iniciando enriquecimento de ${grupoIds.length} grupo(s)...`
        );

        // Processa cada grupo individualmente com try/catch isolado
        for (const grupoId of grupoIds) {
            try {
                await this.enriquecerGrupo(grupoId);
            } catch (err) {
                console.error(
                    `[Enriquecimento] Erro ao enriquecer grupo ${grupoId}:`,
                    err
                );
            }
        }
    }

    /**
     * Enriquece um unico grupo de duplicatas:
     * 1. Busca o grupo no banco
     * 2. Busca contexto hierarquico de cada membro via SQL
     * 3. Consulta APIs externas para nome oficial
     * 4. Determina o membro canonico sugerido
     * 5. Persiste contextos e atualiza o grupo
     */
    private async enriquecerGrupo(grupoId: string): Promise<void> {
        // 1. Busca o grupo no banco de dados
        const grupo = await prisma.ms_grupo_duplicata.findUnique({
            where: { id: grupoId },
        });

        if (!grupo) {
            console.warn(
                `[Enriquecimento] Grupo ${grupoId} nao encontrado — pulando`
            );
            return;
        }

        const tipo = grupo.tipo_entidade as TipoEntidade;
        const registroIds = grupo.registro_ids;
        const nomesMembros = grupo.nomes_membros;

        // 2. Busca contexto hierarquico de cada membro (queries SQL)
        const contextos = await this.buscarContextosMembros(
            tipo,
            registroIds,
            nomesMembros
        );

        // 3. Consulta APIs externas para obter nome oficial
        const nomeOficial = await this.buscarNomeOficial(
            tipo,
            nomesMembros,
            contextos
        );

        // 4. Determina qual membro e o melhor candidato a canonico
        const canonicoSugeridoId = this.determinarCanonicoSugerido(
            registroIds,
            nomesMembros,
            nomeOficial
        );

        // 5. Persiste os contextos dos membros no banco
        if (contextos.length > 0) {
            await prisma.ms_membro_contexto.createMany({
                data: contextos.map((ctx) => ({
                    grupo_id: grupoId,
                    registro_id: ctx.registroId,
                    cidade_nome: ctx.cidadeNome,
                    cidade_id: ctx.cidadeId,
                    estado_sigla: ctx.estadoSigla,
                    bairro_nome: ctx.bairroNome,
                    bairro_id: ctx.bairroId,
                    logradouro_nome: ctx.logradouroNome,
                    logradouro_id: ctx.logradouroId,
                    ceps: ctx.ceps,
                    total_logradouros: ctx.totalLogradouros,
                    total_condominios: ctx.totalCondominios,
                    total_bairros: ctx.totalBairros,
                })),
            });
        }

        // 6. Atualiza o grupo com nome oficial, endereco Google e sugestao de canonico
        await prisma.ms_grupo_duplicata.update({
            where: { id: grupoId },
            data: {
                nome_oficial: nomeOficial?.nomeOficial ?? null,
                fonte_oficial: nomeOficial?.fonte ?? null,
                endereco_google: nomeOficial?.enderecoCompleto ?? null,
                canonico_sugerido_id: canonicoSugeridoId,
            },
        });

        console.log(
            `[Enriquecimento] Grupo ${grupoId} enriquecido — ` +
                `oficial: ${nomeOficial?.nomeOficial ?? "N/A"} (${nomeOficial?.fonte ?? "-"}), ` +
                `sugerido: ${canonicoSugeridoId ?? "nenhum"}`
        );
    }

    // ========================================================================
    // Busca de contexto hierarquico via SQL
    // ========================================================================

    /**
     * Busca o contexto hierarquico de cada membro do grupo.
     * As queries variam conforme o tipo de entidade (cidade, bairro, etc.).
     */
    private async buscarContextosMembros(
        tipo: TipoEntidade,
        registroIds: string[],
        nomesMembros: string[]
    ): Promise<ContextoMembro[]> {
        const contextos: ContextoMembro[] = [];

        for (let i = 0; i < registroIds.length; i++) {
            const registroId = registroIds[i];

            try {
                let ctx: ContextoMembro | null = null;

                // Seleciona a query adequada ao tipo de entidade
                switch (tipo) {
                    case TipoEntidade.Cidade:
                        ctx = await this.buscarContextoCidade(registroId);
                        break;
                    case TipoEntidade.Bairro:
                        ctx = await this.buscarContextoBairro(registroId);
                        break;
                    case TipoEntidade.Logradouro:
                        ctx =
                            await this.buscarContextoLogradouro(registroId);
                        break;
                    case TipoEntidade.Condominio:
                        ctx =
                            await this.buscarContextoCondominio(registroId);
                        break;
                }

                if (ctx) {
                    contextos.push(ctx);
                }
            } catch (err) {
                console.warn(
                    `[Enriquecimento] Erro ao buscar contexto do membro ${registroId}:`,
                    err
                );
            }
        }

        return contextos;
    }

    /**
     * Contexto de uma cidade: estado e total de bairros.
     */
    private async buscarContextoCidade(
        registroId: string
    ): Promise<ContextoMembro | null> {
        // Busca estado e contagem de bairros da cidade
        const rows = await prisma.$queryRawUnsafe<
            Array<{ estado_id: string; total_bairros: bigint }>
        >(
            `SELECT c.estado_id,
                    (SELECT COUNT(*) FROM bairro b WHERE b.cidade_id = c.id AND (b.excluido = false OR b.excluido IS NULL)) as total_bairros
             FROM cidade c WHERE c.id = $1::int`,
            parseInt(registroId, 10)
        );

        if (rows.length === 0) return null;

        const row = rows[0];

        return {
            registroId,
            cidadeNome: null,
            cidadeId: null,
            estadoSigla: row.estado_id,
            bairroNome: null,
            bairroId: null,
            logradouroNome: null,
            logradouroId: null,
            ceps: [],
            totalLogradouros: null,
            totalCondominios: null,
            totalBairros: Number(row.total_bairros),
        };
    }

    /**
     * Contexto de um bairro: cidade, estado, CEPs e total de logradouros.
     */
    private async buscarContextoBairro(
        registroId: string
    ): Promise<ContextoMembro | null> {
        // Busca hierarquia cidade/estado do bairro
        const hierarquia = await prisma.$queryRawUnsafe<
            Array<{
                cidade_nome: string;
                cidade_id: string;
                estado_sigla: string;
            }>
        >(
            `SELECT c.nome as cidade_nome, c.id::text as cidade_id, c.estado_id as estado_sigla
             FROM bairro b JOIN cidade c ON c.id = b.cidade_id WHERE b.id = $1::uuid`,
            registroId
        );

        if (hierarquia.length === 0) return null;

        // Busca CEPs distintos dos logradouros do bairro (limitado pela config)
        const cepsRows = await prisma.$queryRawUnsafe<Array<{ cep: string }>>(
            `SELECT DISTINCT l.cep FROM logradouro l
             WHERE l.bairro_id = $1::uuid AND l.cep IS NOT NULL AND l.cep != ''
             AND (l.excluido = false OR l.excluido IS NULL) LIMIT $2`,
            registroId,
            env.VIACEP_MAX_CEPS_POR_MEMBRO
        );

        // Conta total de logradouros no bairro
        const contagemRows = await prisma.$queryRawUnsafe<
            Array<{ total: bigint }>
        >(
            `SELECT COUNT(*) as total FROM logradouro WHERE bairro_id = $1::uuid AND (excluido = false OR excluido IS NULL)`,
            registroId
        );

        const h = hierarquia[0];

        return {
            registroId,
            cidadeNome: h.cidade_nome,
            cidadeId: h.cidade_id,
            estadoSigla: h.estado_sigla,
            bairroNome: null,
            bairroId: null,
            logradouroNome: null,
            logradouroId: null,
            ceps: cepsRows.map((r) => r.cep),
            totalLogradouros: Number(contagemRows[0]?.total ?? 0),
            totalCondominios: null,
            totalBairros: null,
        };
    }

    /**
     * Contexto de um logradouro: bairro, cidade, estado, CEP e total de condominios.
     */
    private async buscarContextoLogradouro(
        registroId: string
    ): Promise<ContextoMembro | null> {
        // Busca hierarquia bairro/cidade/estado e CEP do logradouro
        const hierarquia = await prisma.$queryRawUnsafe<
            Array<{
                bairro_nome: string;
                bairro_id: string;
                cidade_nome: string;
                cidade_id: string;
                estado_sigla: string;
                cep: string | null;
            }>
        >(
            `SELECT b.nome as bairro_nome, b.id::text as bairro_id,
                    c.nome as cidade_nome, c.id::text as cidade_id, c.estado_id as estado_sigla, l.cep
             FROM logradouro l JOIN bairro b ON b.id = l.bairro_id JOIN cidade c ON c.id = b.cidade_id
             WHERE l.id = $1::uuid`,
            registroId
        );

        if (hierarquia.length === 0) return null;

        // Conta total de condominios no logradouro
        const contagemRows = await prisma.$queryRawUnsafe<
            Array<{ total: bigint }>
        >(
            `SELECT COUNT(*) as total FROM condominio WHERE logradouro_id = $1::uuid AND (excluido = false OR excluido IS NULL)`,
            registroId
        );

        const h = hierarquia[0];

        return {
            registroId,
            cidadeNome: h.cidade_nome,
            cidadeId: h.cidade_id,
            estadoSigla: h.estado_sigla,
            bairroNome: h.bairro_nome,
            bairroId: h.bairro_id,
            logradouroNome: null,
            logradouroId: null,
            ceps: h.cep ? [h.cep] : [],
            totalLogradouros: null,
            totalCondominios: Number(contagemRows[0]?.total ?? 0),
            totalBairros: null,
        };
    }

    /**
     * Contexto de um condominio: logradouro, bairro, cidade, estado e CEP.
     */
    private async buscarContextoCondominio(
        registroId: string
    ): Promise<ContextoMembro | null> {
        // Busca hierarquia completa logradouro/bairro/cidade/estado do condominio
        const hierarquia = await prisma.$queryRawUnsafe<
            Array<{
                logradouro_nome: string;
                logradouro_id: string;
                bairro_nome: string;
                bairro_id: string;
                cidade_nome: string;
                cidade_id: string;
                estado_sigla: string;
                cep: string | null;
            }>
        >(
            `SELECT l.nome as logradouro_nome, l.id::text as logradouro_id,
                    b.nome as bairro_nome, b.id::text as bairro_id,
                    c.nome as cidade_nome, c.id::text as cidade_id, c.estado_id as estado_sigla, l.cep
             FROM condominio co JOIN logradouro l ON l.id = co.logradouro_id
             JOIN bairro b ON b.id = l.bairro_id JOIN cidade c ON c.id = b.cidade_id
             WHERE co.id = $1::uuid`,
            registroId
        );

        if (hierarquia.length === 0) return null;

        const h = hierarquia[0];

        return {
            registroId,
            cidadeNome: h.cidade_nome,
            cidadeId: h.cidade_id,
            estadoSigla: h.estado_sigla,
            bairroNome: h.bairro_nome,
            bairroId: h.bairro_id,
            logradouroNome: h.logradouro_nome,
            logradouroId: h.logradouro_id,
            ceps: h.cep ? [h.cep] : [],
            totalLogradouros: null,
            totalCondominios: null,
            totalBairros: null,
        };
    }

    // ========================================================================
    // Busca de nome oficial via APIs externas
    // ========================================================================

    /**
     * Busca o nome oficial da entidade via APIs externas.
     * Cada tipo de entidade tem sua estrategia de busca com fallback pro Google.
     */
    private async buscarNomeOficial(
        tipo: TipoEntidade,
        nomesMembros: string[],
        contextos: ContextoMembro[]
    ): Promise<ResultadoOficial | null> {
        // Usa o primeiro nome e contexto como referencia principal
        const primeiroNome = nomesMembros[0] ?? "";
        const primeiroCtx = contextos[0] ?? null;

        try {
            switch (tipo) {
                case TipoEntidade.Cidade:
                    return await this.buscarNomeOficialCidade(
                        primeiroNome,
                        primeiroCtx
                    );
                case TipoEntidade.Bairro:
                    return await this.buscarNomeOficialBairro(
                        nomesMembros,
                        contextos
                    );
                case TipoEntidade.Logradouro:
                    return await this.buscarNomeOficialLogradouro(
                        nomesMembros,
                        contextos
                    );
                case TipoEntidade.Condominio:
                    // Passa todos os nomes dos membros para tentar cada um no Google Places
                    return await this.buscarNomeOficialCondominio(
                        nomesMembros,
                        primeiroCtx
                    );
                default:
                    return null;
            }
        } catch (err) {
            console.warn(
                `[Enriquecimento] Erro ao buscar nome oficial:`,
                err
            );
            return null;
        }
    }

    /**
     * Cidade: IBGE com fallback para Google Geocoding.
     */
    private async buscarNomeOficialCidade(
        nome: string,
        ctx: ContextoMembro | null
    ): Promise<ResultadoOficial | null> {
        const uf = ctx?.estadoSigla;

        // Tenta IBGE primeiro (fonte mais confiavel para cidades)
        if (uf) {
            const resultado = await ibgeService.buscarCidade(nome, uf);
            if (resultado) return resultado;
        }

        // Fallback: Google Geocoding
        return googleGeocodingService.buscarNomeGenerico(
            nome,
            "cidade",
            undefined,
            uf ?? undefined
        );
    }

    /**
     * Bairro: ViaCEP (todos os CEPs de todos os membros) com fallback para Google.
     */
    private async buscarNomeOficialBairro(
        nomesMembros: string[],
        contextos: ContextoMembro[]
    ): Promise<ResultadoOficial | null> {
        // Coleta todos os CEPs de todos os membros do grupo
        const todosCeps: string[] = [];
        for (const ctx of contextos) {
            todosCeps.push(...ctx.ceps);
        }

        // Tenta ViaCEP com todos os CEPs coletados
        if (todosCeps.length > 0) {
            const resultado = await viaCepService.buscarNomeBairro(todosCeps);
            if (resultado) return resultado;
        }

        // Fallback: Google Geocoding com contexto do primeiro membro
        const primeiroCtx = contextos[0] ?? null;
        return googleGeocodingService.buscarNomeGenerico(
            nomesMembros[0] ?? "",
            "bairro",
            primeiroCtx?.cidadeNome ?? undefined,
            primeiroCtx?.estadoSigla ?? undefined
        );
    }

    /**
     * Logradouro: ViaCEP (tenta CEP de cada membro) com fallback para Google.
     */
    private async buscarNomeOficialLogradouro(
        nomesMembros: string[],
        contextos: ContextoMembro[]
    ): Promise<ResultadoOficial | null> {
        // Tenta ViaCEP com o CEP de cada membro ate encontrar resultado
        for (const ctx of contextos) {
            if (ctx.ceps.length > 0) {
                const resultado = await viaCepService.buscarNomeLogradouro(
                    ctx.ceps[0]
                );
                if (resultado) return resultado;
            }
        }

        // Fallback: Google Geocoding com contexto do primeiro membro
        const primeiroCtx = contextos[0] ?? null;
        return googleGeocodingService.buscarNomeGenerico(
            nomesMembros[0] ?? "",
            "logradouro",
            primeiroCtx?.cidadeNome ?? undefined,
            primeiroCtx?.estadoSigla ?? undefined
        );
    }

    /**
     * Condominio: Google Places API (Find Place from Text) para obter nome público real.
     * Passa todos os nomes dos membros — tenta cada um até encontrar no Google Places.
     */
    private async buscarNomeOficialCondominio(
        nomesMembros: string[],
        ctx: ContextoMembro | null
    ): Promise<ResultadoOficial | null> {
        return googleGeocodingService.buscarNomeCondominio(
            nomesMembros,
            ctx?.logradouroNome ?? "",
            ctx?.bairroNome ?? "",
            ctx?.cidadeNome ?? "",
            ctx?.estadoSigla ?? ""
        );
    }

    // ========================================================================
    // Determinacao do canonico sugerido
    // ========================================================================

    /**
     * Determina qual membro do grupo e o mais similar ao nome oficial.
     * Usa coeficiente de Dice (bigramas) para calcular similaridade.
     * Retorna o registroId do membro com maior score.
     */
    private determinarCanonicoSugerido(
        registroIds: string[],
        nomesMembros: string[],
        nomeOficial: ResultadoOficial | null
    ): string | null {
        // Sem nome oficial, nao ha como sugerir
        if (!nomeOficial) return null;

        const oficialNorm = this.normalizar(nomeOficial.nomeOficial);

        let melhorScore = -1;
        let melhorId: string | null = null;

        // Compara cada membro com o nome oficial normalizado
        for (let i = 0; i < registroIds.length; i++) {
            const membroNorm = this.normalizar(nomesMembros[i] ?? "");
            const score = this.similaridadeDice(membroNorm, oficialNorm);

            if (score > melhorScore) {
                melhorScore = score;
                melhorId = registroIds[i];
            }
        }

        return melhorId;
    }

    // ========================================================================
    // Helpers de normalizacao e similaridade
    // ========================================================================

    /**
     * Normaliza uma string para comparacao: minusculo, sem acentos, espacos colapsados.
     */
    private normalizar(str: string): string {
        return str
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, " ")
            .trim();
    }

    /**
     * Calcula o coeficiente de Dice entre duas strings usando bigramas.
     * Dice = 2 * |A intersecao B| / (|A| + |B|)
     * Retorna valor entre 0 (nenhuma similaridade) e 1 (identicas).
     */
    private similaridadeDice(a: string, b: string): number {
        // Strings identicas = similaridade perfeita
        if (a === b) return 1;

        // Strings muito curtas nao formam bigramas
        if (a.length < 2 || b.length < 2) return 0;

        // Gera bigramas de cada string
        const bigramasA = this.gerarBigramas(a);
        const bigramasB = this.gerarBigramas(b);

        // Conta a intersecao usando Map para eficiencia
        const contagemB = new Map<string, number>();
        for (const bg of bigramasB) {
            contagemB.set(bg, (contagemB.get(bg) ?? 0) + 1);
        }

        let intersecao = 0;
        for (const bg of bigramasA) {
            const count = contagemB.get(bg);
            if (count && count > 0) {
                intersecao++;
                contagemB.set(bg, count - 1);
            }
        }

        // Formula de Dice: 2 * |A ∩ B| / (|A| + |B|)
        return (2 * intersecao) / (bigramasA.length + bigramasB.length);
    }

    /**
     * Gera a lista de bigramas (pares consecutivos de caracteres) de uma string.
     * Exemplo: "casa" -> ["ca", "as", "sa"]
     */
    private gerarBigramas(str: string): string[] {
        const bigramas: string[] = [];
        for (let i = 0; i < str.length - 1; i++) {
            bigramas.push(str.substring(i, i + 2));
        }
        return bigramas;
    }
}

// Exporta como singleton para uso em toda a aplicacao
export const enriquecimentoService = new EnriquecimentoService();

/**
 * IbgeService — Serviço para consulta de municípios na API do IBGE.
 *
 * Busca o nome oficial de uma cidade a partir de um nome parcial/aproximado,
 * usando coeficiente de Dice (similaridade por bigramas) para matching fuzzy.
 *
 * Os dados de municípios são cacheados no Redis por 30 dias para evitar
 * chamadas repetidas à API do IBGE.
 */

import { cacheService } from "../cache.service.js";

// URL base da API de localidades do IBGE
const IBGE_API_BASE =
    "https://servicodados.ibge.gov.br/api/v1/localidades/estados";

// TTL do cache de municípios: 30 dias em segundos
const CACHE_TTL_MUNICIPIOS = 30 * 24 * 60 * 60;

// Score mínimo de similaridade para considerar um match válido
const SCORE_MINIMO = 0.5;

/**
 * Estrutura de um município retornado pela API do IBGE.
 */
interface MunicipioIBGE {
    id: number;
    nome: string;
}

/**
 * Resultado da busca por nome oficial de cidade.
 * Inclui o nome oficial encontrado, a fonte da informação e o score de similaridade.
 */
export interface ResultadoOficial {
    nomeOficial: string;
    fonte: string;
    score: number;
}

class IbgeService {
    /**
     * Busca o nome oficial de uma cidade no IBGE a partir de um nome aproximado.
     *
     * Fluxo:
     * 1. Lista todos os municípios do estado informado (com cache)
     * 2. Normaliza o nome de entrada (sem acentos, minúsculo)
     * 3. Compara com todos os municípios usando coeficiente de Dice
     * 4. Retorna o melhor match se score > 0.5, senão null
     *
     * @param nome - Nome da cidade (pode conter acentos, caixa mista, etc.)
     * @param estadoSigla - Sigla do estado (ex: "SP", "RJ", "MG")
     * @returns O melhor resultado oficial encontrado ou null se nenhum match suficiente
     */
    async buscarCidade(
        nome: string,
        estadoSigla: string
    ): Promise<ResultadoOficial | null> {
        // Busca todos os municípios do estado (usa cache do Redis)
        const municipios = await this.listarMunicipios(estadoSigla);

        // Se não conseguiu obter a lista, não há como comparar
        if (municipios.length === 0) {
            return null;
        }

        // Normaliza o nome de entrada para comparação justa
        const nomeNormalizado = this.normalizar(nome);

        // Variáveis para rastrear o melhor match encontrado
        let melhorScore = 0;
        let melhorNome = "";

        // Itera sobre todos os municípios e calcula a similaridade
        for (const municipio of municipios) {
            const municipioNormalizado = this.normalizar(municipio.nome);
            const score = this.calcularSimilaridade(
                nomeNormalizado,
                municipioNormalizado
            );

            // Atualiza o melhor match se este score for superior
            if (score > melhorScore) {
                melhorScore = score;
                melhorNome = municipio.nome;
            }
        }

        // Só retorna se o score ultrapassar o limiar mínimo de confiança
        if (melhorScore > SCORE_MINIMO) {
            return {
                nomeOficial: melhorNome,
                fonte: "IBGE",
                score: melhorScore,
            };
        }

        // Nenhum município teve similaridade suficiente
        return null;
    }

    /**
     * Lista todos os municípios de um estado via API do IBGE.
     *
     * Primeiro tenta buscar do cache Redis (chave: ibge:municipios:{UF}).
     * Se não encontrar, faz a requisição HTTP e armazena no cache por 30 dias.
     *
     * @param uf - Sigla da UF em maiúsculo (ex: "SP")
     * @returns Array de municípios com id e nome
     */
    private async listarMunicipios(uf: string): Promise<MunicipioIBGE[]> {
        // Normaliza a UF para maiúsculo para consistência da chave de cache
        const ufUpper = uf.toUpperCase();
        const cacheKey = `ibge:municipios:${ufUpper}`;

        // Tenta buscar do cache primeiro (evita chamadas desnecessárias à API)
        const cached = await cacheService.get<MunicipioIBGE[]>(cacheKey);
        if (cached) {
            return cached;
        }

        try {
            // Faz a requisição à API do IBGE
            const url = `${IBGE_API_BASE}/${ufUpper}/municipios`;
            const response = await fetch(url);

            // Verifica se a resposta foi bem-sucedida
            if (!response.ok) {
                console.warn(
                    `[IbgeService] Erro ao buscar municípios de ${ufUpper}: HTTP ${response.status}`
                );
                return [];
            }

            // Parse da resposta — a API retorna objetos com muitos campos,
            // mas só precisamos de id e nome
            const dados: Array<{ id: number; nome: string }> =
                await response.json();

            // Mapeia para a estrutura simplificada que usamos internamente
            const municipios: MunicipioIBGE[] = dados.map((m) => ({
                id: m.id,
                nome: m.nome,
            }));

            // Armazena no cache por 30 dias (dados do IBGE mudam raramente)
            await cacheService.set(cacheKey, municipios, CACHE_TTL_MUNICIPIOS);

            return municipios;
        } catch (err) {
            // Em caso de falha na rede ou parse, loga e retorna vazio
            console.warn(
                `[IbgeService] Falha ao consultar API do IBGE para UF=${ufUpper}:`,
                err
            );
            return [];
        }
    }

    /**
     * Normaliza uma string para comparação de similaridade.
     *
     * Aplica:
     * 1. Conversão para minúsculo
     * 2. Decomposição Unicode (NFD) para separar caracteres base dos diacríticos
     * 3. Remoção dos diacríticos (acentos, cedilha, til, etc.)
     * 4. Colapso de espaços múltiplos em um único
     * 5. Trim de espaços nas bordas
     *
     * Exemplo: "São José dos Campos" → "sao jose dos campos"
     *
     * @param str - String original
     * @returns String normalizada
     */
    private normalizar(str: string): string {
        return (
            str
                // Converte para minúsculo
                .toLowerCase()
                // Decompõe caracteres acentuados (ex: é → e + ´)
                .normalize("NFD")
                // Remove os diacríticos (combining marks Unicode)
                .replace(/[\u0300-\u036f]/g, "")
                // Colapsa múltiplos espaços em um único
                .replace(/\s+/g, " ")
                // Remove espaços nas bordas
                .trim()
        );
    }

    /**
     * Calcula o coeficiente de Dice entre duas strings.
     *
     * O coeficiente de Dice mede a similaridade entre dois conjuntos usando bigramas:
     *   Dice = 2 * |A ∩ B| / (|A| + |B|)
     *
     * Onde A e B são os conjuntos de bigramas (pares de caracteres consecutivos)
     * de cada string.
     *
     * Retorna um valor entre 0 (nenhuma similaridade) e 1 (strings idênticas).
     *
     * @param a - Primeira string (já normalizada)
     * @param b - Segunda string (já normalizada)
     * @returns Score de similaridade entre 0 e 1
     */
    private calcularSimilaridade(a: string, b: string): number {
        // Strings idênticas têm similaridade perfeita
        if (a === b) return 1;

        // Strings muito curtas (< 2 chars) não formam bigramas
        if (a.length < 2 || b.length < 2) return 0;

        // Gera os bigramas (pares de caracteres consecutivos) de cada string
        const bigramasA = this.gerarBigramas(a);
        const bigramasB = this.gerarBigramas(b);

        // Conta a interseção — quantos bigramas aparecem em ambos os conjuntos
        let intersecao = 0;

        // Usa um Map para contagem eficiente de bigramas de B
        const contagemB = new Map<string, number>();
        for (const bigrama of bigramasB) {
            contagemB.set(bigrama, (contagemB.get(bigrama) ?? 0) + 1);
        }

        // Para cada bigrama de A, verifica se existe em B (consumindo a contagem)
        for (const bigrama of bigramasA) {
            const count = contagemB.get(bigrama);
            if (count && count > 0) {
                intersecao++;
                // Decrementa para não contar o mesmo bigrama de B duas vezes
                contagemB.set(bigrama, count - 1);
            }
        }

        // Fórmula do coeficiente de Dice: 2 * |A ∩ B| / (|A| + |B|)
        return (2 * intersecao) / (bigramasA.length + bigramasB.length);
    }

    /**
     * Gera a lista de bigramas (pares de caracteres consecutivos) de uma string.
     *
     * Exemplo: "casa" → ["ca", "as", "sa"]
     *
     * @param str - String de entrada
     * @returns Array de bigramas
     */
    private gerarBigramas(str: string): string[] {
        const bigramas: string[] = [];
        for (let i = 0; i < str.length - 1; i++) {
            bigramas.push(str.substring(i, i + 2));
        }
        return bigramas;
    }
}

// Exporta como singleton para uso em toda a aplicação
export const ibgeService = new IbgeService();

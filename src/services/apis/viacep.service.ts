/**
 * ViaCepService — Consulta a API pública do ViaCEP para obter nomes oficiais
 * de bairros e logradouros a partir de CEPs.
 *
 * Funcionalidades:
 * - Consulta individual de CEP com cache Redis (evita chamadas repetidas)
 * - Busca do nome oficial de bairro via votação por frequência entre múltiplos CEPs
 * - Busca do nome oficial de logradouro a partir de um CEP específico
 *
 * Cache: CEPs válidos e inválidos são cacheados para evitar chamadas desnecessárias.
 * Usa fetch nativo do Node 22+ para chamadas HTTP.
 */

import { cacheService } from "../cache.service.js";
import { env } from "../../config/env.js";

// Resposta da API ViaCEP (https://viacep.com.br/)
interface RespostaViaCep {
    cep: string;
    logradouro: string;
    complemento: string;
    unidade: string;
    bairro: string;
    localidade: string;
    uf: string;
    // Campo presente quando o CEP é inválido ou não encontrado
    erro?: boolean;
}

// Resultado padronizado de nome oficial (bairro ou logradouro)
export interface ResultadoOficial {
    // Nome oficial encontrado via API
    nomeOficial: string;
    // Fonte do dado (ex: "ViaCEP")
    fonte: string;
    // Confiança do resultado (0 a 1). Para logradouro = 1.0; para bairro = proporção de concordância
    score: number;
}

class ViaCepService {
    // URL base da API ViaCEP
    private readonly BASE_URL = "https://viacep.com.br/ws";

    // Prefixo das keys de cache no Redis
    private readonly CACHE_PREFIX = "viacep";

    /**
     * TTL do cache em segundos, calculado a partir da config em dias.
     * Getter para pegar sempre o valor atualizado do env.
     */
    private get cacheTtlSegundos(): number {
        return env.VIACEP_CACHE_TTL_DIAS * 24 * 60 * 60;
    }

    /**
     * Limite máximo de CEPs a consultar por membro (bairro).
     * Getter para pegar sempre o valor atualizado do env.
     */
    private get maxCepsPorMembro(): number {
        return env.VIACEP_MAX_CEPS_POR_MEMBRO;
    }

    /**
     * Consulta um CEP na API ViaCEP.
     *
     * - Limpa e valida o CEP (8 dígitos numéricos)
     * - Verifica cache Redis antes de chamar a API
     * - Cacheia tanto respostas válidas quanto inválidas (evita reconsultas)
     * - Retorna null em caso de erro ou CEP inválido
     */
    async consultarCep(cep: string): Promise<RespostaViaCep | null> {
        // Remove caracteres não numéricos do CEP (pontos, hífens, espaços)
        const cepLimpo = cep.replace(/\D/g, "");

        // Valida que o CEP possui exatamente 8 dígitos
        if (cepLimpo.length !== 8) {
            console.warn(
                `[ViaCepService] CEP inválido (não possui 8 dígitos): "${cep}"`
            );
            return null;
        }

        // Monta a key de cache no Redis
        const cacheKey = `${this.CACHE_PREFIX}:${cepLimpo}`;

        // Tenta buscar do cache antes de chamar a API
        const cacheado = await cacheService.get<RespostaViaCep>(cacheKey);
        if (cacheado !== null) {
            // Se o resultado cacheado indica erro, retorna null (CEP inválido cacheado)
            if (cacheado.erro) {
                return null;
            }
            return cacheado;
        }

        try {
            // Chama a API ViaCEP com o CEP limpo
            const url = `${this.BASE_URL}/${cepLimpo}/json/`;
            const resposta = await fetch(url);

            // Verifica se a resposta HTTP foi bem-sucedida
            if (!resposta.ok) {
                console.warn(
                    `[ViaCepService] Erro HTTP ${resposta.status} ao consultar CEP "${cepLimpo}"`
                );
                // Cacheia como erro para não reconsultar CEPs que dão erro HTTP
                await cacheService.set(
                    cacheKey,
                    { erro: true },
                    this.cacheTtlSegundos
                );
                return null;
            }

            // Parse da resposta JSON
            const dados = (await resposta.json()) as RespostaViaCep;

            // Cacheia o resultado (válido ou com erro) no Redis
            await cacheService.set(cacheKey, dados, this.cacheTtlSegundos);

            // Se a API retornou erro (CEP não encontrado), retorna null
            if (dados.erro) {
                return null;
            }

            return dados;
        } catch (err) {
            console.warn(
                `[ViaCepService] Erro ao consultar CEP "${cepLimpo}":`,
                err
            );
            // Cacheia como erro para evitar novas tentativas em CEPs que falham
            await cacheService.set(
                cacheKey,
                { erro: true },
                this.cacheTtlSegundos
            );
            return null;
        }
    }

    /**
     * Busca o nome oficial de um bairro consultando múltiplos CEPs em paralelo.
     *
     * Estratégia: consulta até N CEPs (configurável via env), coleta os nomes
     * de bairro retornados e retorna o nome mais frequente (votação por maioria).
     *
     * O score indica a proporção de CEPs que concordam com o nome vencedor.
     * Ex: se 7 de 10 CEPs retornam "Jardim América", score = 0.7
     *
     * @param ceps Lista de CEPs pertencentes ao mesmo bairro
     * @returns Nome oficial mais frequente, ou null se nenhum CEP retornou bairro
     */
    async buscarNomeBairro(ceps: string[]): Promise<ResultadoOficial | null> {
        // Limita a quantidade de CEPs consultados para não sobrecarregar a API
        const cepsLimitados = ceps.slice(0, this.maxCepsPorMembro);

        // Consulta todos os CEPs em paralelo usando Promise.allSettled
        // (não falha se algum CEP individual der erro)
        const resultados = await Promise.allSettled(
            cepsLimitados.map((cep) => this.consultarCep(cep))
        );

        // Mapa de frequência: nome do bairro → quantidade de ocorrências
        const frequenciaBairros = new Map<string, number>();
        // Contador de CEPs que retornaram dados válidos com bairro
        let totalConsultados = 0;

        for (const resultado of resultados) {
            // Ignora promessas rejeitadas (erros de rede, etc.)
            if (resultado.status !== "fulfilled") continue;

            const dados = resultado.value;

            // Ignora CEPs que retornaram null ou sem nome de bairro
            if (!dados || !dados.bairro) continue;

            totalConsultados++;

            // Incrementa a contagem de frequência do bairro retornado
            const nomeBairro = dados.bairro.trim();
            const contagemAtual = frequenciaBairros.get(nomeBairro) ?? 0;
            frequenciaBairros.set(nomeBairro, contagemAtual + 1);
        }

        // Se nenhum CEP retornou bairro válido, não há como determinar o nome
        if (totalConsultados === 0 || frequenciaBairros.size === 0) {
            return null;
        }

        // Encontra o bairro com maior frequência (votação por maioria)
        let bairroVencedor = "";
        let maiorContagem = 0;

        for (const [nome, contagem] of frequenciaBairros) {
            if (contagem > maiorContagem) {
                maiorContagem = contagem;
                bairroVencedor = nome;
            }
        }

        // Score = proporção de CEPs que concordam com o nome vencedor
        const score = maiorContagem / totalConsultados;

        return {
            nomeOficial: bairroVencedor,
            fonte: "ViaCEP",
            score,
        };
    }

    /**
     * Busca o nome oficial de um logradouro a partir de um CEP específico.
     *
     * Como cada CEP aponta para um logradouro exato, o score é sempre 1.0
     * (correspondência exata da fonte oficial).
     *
     * @param cep CEP do logradouro a consultar
     * @returns Nome oficial do logradouro, ou null se o CEP não retornou dados
     */
    async buscarNomeLogradouro(
        cep: string
    ): Promise<ResultadoOficial | null> {
        // Consulta o CEP na API ViaCEP
        const dados = await this.consultarCep(cep);

        // Se não retornou dados ou o logradouro está vazio, retorna null
        if (!dados || !dados.logradouro) {
            return null;
        }

        return {
            nomeOficial: dados.logradouro,
            fonte: "ViaCEP",
            // Score 1.0 = correspondência exata (CEP → logradouro é mapeamento direto)
            score: 1.0,
        };
    }
}

// Exporta como singleton para uso em toda a aplicação
export const viaCepService = new ViaCepService();

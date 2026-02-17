/**
 * LLMService — Análise semântica de duplicatas via Claude (Anthropic).
 *
 * Usa o modelo claude-haiku-4-5-20251001 (mais barato para structured output simples)
 * para determinar se dois registros de localidade brasileira representam a mesma entidade.
 * Retorna confiança, nome canônico sugerido e justificativa.
 */

import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env.js";
import {
    type LLMAnaliseResult,
    type TipoEntidade,
    TIPO_ENTIDADE_LABEL,
} from "../types/index.js";

// Modelo mais barato da Anthropic — ideal para classificação binária com JSON
const MODELO = "claude-haiku-4-5-20251001";

// Temperatura baixa para respostas determinísticas e consistentes
const TEMPERATURE = 0.1;

// Limite de tokens de saída (JSON curto, raramente excede 200 tokens)
const MAX_TOKENS = 512;

class LLMService {
    /** Cliente da Anthropic — inicializado apenas se a API key estiver presente */
    private client: Anthropic | null = null;

    constructor() {
        // Inicializa o client apenas se a chave de API estiver configurada
        if (env.ANTHROPIC_API_KEY) {
            this.client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
        } else {
            console.warn(
                "[LLMService] ANTHROPIC_API_KEY não configurada — análise semântica desabilitada."
            );
        }
    }

    /**
     * Analisa se dois registros de localidade são a mesma entidade.
     *
     * @param nomeA - Nome do primeiro registro
     * @param nomeB - Nome do segundo registro
     * @param tipo - Tipo da entidade (Cidade, Bairro, Logradouro, Condomínio)
     * @param contexto - Contexto geográfico (ex: "Bairro Marista, Goiânia-GO")
     * @returns Resultado da análise com confiança, nome canônico e justificativa
     */
    async analisarPar(
        nomeA: string,
        nomeB: string,
        tipo: number,
        contexto: string
    ): Promise<LLMAnaliseResult> {
        // Se a API key não está configurada, retorna resultado padrão sem chamar o LLM
        if (!this.client) {
            console.warn(
                "[LLMService] Pulando análise LLM — ANTHROPIC_API_KEY não configurada."
            );
            return {
                saoDuplicatas: false,
                confianca: 0,
                nomeCanonico: nomeA,
                justificativa: "LLM não configurado",
            };
        }

        // Resolve o label legível do tipo de entidade para uso no prompt
        const tipoLabel =
            TIPO_ENTIDADE_LABEL[tipo as TipoEntidade] ?? "Localidade";

        // Prompt em português instruindo o LLM a analisar duplicatas geográficas
        const prompt = `Você é um especialista em dados geográficos brasileiros.
Analise se estes dois registros de ${tipoLabel} são a mesma entidade:
- A: "${nomeA}"
- B: "${nomeB}"
- Localização: ${contexto}

Considere:
1. Prefixos equivalentes (Setor/Jardim/Vila = parte do nome oficial)
2. Abreviações (Ed./Edif./Edificio/Edifício = Condomínio)
3. Numeração (II = 2 = dois)
4. Variações ortográficas e de acentuação

Responda APENAS em JSON: {"sao_duplicatas": bool, "confianca": 0.0-1.0, "nome_canonico": "nome oficial correto", "justificativa": "explicação breve"}`;

        try {
            // Chama a API do Claude com o prompt de análise
            const response = await this.client.messages.create({
                model: MODELO,
                max_tokens: MAX_TOKENS,
                temperature: TEMPERATURE,
                messages: [{ role: "user", content: prompt }],
            });

            // Extrai o texto da resposta (primeiro bloco de texto)
            const textoResposta = response.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("");

            // Faz o parse do JSON retornado pelo LLM
            const resultado = this.parseRespostaLLM(textoResposta, nomeA);

            return resultado;
        } catch (error) {
            // Em caso de erro na API, loga e retorna resultado seguro (não duplicata)
            console.error(
                "[LLMService] Erro ao chamar Anthropic API:",
                error instanceof Error ? error.message : error
            );

            return {
                saoDuplicatas: false,
                confianca: 0,
                nomeCanonico: nomeA,
                justificativa: `Erro na análise LLM: ${error instanceof Error ? error.message : "erro desconhecido"}`,
            };
        }
    }

    /**
     * Faz o parse da resposta JSON do LLM e converte para o tipo interno.
     * Trata casos onde o LLM pode retornar markdown code blocks ou texto extra.
     *
     * @param texto - Texto bruto retornado pelo LLM
     * @param nomeA - Nome fallback caso o parse falhe
     * @returns Resultado parseado e normalizado
     */
    private parseRespostaLLM(
        texto: string,
        nomeA: string
    ): LLMAnaliseResult {
        try {
            // Remove possíveis code blocks de markdown (```json ... ```)
            const limpo = texto
                .replace(/```json\s*/gi, "")
                .replace(/```\s*/g, "")
                .trim();

            // Extrai o primeiro objeto JSON encontrado na resposta
            const jsonMatch = limpo.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                throw new Error("Nenhum JSON encontrado na resposta do LLM");
            }

            // Parse do JSON extraído
            const parsed = JSON.parse(jsonMatch[0]) as {
                sao_duplicatas?: boolean;
                confianca?: number;
                nome_canonico?: string;
                justificativa?: string;
            };

            // Converte de snake_case (padrão do prompt) para camelCase (padrão do TypeScript)
            return {
                saoDuplicatas: Boolean(parsed.sao_duplicatas),
                confianca: Math.max(
                    0,
                    Math.min(1, Number(parsed.confianca) || 0)
                ),
                nomeCanonico: parsed.nome_canonico ?? nomeA,
                justificativa:
                    parsed.justificativa ?? "Sem justificativa retornada",
            };
        } catch (error) {
            // Se o parse falhar, retorna resultado seguro com a justificativa do erro
            console.error(
                "[LLMService] Erro ao parsear resposta do LLM:",
                error instanceof Error ? error.message : error,
                "| Resposta bruta:",
                texto.substring(0, 500)
            );

            return {
                saoDuplicatas: false,
                confianca: 0,
                nomeCanonico: nomeA,
                justificativa: `Erro ao parsear resposta do LLM: ${error instanceof Error ? error.message : "erro desconhecido"}`,
            };
        }
    }
}

// Exporta como singleton para uso em toda a aplicação
export const llmService = new LLMService();

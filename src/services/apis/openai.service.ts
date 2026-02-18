/**
 * OpenAIValidationService — Validação de duplicatas via GPT-4o.
 *
 * Recebe um grupo de nomes candidatos a duplicatas (encontrados pelo pg_trgm)
 * e usa o LLM para confirmar se são realmente o mesmo local, identificar falsos
 * positivos e sugerir o nome canônico correto.
 *
 * Pipeline: pg_trgm (recall alto) → LLM (precision alta) → resultado confiável.
 */

import { env } from "../../config/env.js";
import { cacheService } from "../cache.service.js";

// Resultado da validação LLM para um grupo de duplicatas
export interface ValidacaoLLM {
    // Se o LLM confirma que os membros são o mesmo local
    saoDuplicatas: boolean;
    // Nível de confiança do LLM (0 a 1)
    confianca: number;
    // Nome canônico sugerido pelo LLM
    nomeCanonico: string;
    // Justificativa da decisão
    justificativa: string;
    // IDs dos membros que o LLM considera pertencerem ao grupo (pode excluir falsos positivos)
    membrosValidos: string[];
}

// Resposta da API da OpenAI
interface OpenAIResponse {
    choices: Array<{
        message: {
            content: string;
        };
    }>;
}

class OpenAIValidationService {
    // URL base da API da OpenAI
    private readonly baseUrl = "https://api.openai.com/v1/chat/completions";
    // Modelo a usar — GPT-5.2 (mais moderno e preciso)
    private readonly model = "gpt-5.2";

    /**
     * Verifica se o serviço está disponível (API key configurada).
     */
    get disponivel(): boolean {
        return !!env.OPENAI_API_KEY;
    }

    /**
     * Valida um grupo de nomes candidatos a duplicatas via LLM.
     * Envia os nomes dos membros + contexto geográfico e pede ao LLM para:
     * 1. Confirmar se são o mesmo local físico
     * 2. Identificar membros que NÃO pertencem ao grupo (falsos positivos)
     * 3. Sugerir o nome canônico correto
     *
     * @param nomesMembros - Lista de nomes dos membros do grupo
     * @param registroIds - IDs correspondentes aos nomes
     * @param tipoEntidade - Tipo: "bairro", "logradouro", "condominio" ou "cidade"
     * @param contexto - Contexto geográfico (cidade, estado, bairro, etc.)
     */
    async validarGrupo(
        nomesMembros: string[],
        registroIds: string[],
        tipoEntidade: string,
        contexto: {
            cidade?: string;
            estado?: string;
            bairro?: string;
            logradouro?: string;
        }
    ): Promise<ValidacaoLLM | null> {
        if (!this.disponivel) {
            console.warn("[OpenAI] API key não configurada — pulando validação LLM");
            return null;
        }

        // Cache para evitar chamadas repetidas ao LLM com os mesmos nomes
        const cacheKey = `openai:validacao:${this.normalizarParaCache(nomesMembros.join("|"))}`;
        const cached = await cacheService.get<ValidacaoLLM>(cacheKey);
        if (cached) {
            return cached;
        }

        try {
            // Monta o prompt com os nomes e contexto geográfico
            const prompt = this.montarPrompt(nomesMembros, registroIds, tipoEntidade, contexto);

            // Chama a API da OpenAI
            const response = await fetch(this.baseUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${env.OPENAI_API_KEY}`,
                },
                body: JSON.stringify({
                    model: this.model,
                    messages: [
                        {
                            role: "system",
                            content: `Você é um especialista em localidades brasileiras. Sua tarefa é analisar nomes de ${tipoEntidade}s e determinar se referem ao mesmo local físico. Responda SEMPRE em JSON válido.`,
                        },
                        { role: "user", content: prompt },
                    ],
                    temperature: 0.1, // Baixa temperatura para respostas consistentes
                    response_format: { type: "json_object" },
                }),
            });

            if (!response.ok) {
                console.warn(`[OpenAI] Erro HTTP ${response.status}: ${await response.text()}`);
                return null;
            }

            const data: OpenAIResponse = await response.json();
            const content = data.choices[0]?.message?.content;

            if (!content) {
                console.warn("[OpenAI] Resposta vazia do LLM");
                return null;
            }

            // Parse da resposta JSON do LLM
            const resultado = this.parseResposta(content, registroIds);

            // Cache por 7 dias (validação de duplicatas não muda frequentemente)
            await cacheService.set(cacheKey, resultado, 7 * 24 * 60 * 60);

            return resultado;
        } catch (err) {
            console.warn("[OpenAI] Erro na validação LLM:", err);
            return null;
        }
    }

    /**
     * Monta o prompt para o LLM com os nomes dos membros e contexto.
     */
    private montarPrompt(
        nomesMembros: string[],
        registroIds: string[],
        tipoEntidade: string,
        contexto: { cidade?: string; estado?: string; bairro?: string; logradouro?: string }
    ): string {
        // Formata a lista de membros com índice
        const listaMembros = nomesMembros
            .map((nome, i) => `  ${i + 1}. "${nome}" (ID: ${registroIds[i]})`)
            .join("\n");

        // Monta o contexto geográfico
        const ctxParts: string[] = [];
        if (contexto.logradouro) ctxParts.push(`Logradouro: ${contexto.logradouro}`);
        if (contexto.bairro) ctxParts.push(`Bairro: ${contexto.bairro}`);
        if (contexto.cidade) ctxParts.push(`Cidade: ${contexto.cidade}`);
        if (contexto.estado) ctxParts.push(`Estado: ${contexto.estado}`);
        const ctxStr = ctxParts.length > 0 ? `\nContexto geográfico: ${ctxParts.join(", ")}` : "";

        return `Analise os seguintes nomes de ${tipoEntidade}s encontrados no mesmo contexto geográfico. Determine se referem ao MESMO local físico ou são locais DIFERENTES.
${ctxStr}

Nomes candidatos a duplicatas:
${listaMembros}

ATENÇÃO:
- "${tipoEntidade}s" com sufixos numéricos diferentes (I, II, III, 1, 2, 3) são DIFERENTES (ex: "Parque Industrial I" ≠ "Parque Industrial II")
- "${tipoEntidade}s" com complementos como "Norte", "Sul", "Leste", "Oeste" são DIFERENTES
- CIDADES com complementos geográficos são municípios DISTINTOS (ex: "São Geraldo" ≠ "São Geraldo do Baixio", "Bom Jesus" ≠ "Bom Jesus do Itabapoana", "Santa Rita" ≠ "Santa Rita do Sapucaí"). Cada código IBGE = município separado.
- BAIRROS com complementos de setor são DIFERENTES (ex: "Setor Marista" ≠ "Setor Marista Sul")
- Variações de grafia do MESMO local são duplicatas (ex: "Condomínio Reserva Rio Cuiabá" = "Reserva Rio Cuiabá")
- Abreviações são duplicatas (ex: "Ed. Aurora" = "Edifício Aurora")
- Prefixos descritivos podem variar (ex: "Condomínio X" = "Residencial X" = "X" se são o mesmo lugar)

Responda em JSON com este formato exato:
{
  "sao_duplicatas": true/false,
  "confianca": 0.0 a 1.0,
  "nome_canonico": "nome mais correto e completo",
  "justificativa": "explicação breve da decisão",
  "membros_validos_ids": ["id1", "id2", ...]
}

Se apenas ALGUNS membros são duplicatas entre si, retorne sao_duplicatas=true com apenas os IDs dos membros que são de fato o mesmo local em membros_validos_ids.`;
    }

    /**
     * Parse da resposta JSON do LLM para o formato interno.
     */
    private parseResposta(content: string, registroIds: string[]): ValidacaoLLM {
        try {
            const json = JSON.parse(content);
            return {
                saoDuplicatas: json.sao_duplicatas === true,
                confianca: typeof json.confianca === "number" ? json.confianca : 0,
                nomeCanonico: json.nome_canonico ?? "",
                justificativa: json.justificativa ?? "",
                // Se o LLM não retornou IDs válidos, assume todos os membros
                membrosValidos: Array.isArray(json.membros_validos_ids)
                    ? json.membros_validos_ids.filter((id: string) => registroIds.includes(id))
                    : registroIds,
            };
        } catch {
            console.warn("[OpenAI] Erro ao parsear resposta JSON do LLM:", content);
            return {
                saoDuplicatas: false,
                confianca: 0,
                nomeCanonico: "",
                justificativa: "Erro ao parsear resposta do LLM",
                membrosValidos: [],
            };
        }
    }

    /**
     * Valida múltiplos grupos em uma única chamada ao LLM (economiza tokens e chamadas).
     * Envia até 10 grupos por chamada e retorna um mapa de índice → resultado.
     */
    async validarGruposBatch(
        grupos: Array<{
            nomesMembros: string[];
            registroIds: string[];
            contexto: { cidade?: string; estado?: string; bairro?: string; logradouro?: string };
        }>,
        tipoEntidade: string
    ): Promise<Map<number, ValidacaoLLM>> {
        const resultados = new Map<number, ValidacaoLLM>();

        if (!this.disponivel || grupos.length === 0) return resultados;

        // Verifica cache para cada grupo individualmente
        const gruposSemCache: number[] = [];
        for (let i = 0; i < grupos.length; i++) {
            const g = grupos[i];
            const cacheKey = `openai:validacao:${this.normalizarParaCache(g.nomesMembros.join("|"))}`;
            const cached = await cacheService.get<ValidacaoLLM>(cacheKey);
            if (cached) {
                resultados.set(i, cached);
            } else {
                gruposSemCache.push(i);
            }
        }

        if (gruposSemCache.length === 0) return resultados;

        try {
            // Monta prompt batch com todos os grupos sem cache
            const gruposTexto = gruposSemCache.map((idx, batchIdx) => {
                const g = grupos[idx];
                const membros = g.nomesMembros
                    .map((nome, j) => `    "${nome}" (ID: ${g.registroIds[j]})`)
                    .join("\n");
                const ctxParts: string[] = [];
                if (g.contexto.logradouro) ctxParts.push(`Logradouro: ${g.contexto.logradouro}`);
                if (g.contexto.bairro) ctxParts.push(`Bairro: ${g.contexto.bairro}`);
                if (g.contexto.cidade) ctxParts.push(`Cidade: ${g.contexto.cidade}`);
                if (g.contexto.estado) ctxParts.push(`Estado: ${g.contexto.estado}`);
                const ctx = ctxParts.length > 0 ? ` (${ctxParts.join(", ")})` : "";
                return `  GRUPO ${batchIdx + 1}${ctx}:\n${membros}`;
            }).join("\n\n");

            const prompt = `Analise os seguintes grupos de nomes de ${tipoEntidade}s. Para CADA grupo, determine se os membros referem ao MESMO local físico.

REGRAS:
- Sufixos numéricos diferentes (I, II, III, 1, 2, 3) = locais DIFERENTES
- Complementos Norte/Sul/Leste/Oeste = locais DIFERENTES
- Variações de grafia do MESMO local = duplicatas (ex: "Condomínio X" = "Residencial X" = "X")
- Abreviações = duplicatas (ex: "Ed. Aurora" = "Edifício Aurora")

${gruposTexto}

Responda em JSON com este formato exato:
{
  "grupos": [
    {
      "grupo": 1,
      "sao_duplicatas": true/false,
      "confianca": 0.0 a 1.0,
      "nome_canonico": "nome mais correto",
      "justificativa": "breve",
      "membros_validos_ids": ["id1", "id2"]
    }
  ]
}`;

            const response = await fetch(this.baseUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${env.OPENAI_API_KEY}`,
                },
                body: JSON.stringify({
                    model: this.model,
                    messages: [
                        {
                            role: "system",
                            content: `Você é um especialista em localidades brasileiras. Analise grupos de nomes e determine duplicatas. Responda SEMPRE em JSON válido.`,
                        },
                        { role: "user", content: prompt },
                    ],
                    temperature: 0.1,
                    response_format: { type: "json_object" },
                }),
            });

            if (!response.ok) {
                console.warn(`[OpenAI Batch] Erro HTTP ${response.status}: ${await response.text()}`);
                return resultados;
            }

            const data: OpenAIResponse = await response.json();
            const content = data.choices[0]?.message?.content;
            if (!content) return resultados;

            // Parse da resposta batch
            const json = JSON.parse(content);
            const gruposResp = json.grupos ?? [];

            for (const resp of gruposResp) {
                const batchIdx = (resp.grupo ?? 0) - 1;
                if (batchIdx < 0 || batchIdx >= gruposSemCache.length) continue;

                const originalIdx = gruposSemCache[batchIdx];
                const g = grupos[originalIdx];

                const validacao: ValidacaoLLM = {
                    saoDuplicatas: resp.sao_duplicatas === true,
                    confianca: typeof resp.confianca === "number" ? resp.confianca : 0,
                    nomeCanonico: resp.nome_canonico ?? "",
                    justificativa: resp.justificativa ?? "",
                    membrosValidos: Array.isArray(resp.membros_validos_ids)
                        ? resp.membros_validos_ids.filter((id: string) => g.registroIds.includes(id))
                        : g.registroIds,
                };

                resultados.set(originalIdx, validacao);

                // Cache individual por 7 dias
                const cacheKey = `openai:validacao:${this.normalizarParaCache(g.nomesMembros.join("|"))}`;
                await cacheService.set(cacheKey, validacao, 7 * 24 * 60 * 60);
            }
        } catch (err) {
            console.warn("[OpenAI Batch] Erro na validação LLM batch:", err);
        }

        return resultados;
    }

    /**
     * Normaliza string para chave de cache.
     */
    private normalizarParaCache(str: string): string {
        return str
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, "-")
            .trim();
    }
}

// Exporta como singleton
export const openaiValidationService = new OpenAIValidationService();

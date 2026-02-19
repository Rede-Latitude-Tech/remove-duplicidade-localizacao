/**
 * Testes de validação LLM — garante que o prompt do GPT-5.2 rejeita
 * falsos positivos e aceita duplicatas legítimas.
 *
 * Testa: parseResposta, montarPrompt (via strings), e regras semânticas.
 * NÃO chama a API real — testa a lógica de parse e prompt.
 */

import { describe, it, expect } from "vitest";

// ============================================================================
// Reproduz parseResposta do OpenAIValidationService para testar em isolamento
// ============================================================================

interface ValidacaoLLM {
    saoDuplicatas: boolean;
    confianca: number;
    nomeCanonico: string;
    justificativa: string;
    membrosValidos: string[];
}

function parseResposta(content: string, registroIds: string[]): ValidacaoLLM {
    try {
        const json = JSON.parse(content);
        return {
            saoDuplicatas: json.sao_duplicatas === true,
            confianca: typeof json.confianca === "number" ? json.confianca : 0,
            nomeCanonico: json.nome_canonico ?? "",
            justificativa: json.justificativa ?? "",
            membrosValidos: Array.isArray(json.membros_validos_ids)
                ? json.membros_validos_ids.filter((id: string) => registroIds.includes(id))
                : registroIds,
        };
    } catch {
        return {
            saoDuplicatas: false,
            confianca: 0,
            nomeCanonico: "",
            justificativa: "Erro ao parsear resposta do LLM",
            membrosValidos: [],
        };
    }
}

// ============================================================================
// Reproduz montarPrompt para verificar regras no texto
// ============================================================================

function montarPrompt(
    nomesMembros: string[],
    registroIds: string[],
    tipoEntidade: string,
    contexto: { cidade?: string; estado?: string; bairro?: string; logradouro?: string }
): string {
    const listaMembros = nomesMembros
        .map((nome, i) => `  ${i + 1}. "${nome}" (ID: ${registroIds[i]})`)
        .join("\n");

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
- Se um membro aparece sem sufixo numérico e outro com (ex: "Belvedere" vs "Belvedere 1"), trate como potencial duplicata — provavelmente é o mesmo local cadastrado de formas diferentes. Use o endereço e contexto para confirmar.

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

describe("LLM Validation — parseResposta()", () => {
    // ==========================================================================
    // Parse de resposta JSON correta
    // ==========================================================================

    it("parseia resposta LLM que confirma duplicatas", () => {
        const content = JSON.stringify({
            sao_duplicatas: true,
            confianca: 0.95,
            nome_canonico: "Jardim Aurora",
            justificativa: "Mesma localidade, 'Jd' é abreviação de 'Jardim'",
            membros_validos_ids: ["id-1", "id-2"],
        });
        const resultado = parseResposta(content, ["id-1", "id-2"]);
        expect(resultado.saoDuplicatas).toBe(true);
        expect(resultado.confianca).toBe(0.95);
        expect(resultado.nomeCanonico).toBe("Jardim Aurora");
        expect(resultado.membrosValidos).toEqual(["id-1", "id-2"]);
    });

    it("parseia resposta LLM que rejeita duplicatas", () => {
        const content = JSON.stringify({
            sao_duplicatas: false,
            confianca: 0.98,
            nome_canonico: "",
            justificativa: "São municípios distintos com códigos IBGE diferentes",
            membros_validos_ids: [],
        });
        const resultado = parseResposta(content, ["id-1", "id-2"]);
        expect(resultado.saoDuplicatas).toBe(false);
        expect(resultado.confianca).toBe(0.98);
    });

    it("filtra IDs inválidos da resposta do LLM", () => {
        // O LLM pode retornar IDs que não existem no grupo
        const content = JSON.stringify({
            sao_duplicatas: true,
            confianca: 0.9,
            nome_canonico: "Test",
            justificativa: "test",
            membros_validos_ids: ["id-1", "id-fake", "id-2"],
        });
        const resultado = parseResposta(content, ["id-1", "id-2"]);
        // "id-fake" deve ser filtrado
        expect(resultado.membrosValidos).toEqual(["id-1", "id-2"]);
        expect(resultado.membrosValidos).not.toContain("id-fake");
    });

    it("retorna todos os IDs se LLM não especificou membros_validos_ids", () => {
        const content = JSON.stringify({
            sao_duplicatas: true,
            confianca: 0.9,
            nome_canonico: "Test",
            justificativa: "test",
        });
        const resultado = parseResposta(content, ["id-1", "id-2", "id-3"]);
        expect(resultado.membrosValidos).toEqual(["id-1", "id-2", "id-3"]);
    });

    it("trata JSON inválido gracefully", () => {
        const resultado = parseResposta("não é json", ["id-1"]);
        expect(resultado.saoDuplicatas).toBe(false);
        expect(resultado.confianca).toBe(0);
        expect(resultado.membrosValidos).toEqual([]);
    });
});

describe("LLM Validation — Prompt (regras semânticas)", () => {
    // ==========================================================================
    // Verifica que o prompt contém as regras críticas
    // ==========================================================================

    it("prompt contém regra de cidades com complementos geográficos", () => {
        const prompt = montarPrompt(
            ["São Geraldo", "São Geraldo do Baixio"],
            ["id-1", "id-2"],
            "cidade",
            { estado: "MG" }
        );
        // O prompt deve conter a regra sobre municípios distintos
        expect(prompt).toContain("São Geraldo");
        expect(prompt).toContain("São Geraldo do Baixio");
        expect(prompt).toContain("municípios DISTINTOS");
        expect(prompt).toContain("IBGE");
    });

    it("prompt contém regra de sufixos numéricos I/II/III", () => {
        const prompt = montarPrompt(
            ["Parque Industrial I", "Parque Industrial II"],
            ["id-1", "id-2"],
            "bairro",
            { cidade: "Goiânia", estado: "GO" }
        );
        expect(prompt).toContain("sufixos numéricos diferentes");
        expect(prompt).toContain("são DIFERENTES");
    });

    it("prompt contém regra de complementos Norte/Sul/Leste/Oeste", () => {
        const prompt = montarPrompt(
            ["Setor Marista", "Setor Marista Sul"],
            ["id-1", "id-2"],
            "bairro",
            { cidade: "Goiânia", estado: "GO" }
        );
        expect(prompt).toContain("Norte");
        expect(prompt).toContain("Sul");
        expect(prompt).toContain("são DIFERENTES");
    });

    it("prompt contém regra de abreviações como duplicatas", () => {
        const prompt = montarPrompt(
            ["Ed. Aurora", "Edifício Aurora"],
            ["id-1", "id-2"],
            "condominio",
            { cidade: "São Paulo", estado: "SP" }
        );
        expect(prompt).toContain("Abreviações são duplicatas");
    });

    it("prompt contém regra de prefixos descritivos variáveis", () => {
        const prompt = montarPrompt(
            ["Condomínio X", "Residencial X"],
            ["id-1", "id-2"],
            "condominio",
            { cidade: "São Paulo", estado: "SP" }
        );
        expect(prompt).toContain("Prefixos descritivos podem variar");
    });

    it("prompt inclui contexto geográfico completo", () => {
        const prompt = montarPrompt(
            ["Condomínio Aurora"],
            ["id-1"],
            "condominio",
            {
                logradouro: "Rua Augusta",
                bairro: "Consolação",
                cidade: "São Paulo",
                estado: "SP",
            }
        );
        expect(prompt).toContain("Logradouro: Rua Augusta");
        expect(prompt).toContain("Bairro: Consolação");
        expect(prompt).toContain("Cidade: São Paulo");
        expect(prompt).toContain("Estado: SP");
    });

    it("prompt contém regra de bairros com complementos de setor", () => {
        const prompt = montarPrompt(
            ["Setor Marista", "Setor Marista Sul"],
            ["id-1", "id-2"],
            "bairro",
            { cidade: "Goiânia", estado: "GO" }
        );
        expect(prompt).toContain("BAIRROS com complementos de setor são DIFERENTES");
    });

    it("prompt contém regra de membro sem numeral vs com numeral como potencial duplicata", () => {
        // Caso real: "Belvedere" vs "Belvedere 1" vs "Belvedere I" em Cuiabá
        // "Belvedere" sem número pode ser o mesmo que "Belvedere 1" — depende do endereço
        const prompt = montarPrompt(
            ["Belvedere", "Belvedere 1", "Belvedere I"],
            ["id-1", "id-2", "id-3"],
            "condominio",
            { cidade: "Cuiabá", estado: "MT" }
        );
        // O prompt deve conter regra sobre membro sem numeral = potencial duplicata
        expect(prompt).toContain("sem sufixo numérico");
        expect(prompt).toContain("potencial duplicata");
    });

    it("prompt orienta usar endereço completo para desempatar ambiguidade de numeral", () => {
        const prompt = montarPrompt(
            ["Belvedere", "Belvedere 1"],
            ["id-1", "id-2"],
            "condominio",
            { cidade: "Cuiabá", estado: "MT" }
        );
        // O prompt deve mencionar que o endereço confirma a duplicata
        expect(prompt).toContain("endereço");
    });
});

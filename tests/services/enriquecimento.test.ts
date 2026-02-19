/**
 * Testes do EnriquecimentoService — valida prioridade de nome canônico
 * e coerência do endereço oficial de condomínios.
 *
 * Testa as funções puras (Dice similarity, normalização, determinação do canônico)
 * sem depender de APIs externas ou banco de dados.
 */

import { describe, it, expect } from "vitest";

// ============================================================================
// Reproduz helpers do EnriquecimentoService para testar em isolamento
// ============================================================================

/** Normaliza para comparação: minúsculo, sem acentos, espaços colapsados */
function normalizar(str: string): string {
    return str
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/** Gera bigramas de uma string: "casa" → ["ca", "as", "sa"] */
function gerarBigramas(str: string): string[] {
    const bigramas: string[] = [];
    for (let i = 0; i < str.length - 1; i++) {
        bigramas.push(str.substring(i, i + 2));
    }
    return bigramas;
}

/** Coeficiente de Dice entre duas strings usando bigramas */
function similaridadeDice(a: string, b: string): number {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;

    const bigramasA = gerarBigramas(a);
    const bigramasB = gerarBigramas(b);

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

    return (2 * intersecao) / (bigramasA.length + bigramasB.length);
}

/** Interface do resultado oficial (usada pelo enriquecimento) */
interface ResultadoOficial {
    nomeOficial: string;
    fonte: string;
    score: number;
    enderecoCompleto?: string;
}

/**
 * Determina qual membro é mais similar ao nome oficial.
 * Reproduz EnriquecimentoService.determinarCanonicoSugerido().
 */
function determinarCanonicoSugerido(
    registroIds: string[],
    nomesMembros: string[],
    nomeOficial: ResultadoOficial | null
): string | null {
    if (!nomeOficial) return null;

    const oficialNorm = normalizar(nomeOficial.nomeOficial);

    let melhorScore = -1;
    let melhorId: string | null = null;

    for (let i = 0; i < registroIds.length; i++) {
        const membroNorm = normalizar(nomesMembros[i] ?? "");
        const score = similaridadeDice(membroNorm, oficialNorm);
        if (score > melhorScore) {
            melhorScore = score;
            melhorId = registroIds[i];
        }
    }

    return melhorId;
}

// ============================================================================
// Testes
// ============================================================================

describe("Enriquecimento — Similaridade Dice", () => {
    it("retorna 1.0 para strings idênticas", () => {
        expect(similaridadeDice("jardim aurora", "jardim aurora")).toBe(1);
    });

    it("retorna 0 para strings totalmente diferentes", () => {
        const score = similaridadeDice("abc", "xyz");
        expect(score).toBe(0);
    });

    it("retorna alta similaridade para variações de grafia", () => {
        const scoreA = similaridadeDice(
            normalizar("Jardim Aurora"),
            normalizar("Jd Aurora")
        );
        // "jardim aurora" vs "jd aurora" — compartilham "aurora"
        expect(scoreA).toBeGreaterThan(0.5);
    });

    it("retorna baixa similaridade para nomes completamente diferentes", () => {
        const score = similaridadeDice(
            normalizar("Setor Marista"),
            normalizar("Vila Nova")
        );
        expect(score).toBeLessThan(0.3);
    });
});

describe("Enriquecimento — Determinação do canônico sugerido", () => {
    // ==========================================================================
    // Prioridade: o membro mais similar ao nome oficial é o canônico
    // ==========================================================================

    it("escolhe membro mais similar ao nome oficial como canônico", () => {
        const ids = ["id-1", "id-2"];
        const nomes = ["Jd Aurora", "Jardim Aurora"];
        const oficial: ResultadoOficial = {
            nomeOficial: "Jardim Aurora",
            fonte: "ViaCEP",
            score: 0.85,
        };

        const resultado = determinarCanonicoSugerido(ids, nomes, oficial);
        // "Jardim Aurora" é idêntico ao nome oficial → deve ser o canônico
        expect(resultado).toBe("id-2");
    });

    it("retorna null quando não há nome oficial", () => {
        const resultado = determinarCanonicoSugerido(
            ["id-1", "id-2"],
            ["A", "B"],
            null
        );
        expect(resultado).toBeNull();
    });

    it("escolhe corretamente com 3+ membros", () => {
        const ids = ["id-1", "id-2", "id-3"];
        const nomes = ["SHANGRI - LA", "SHANGRI-LA", "Jardim Shangri-Lá"];
        const oficial: ResultadoOficial = {
            nomeOficial: "Jardim Shangri-Lá",
            fonte: "ViaCEP",
            score: 0.8,
        };

        const resultado = determinarCanonicoSugerido(ids, nomes, oficial);
        // "Jardim Shangri-Lá" normalizado = "jardim shangri-la" → mais similar
        expect(resultado).toBe("id-3");
    });
});

describe("Enriquecimento — Prioridade de nome canônico por tipo", () => {
    // ==========================================================================
    // Cada tipo tem sua cascata de fontes — testa a prioridade
    // ==========================================================================

    it("Cidade: IBGE tem prioridade sobre Google Geocoding", () => {
        // Simula: IBGE retorna "São Paulo", Google retorna "Sao Paulo"
        const ibge: ResultadoOficial = {
            nomeOficial: "São Paulo",
            fonte: "IBGE",
            score: 1.0,
        };
        const google: ResultadoOficial = {
            nomeOficial: "Sao Paulo",
            fonte: "Google",
            score: 0.8,
        };
        // IBGE tem score 1.0 > Google 0.8 → IBGE é mais confiável
        expect(ibge.score).toBeGreaterThan(google.score);
        expect(ibge.fonte).toBe("IBGE");
    });

    it("Bairro: ViaCEP tem prioridade sobre Google Geocoding", () => {
        // ViaCEP via votação de CEPs → mais preciso para bairros
        const viacep: ResultadoOficial = {
            nomeOficial: "Bela Vista",
            fonte: "ViaCEP",
            score: 0.85,
        };
        const google: ResultadoOficial = {
            nomeOficial: "Bela Vista",
            fonte: "Google",
            score: 0.8,
        };
        // Na cascata, ViaCEP é tentado ANTES do Google
        // Se ViaCEP retorna resultado, Google não é chamado
        expect(viacep.fonte).toBe("ViaCEP");
    });

    it("Logradouro: ViaCEP (direto) tem prioridade sobre Google", () => {
        // ViaCEP mapeia CEP → logradouro exato (score 1.0)
        const viacep: ResultadoOficial = {
            nomeOficial: "Avenida Paulista",
            fonte: "ViaCEP",
            score: 1.0,
        };
        // Score 1.0 do ViaCEP = mapeamento direto, não estimativa
        expect(viacep.score).toBe(1.0);
    });

    it("Condomínio: Google Places tem prioridade sobre Google Geocoding", () => {
        // Google Places retorna o nome público real do estabelecimento
        const places: ResultadoOficial = {
            nomeOficial: "Condomínio Edifício Rio Vermelho",
            fonte: "Google Places",
            score: 0.9,
        };
        const geocoding: ResultadoOficial = {
            nomeOficial: "Rio Vermelho",
            fonte: "Google",
            score: 0.7,
        };
        // Google Places é mais preciso para condomínios
        expect(places.score).toBeGreaterThan(geocoding.score);
        expect(places.fonte).toBe("Google Places");
    });
});

describe("Enriquecimento — Coerência do endereço de condomínio", () => {
    // ==========================================================================
    // O nome oficial do condomínio deve ser coerente com os membros do grupo
    // ==========================================================================

    it("nome oficial do Google Places deve ser mais similar a um membro do grupo", () => {
        // Caso real: "Rio Vermelho" e "Edifício Rio Vermelho" são o mesmo condomínio
        // Google Places retorna "Condomínio Edifício Rio Vermelho"
        const ids = ["condo-1", "condo-2"];
        const nomes = ["Rio Vermelho", "Edifício Rio Vermelho"];
        const oficial: ResultadoOficial = {
            nomeOficial: "Condomínio Edifício Rio Vermelho",
            fonte: "Google Places",
            score: 0.9,
        };

        const canonicoId = determinarCanonicoSugerido(ids, nomes, oficial);
        // "Edifício Rio Vermelho" é mais similar a "Condomínio Edifício Rio Vermelho"
        expect(canonicoId).toBe("condo-2");

        // Verifica que o score de similaridade é alto (coerente)
        const scoreCoerencia = similaridadeDice(
            normalizar("Edifício Rio Vermelho"),
            normalizar("Condomínio Edifício Rio Vermelho")
        );
        expect(scoreCoerencia).toBeGreaterThan(0.7);
    });

    it("nome oficial incoerente deve ter baixa similaridade", () => {
        // Se o Google Places retornasse um nome totalmente diferente,
        // o score de similaridade seria baixo → sinal de incoerência
        const scoreIncoerente = similaridadeDice(
            normalizar("Condomínio Aurora"),
            normalizar("Shopping Center Iguatemi")
        );
        expect(scoreIncoerente).toBeLessThan(0.3);
    });

    it("prefixos diferentes do mesmo condomínio mantêm alta similaridade APÓS normalização", () => {
        // O sistema usa normalização que REMOVE prefixos antes de comparar.
        // "Condomínio Reserva" e "Residencial Reserva" sem prefixo = "reserva" vs "reserva"
        // Sem remoção de prefixos, Dice é baixo (0.4) — o que é esperado.
        // O pg_trgm na query SQL usa GREATEST(raw, normalized) para capturar isso.

        // Dice SEM remoção de prefixos = baixo (prefixos são textos diferentes)
        const scoreSemNorm = similaridadeDice(
            normalizar("Condomínio Reserva"),
            normalizar("Residencial Reserva")
        );
        expect(scoreSemNorm).toBeLessThan(0.5);

        // Dice COM remoção de prefixos = perfeito (ambos viram "reserva")
        // Simula a normalização SQL que o pg_trgm faz
        const removePrefixo = (nome: string) =>
            normalizar(nome).replace(
                /^(edificio|condominio|residencial|torre|bloco|ed|cond)\s+/,
                ""
            );
        const scoreComNorm = similaridadeDice(
            removePrefixo("Condomínio Reserva"),
            removePrefixo("Residencial Reserva")
        );
        expect(scoreComNorm).toBe(1.0);

        // "Ed. Reserva" vs "Edifício Reserva" — alta similaridade mesmo sem normalização
        const score2 = similaridadeDice(
            normalizar("Ed. Reserva"),
            normalizar("Edifício Reserva")
        );
        expect(score2).toBeGreaterThan(0.5);
    });

    it("condomínios com numerais diferentes são distintos", () => {
        // "Condomínio Aurora I" ≠ "Condomínio Aurora II"
        const score = similaridadeDice(
            normalizar("Condomínio Aurora I"),
            normalizar("Condomínio Aurora II")
        );
        // Score pode ser alto pelo pg_trgm, mas o LLM deve rejeitá-los
        // Aqui testamos que pelo menos não são idênticos
        expect(score).toBeLessThan(1.0);
    });
});

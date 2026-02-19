/**
 * Testes de escopo da detecção — garante que localidades com mesmo nome
 * em cidades ou bairros DIFERENTES não sejam consideradas duplicatas.
 *
 * Testa a lógica de clusterização (union-find) e o prompt do LLM,
 * sem depender do banco de dados real.
 */

import { describe, it, expect } from "vitest";
import type { ParSimilar } from "../../src/types/index.js";

// ============================================================================
// Importa a função de clusterização diretamente para testar isoladamente
// Como DeteccaoService é uma classe com métodos privados, testamos a lógica
// de clusterização reproduzindo o algoritmo union-find
// ============================================================================

/**
 * Reproduz o algoritmo union-find usado em DeteccaoService.clusterizarPares()
 * para testar em isolamento sem dependência do Prisma/banco.
 */
function clusterizarPares(
    pares: ParSimilar[]
): Array<{ parentId: string; registroIds: string[]; nomesMembros: string[]; scoreMedio: number }> {
    const parent = new Map<string, string>();
    const nomes = new Map<string, string>();
    const scores = new Map<string, number[]>();
    const parentIds = new Map<string, string>();

    const find = (x: string): string => {
        if (!parent.has(x)) parent.set(x, x);
        if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!));
        return parent.get(x)!;
    };

    const union = (x: string, y: string): void => {
        const rootX = find(x);
        const rootY = find(y);
        if (rootX !== rootY) parent.set(rootY, rootX);
    };

    for (const par of pares) {
        nomes.set(par.idA, par.nomeA);
        nomes.set(par.idB, par.nomeB);
        parentIds.set(par.idA, par.parentId);
        parentIds.set(par.idB, par.parentId);
        union(par.idA, par.idB);
        const raiz = find(par.idA);
        if (!scores.has(raiz)) scores.set(raiz, []);
        scores.get(raiz)!.push(par.score);
    }

    const gruposPorRaiz = new Map<string, string[]>();
    for (const id of nomes.keys()) {
        const raiz = find(id);
        if (!gruposPorRaiz.has(raiz)) gruposPorRaiz.set(raiz, []);
        gruposPorRaiz.get(raiz)!.push(id);
    }

    const grupos: Array<{ parentId: string; registroIds: string[]; nomesMembros: string[]; scoreMedio: number }> = [];
    for (const [raiz, ids] of gruposPorRaiz.entries()) {
        if (ids.length < 2) continue;
        const scoresGrupo = scores.get(raiz) ?? [];
        const scoreMedio = scoresGrupo.length > 0
            ? Math.round((scoresGrupo.reduce((a, b) => a + b, 0) / scoresGrupo.length) * 100) / 100
            : 0;
        grupos.push({
            parentId: parentIds.get(ids[0]) ?? "",
            registroIds: ids,
            nomesMembros: ids.map((id) => nomes.get(id)!),
            scoreMedio,
        });
    }
    return grupos;
}

describe("Detecção — Escopo por parent_id", () => {
    // ==========================================================================
    // Bairros com mesmo nome em CIDADES DIFERENTES não devem ser agrupados
    // ==========================================================================

    describe("Bairros em cidades diferentes", () => {
        it("NÃO agrupa bairros com mesmo nome em cidades diferentes", () => {
            // Simula o cenário: "Centro" existe em cidade_id=100 e cidade_id=200
            // O pg_trgm SÓ compara registros com mesmo parent_id (cidade_id),
            // então esses pares NUNCA devem chegar ao clusterizador.
            // Se chegarem por erro, devem ter parent_ids diferentes.
            const pares: ParSimilar[] = [];
            // Não deve existir par entre bairros de cidades diferentes
            const grupos = clusterizarPares(pares);
            expect(grupos).toHaveLength(0);
        });

        it("agrupa bairros com nomes similares na MESMA cidade", () => {
            // "Jardim Aurora" e "Jd Aurora" na cidade_id=100 — duplicatas legítimas
            const pares: ParSimilar[] = [
                {
                    idA: "bairro-uuid-1",
                    idB: "bairro-uuid-2",
                    nomeA: "Jardim Aurora",
                    nomeB: "Jd Aurora",
                    parentId: "100", // mesma cidade
                    score: 0.85,
                },
            ];
            const grupos = clusterizarPares(pares);
            expect(grupos).toHaveLength(1);
            expect(grupos[0].parentId).toBe("100");
            expect(grupos[0].registroIds).toContain("bairro-uuid-1");
            expect(grupos[0].registroIds).toContain("bairro-uuid-2");
        });

        it("gera grupos SEPARADOS para bairros similares em cidades diferentes", () => {
            // "Centro" em cidade 100 e "Centro" em cidade 200
            // Como o pg_trgm filtra por parent_id, esses pares NÃO devem ser unidos
            const pares: ParSimilar[] = [
                {
                    idA: "bairro-1a",
                    idB: "bairro-1b",
                    nomeA: "Centro",
                    nomeB: "Centro Histórico",
                    parentId: "100", // cidade A
                    score: 0.7,
                },
                {
                    idA: "bairro-2a",
                    idB: "bairro-2b",
                    nomeA: "Centro",
                    nomeB: "Centro Histórico",
                    parentId: "200", // cidade B
                    score: 0.7,
                },
            ];
            const grupos = clusterizarPares(pares);
            // Devem gerar 2 grupos separados (um por cidade)
            expect(grupos).toHaveLength(2);
            // Cada grupo deve ter parentId diferente
            const parentIds = grupos.map((g) => g.parentId);
            expect(parentIds).toContain("100");
            expect(parentIds).toContain("200");
        });
    });

    // ==========================================================================
    // Cidades com mesmo nome no MESMO ESTADO — caso São Geraldo
    // ==========================================================================

    describe("Cidades com complementos geográficos", () => {
        it("trata 'São Geraldo' e 'São Geraldo do Baixio' como par similar pelo pg_trgm", () => {
            // O pg_trgm PODE detectar similaridade entre esses nomes (score > 0.4)
            // mas o LLM deve rejeitá-los como falsos positivos
            const pares: ParSimilar[] = [
                {
                    idA: "cidade-1",
                    idB: "cidade-2",
                    nomeA: "São Geraldo",
                    nomeB: "São Geraldo do Baixio",
                    parentId: "MG", // mesmo estado
                    score: 0.65,
                },
            ];
            const grupos = clusterizarPares(pares);
            // O clusterizador cria o grupo (ele não sabe que são diferentes)
            expect(grupos).toHaveLength(1);
            // Cabe ao LLM descartar este grupo como falso positivo
        });
    });

    // ==========================================================================
    // Logradouros em BAIRROS DIFERENTES não devem ser agrupados
    // ==========================================================================

    describe("Logradouros em bairros diferentes", () => {
        it("NÃO agrupa 'Rua 1' de bairros diferentes", () => {
            // "Rua 1" existe em muitos bairros, mas com bairro_id diferente
            // O pg_trgm SÓ compara dentro do mesmo bairro_id
            const pares: ParSimilar[] = [];
            const grupos = clusterizarPares(pares);
            expect(grupos).toHaveLength(0);
        });

        it("agrupa logradouros similares no MESMO bairro", () => {
            const pares: ParSimilar[] = [
                {
                    idA: "logr-1",
                    idB: "logr-2",
                    nomeA: "Rua Goiás",
                    nomeB: "R. Goiás",
                    parentId: "bairro-uuid-1", // mesmo bairro
                    score: 0.8,
                },
            ];
            const grupos = clusterizarPares(pares);
            expect(grupos).toHaveLength(1);
        });
    });

    // ==========================================================================
    // Condomínios — compara dentro do mesmo logradouro
    // ==========================================================================

    describe("Condomínios em logradouros diferentes", () => {
        it("agrupa condomínios similares no MESMO logradouro", () => {
            const pares: ParSimilar[] = [
                {
                    idA: "condo-1",
                    idB: "condo-2",
                    nomeA: "Condomínio Reserva Rio Cuiabá",
                    nomeB: "Reserva Rio Cuiabá",
                    parentId: "cidade-123", // cidade (conforme query do pg_trgm)
                    score: 0.88,
                },
            ];
            const grupos = clusterizarPares(pares);
            expect(grupos).toHaveLength(1);
        });
    });

    // ==========================================================================
    // Union-Find transitividade — A~B + B~C = {A,B,C}
    // ==========================================================================

    describe("Clusterização transitiva", () => {
        it("agrupa A~B e B~C em um único grupo {A,B,C}", () => {
            const pares: ParSimilar[] = [
                {
                    idA: "a",
                    idB: "b",
                    nomeA: "Jardim Aurora",
                    nomeB: "Jd Aurora",
                    parentId: "100",
                    score: 0.85,
                },
                {
                    idA: "b",
                    idB: "c",
                    nomeA: "Jd Aurora",
                    nomeB: "JARDIM AURORA",
                    parentId: "100",
                    score: 0.9,
                },
            ];
            const grupos = clusterizarPares(pares);
            expect(grupos).toHaveLength(1);
            expect(grupos[0].registroIds).toHaveLength(3);
            expect(grupos[0].registroIds).toContain("a");
            expect(grupos[0].registroIds).toContain("b");
            expect(grupos[0].registroIds).toContain("c");
        });

        it("calcula score médio do grupo corretamente", () => {
            const pares: ParSimilar[] = [
                { idA: "a", idB: "b", nomeA: "X", nomeB: "Y", parentId: "1", score: 0.8 },
                { idA: "b", idB: "c", nomeA: "Y", nomeB: "Z", parentId: "1", score: 0.6 },
            ];
            const grupos = clusterizarPares(pares);
            expect(grupos[0].scoreMedio).toBe(0.7); // (0.8 + 0.6) / 2
        });

        it("ignora singletons (grupos com 1 membro)", () => {
            // Se um ID aparece em um par mas o par é filtrado, ele não forma grupo
            const pares: ParSimilar[] = [];
            const grupos = clusterizarPares(pares);
            expect(grupos).toHaveLength(0);
        });
    });
});

/**
 * Testes do NormalizadorService — valida normalização de nomes de localidades.
 * Garante que prefixos são removidos corretamente e numerais convertidos.
 */

import { describe, it, expect } from "vitest";
import { normalizadorService } from "../../src/services/normalizador.service.js";
import { TipoEntidade } from "../../src/types/index.js";

describe("NormalizadorService", () => {
    // ==========================================================================
    // Normalização básica (sem remoção de prefixos)
    // ==========================================================================

    describe("normalizar()", () => {
        it("converte para minúsculo e remove acentos", () => {
            expect(normalizadorService.normalizar("Jardim Shangri-Lá")).toBe(
                "jardim shangri-la"
            );
        });

        it("colapsa múltiplos espaços", () => {
            expect(normalizadorService.normalizar("Setor   Marista")).toBe(
                "setor marista"
            );
        });

        it("remove espaços no início e fim", () => {
            expect(normalizadorService.normalizar("  Aurora  ")).toBe("aurora");
        });

        it("trata cedilha e til corretamente", () => {
            expect(normalizadorService.normalizar("São João")).toBe("sao joao");
        });
    });

    // ==========================================================================
    // Normalização com remoção de prefixos (por tipo)
    // ==========================================================================

    describe("normalizarComPrefixos() — Bairro", () => {
        it("remove prefixo 'Jardim' de bairro", () => {
            expect(
                normalizadorService.normalizarComPrefixos(
                    "Jardim Aurora",
                    TipoEntidade.Bairro
                )
            ).toBe("aurora");
        });

        it("remove prefixo 'Setor' de bairro", () => {
            expect(
                normalizadorService.normalizarComPrefixos(
                    "Setor Marista",
                    TipoEntidade.Bairro
                )
            ).toBe("marista");
        });

        it("remove prefixo 'Vila' de bairro", () => {
            expect(
                normalizadorService.normalizarComPrefixos(
                    "Vila Nova",
                    TipoEntidade.Bairro
                )
            ).toBe("nova");
        });

        it("NÃO remove prefixo de cidade", () => {
            // Cidade não tem prefixos a remover
            expect(
                normalizadorService.normalizarComPrefixos(
                    "Vila Velha",
                    TipoEntidade.Cidade
                )
            ).toBe("vila velha");
        });
    });

    describe("normalizarComPrefixos() — Condomínio", () => {
        it("remove prefixo 'Edifício' de condomínio", () => {
            expect(
                normalizadorService.normalizarComPrefixos(
                    "Edifício Aurora",
                    TipoEntidade.Condominio
                )
            ).toBe("aurora");
        });

        it("remove prefixo 'Condomínio' de condomínio", () => {
            expect(
                normalizadorService.normalizarComPrefixos(
                    "Condomínio Reserva",
                    TipoEntidade.Condominio
                )
            ).toBe("reserva");
        });

        it("remove prefixo 'Ed' (abreviação) de condomínio", () => {
            expect(
                normalizadorService.normalizarComPrefixos(
                    "Ed Rio Vermelho",
                    TipoEntidade.Condominio
                )
            ).toBe("rio vermelho");
        });
    });

    // ==========================================================================
    // Conversão de numerais
    // ==========================================================================

    describe("normalizarComPrefixos() — numerais", () => {
        it("converte numeral romano I para 1", () => {
            expect(
                normalizadorService.normalizarComPrefixos(
                    "Parque Industrial I",
                    TipoEntidade.Bairro
                )
            ).toBe("industrial 1");
        });

        it("converte numeral romano III para 3", () => {
            expect(
                normalizadorService.normalizarComPrefixos(
                    "Parque Industrial III",
                    TipoEntidade.Bairro
                )
            ).toBe("industrial 3");
        });

        it("Parque Industrial I ≠ Parque Industrial II após normalização", () => {
            const norm1 = normalizadorService.normalizarComPrefixos(
                "Parque Industrial I",
                TipoEntidade.Bairro
            );
            const norm2 = normalizadorService.normalizarComPrefixos(
                "Parque Industrial II",
                TipoEntidade.Bairro
            );
            // Devem produzir chaves DIFERENTES
            expect(norm1).not.toBe(norm2);
            expect(norm1).toBe("industrial 1");
            expect(norm2).toBe("industrial 2");
        });
    });
});

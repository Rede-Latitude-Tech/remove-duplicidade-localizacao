/**
 * NormalizadorService — Normaliza nomes de localidades brasileiras para deduplicação.
 *
 * Realiza limpeza textual (acentos, caixa, espaços) e remoção de prefixos
 * comuns por tipo de entidade (ex: "Jardim", "Setor" para bairros),
 * além de equivalência numérica (romanos/escritos → arábicos).
 */

import { TipoEntidade } from "../types/index.js";

// Prefixos comuns a remover por tipo de entidade (já em minúsculo, sem acentos)
const PREFIXOS_POR_TIPO: Record<TipoEntidade, string[]> = {
    // Bairro: prefixos descritivos muito comuns em nomes de bairros brasileiros
    [TipoEntidade.Bairro]: [
        "setor",
        "jardim",
        "parque",
        "vila",
        "residencial",
        "conjunto",
        "nucleo",
        "bairro",
    ],

    // Condominio: prefixos de edificações e empreendimentos
    [TipoEntidade.Condominio]: [
        "edificio",
        "condominio",
        "residencial",
        "torre",
        "bloco",
        "ed",
        "cond",
    ],

    // Logradouro e Cidade não possuem prefixos a remover
    [TipoEntidade.Logradouro]: [],
    [TipoEntidade.Cidade]: [],
};

// Mapeamento de numerais romanos e escritos por extenso para arábicos
const MAPA_NUMERICO: Record<string, string> = {
    // Romanos
    i: "1",
    ii: "2",
    iii: "3",
    iv: "4",
    v: "5",
    vi: "6",
    vii: "7",
    viii: "8",
    ix: "9",
    x: "10",
    // Escritos por extenso
    um: "1",
    dois: "2",
    tres: "3",
    quatro: "4",
    cinco: "5",
};

class NormalizadorService {
    /**
     * Normalização básica: converte para minúsculo, remove acentos/diacríticos,
     * colapsa espaços múltiplos e faz trim.
     * Usada como base para todas as comparações.
     */
    normalizar(nome: string): string {
        return (
            nome
                // Converte para minúsculo
                .toLowerCase()
                // Decompõe caracteres acentuados (NFD) e remove os diacríticos
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                // Colapsa múltiplos espaços em um único
                .replace(/\s+/g, " ")
                // Remove espaços no início e fim
                .trim()
        );
    }

    /**
     * Normalização avançada: aplica normalização básica + remove prefixos
     * específicos do tipo de entidade + converte numerais para formato arábico.
     * Produz uma "chave canônica" mais agressiva para detectar duplicatas.
     */
    normalizarComPrefixos(nome: string, tipo: TipoEntidade): string {
        // Primeiro aplica a normalização básica
        let resultado = this.normalizar(nome);

        // Remove prefixos comuns do tipo de entidade (apenas no início da string)
        const prefixos = PREFIXOS_POR_TIPO[tipo];
        for (const prefixo of prefixos) {
            // Regex: prefixo no início, seguido de espaço (word boundary natural)
            const regex = new RegExp(`^${prefixo}\\s+`, "i");
            resultado = resultado.replace(regex, "");
        }

        // Converte numerais romanos e escritos por extenso para arábicos
        // Usa word boundary (\b) para substituir apenas palavras inteiras
        resultado = resultado.replace(/\b\w+\b/g, (palavra) => {
            return MAPA_NUMERICO[palavra] ?? palavra;
        });

        // Colapsa espaços novamente (a remoção de prefixo pode deixar espaços extras)
        resultado = resultado.replace(/\s+/g, " ").trim();

        return resultado;
    }
}

// Exporta como singleton para uso em toda a aplicação
export const normalizadorService = new NormalizadorService();

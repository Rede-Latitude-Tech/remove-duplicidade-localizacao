// Tipos de entidades de localidade suportadas pela deduplicação
export enum TipoEntidade {
    Cidade = 1,
    Bairro = 2,
    Logradouro = 3,
    Condominio = 4,
}

// Status de um grupo de duplicatas
export enum StatusGrupo {
    Pendente = 1,
    Executado = 2,
    Descartado = 3,
    Revertido = 4,
}

// Labels para exibição no frontend
export const TIPO_ENTIDADE_LABEL: Record<TipoEntidade, string> = {
    [TipoEntidade.Cidade]: "Cidade",
    [TipoEntidade.Bairro]: "Bairro",
    [TipoEntidade.Logradouro]: "Logradouro",
    [TipoEntidade.Condominio]: "Condomínio",
};

// Tabela do banco correspondente a cada tipo de entidade
export const TIPO_ENTIDADE_TABELA: Record<TipoEntidade, string> = {
    [TipoEntidade.Cidade]: "cidade",
    [TipoEntidade.Bairro]: "bairro",
    [TipoEntidade.Logradouro]: "logradouro",
    [TipoEntidade.Condominio]: "condominio",
};

// Coluna FK do pai de cada tipo (para agrupar dentro do mesmo contexto)
export const TIPO_ENTIDADE_PARENT_COL: Record<TipoEntidade, string | null> = {
    [TipoEntidade.Cidade]: null, // Cidade não tem pai (agrupa por estado)
    [TipoEntidade.Bairro]: "cidade_id",
    [TipoEntidade.Logradouro]: "bairro_id",
    [TipoEntidade.Condominio]: "logradouro_id",
};

// Membro de um grupo de duplicatas com suas contagens de impacto
export interface MembroGrupo {
    id: string;
    nome: string;
    impacto: Record<string, number>; // { imoveis: 47, empresas: 3, ... }
    totalReferencias: number;
}

// Resultado da análise do LLM
export interface LLMAnaliseResult {
    saoDuplicatas: boolean;
    confianca: number;
    nomeCanonico: string;
    justificativa: string;
}

// Par de registros similares encontrado pelo pg_trgm
export interface ParSimilar {
    idA: string;
    idB: string;
    nomeA: string;
    nomeB: string;
    parentId: string;
    score: number;
}

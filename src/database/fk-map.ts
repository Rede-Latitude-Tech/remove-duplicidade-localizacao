import { TipoEntidade } from "../types/index.js";

// Configuração declarativa de todas as FKs que referenciam cada tipo de entidade.
// Quando um registro é "absorvido" por outro, todas essas FKs são atualizadas.
// Mapeamento obtido via consulta ao banco de homolog (information_schema.table_constraints).

interface FkRef {
    tabela: string;
    coluna: string;
    // Tipo do ID na tabela referenciadora (para cast correto na query)
    tipoId: "uuid" | "int";
    // Nome da coluna PK da tabela (default: "id"). Para tabelas sem coluna "id"
    // (ex: imovel_endereco usa "imovel_id", benfeitoria_condominio usa PK composta)
    pkColuna?: string;
}

export const FK_MAP: Record<number, FkRef[]> = {
    // Bairro → 4 referências
    [TipoEntidade.Bairro]: [
        { tabela: "logradouro", coluna: "bairro_id", tipoId: "uuid" },
        // imovel_endereco não tem coluna "id" — PK é "imovel_id"
        {
            tabela: "imovel_endereco",
            coluna: "bairro_comercial_id",
            tipoId: "uuid",
            pkColuna: "imovel_id",
        },
        { tabela: "empresa", coluna: "bairro_id", tipoId: "uuid" },
        {
            tabela: "property_draft_addresses",
            coluna: "bairro_comercial_id",
            tipoId: "uuid",
        },
    ],

    // Logradouro → 5 referências
    [TipoEntidade.Logradouro]: [
        { tabela: "imovel", coluna: "logradouro_id", tipoId: "uuid" },
        { tabela: "condominio", coluna: "logradouro_id", tipoId: "uuid" },
        {
            tabela: "pessoa",
            coluna: "endereco_logradouro_id",
            tipoId: "uuid",
        },
        {
            tabela: "building_address",
            coluna: "logradouro_id",
            tipoId: "uuid",
        },
        { tabela: "property_drafts", coluna: "logradouro_id", tipoId: "uuid" },
    ],

    // Condomínio → 6 referências
    [TipoEntidade.Condominio]: [
        // imovel_endereco não tem coluna "id" — PK é "imovel_id"
        { tabela: "imovel_endereco", coluna: "condominio_id", tipoId: "uuid", pkColuna: "imovel_id" },
        { tabela: "pessoa", coluna: "condominio_id", tipoId: "uuid" },
        { tabela: "building", coluna: "condominio_id", tipoId: "uuid" },
        // benfeitoria_condominio tem PK composta — usa condominios_id como PK para log
        {
            tabela: "benfeitoria_condominio",
            coluna: "condominios_id",
            tipoId: "uuid",
            pkColuna: "benfeitorias_id",
        },
        {
            tabela: "condominio_imagem",
            coluna: "condominio_id",
            tipoId: "uuid",
        },
        {
            tabela: "property_draft_addresses",
            coluna: "condominio_id",
            tipoId: "uuid",
        },
    ],

    // Cidade → 3 referências (cidade_id é uint/int, não uuid)
    [TipoEntidade.Cidade]: [
        { tabela: "bairro", coluna: "cidade_id", tipoId: "int" },
        { tabela: "empresa", coluna: "cidade_id", tipoId: "int" },
        { tabela: "pessoa_fisica", coluna: "naturalidade_id", tipoId: "int" },
    ],
};

/**
 * ImpactoService — Calcula o impacto (contagem de referências FK) de registros de localidade.
 *
 * Antes de executar um merge, é essencial saber quantos registros em outras tabelas
 * (imóveis, empresas, pessoas, etc.) referenciam cada membro do grupo de duplicatas.
 * O membro com mais referências é sugerido como canônico (registro principal).
 */

import { prisma } from "../config/database.js";
import { FK_MAP } from "../database/fk-map.js";
import type { MembroGrupo } from "../types/index.js";

class ImpactoService {
    /**
     * Calcula o impacto de cada membro de um grupo de duplicatas.
     * Para cada membro, conta quantos registros o referenciam em cada tabela FK.
     *
     * @param tipoEntidade - Tipo da entidade (1=Cidade, 2=Bairro, 3=Logradouro, 4=Condomínio)
     * @param registroIds - IDs dos membros do grupo
     * @param nomesMembros - Nomes originais dos membros (mesma ordem de registroIds)
     * @returns Array de MembroGrupo ordenado por totalReferencias DESC (mais referenciado primeiro)
     */
    async calcularImpactoGrupo(
        tipoEntidade: number,
        registroIds: string[],
        nomesMembros: string[]
    ): Promise<MembroGrupo[]> {
        // Array para acumular os resultados de cada membro
        const membros: MembroGrupo[] = [];

        // Itera sobre cada membro do grupo para calcular seu impacto individual
        for (let i = 0; i < registroIds.length; i++) {
            const registroId = registroIds[i];
            const nome = nomesMembros[i] ?? "Desconhecido";

            // Calcula contagens de FK para este membro específico
            const impacto = await this.calcularImpactoMembro(
                tipoEntidade,
                registroId
            );

            // Soma todas as contagens para obter o total de referências
            const totalReferencias = Object.values(impacto).reduce(
                (acc, count) => acc + count,
                0
            );

            membros.push({
                id: registroId,
                nome,
                impacto,
                totalReferencias,
            });
        }

        // Ordena por totalReferencias DESC — o mais referenciado é sugerido como canônico
        membros.sort((a, b) => b.totalReferencias - a.totalReferencias);

        return membros;
    }

    /**
     * Calcula a contagem de referências FK de um único registro.
     * Retorna um mapa de { nomeTabela: quantidade } para cada FK que o referencia.
     *
     * @param tipoEntidade - Tipo da entidade
     * @param registroId - ID do registro a ser consultado
     * @returns Record com nome da tabela como chave e contagem como valor
     */
    async calcularImpactoMembro(
        tipoEntidade: number,
        registroId: string
    ): Promise<Record<string, number>> {
        // Busca as FKs configuradas para este tipo de entidade
        const fks = FK_MAP[tipoEntidade];

        // Se não há FKs mapeadas para este tipo, retorna vazio
        if (!fks || fks.length === 0) {
            return {};
        }

        // Resultado acumulado: { "imovel": 47, "empresa": 3, ... }
        const resultado: Record<string, number> = {};

        // Conta referências em cada tabela FK usando query raw parametrizada
        for (const fk of fks) {
            // Usa cast apropriado: ::uuid para UUIDs, ::int para IDs numéricos (cidade)
            const castSuffix = fk.tipoId === "uuid" ? "::uuid" : "::int";

            // Query parametrizada com $1 para evitar SQL injection
            const query = `SELECT COUNT(*) as total FROM ${fk.tabela} WHERE ${fk.coluna} = $1${castSuffix}`;

            try {
                // Executa a query raw via Prisma, retorna array com um objeto { total: bigint }
                const rows = await prisma.$queryRawUnsafe<
                    { total: bigint }[]
                >(query, registroId);

                // Converte bigint para number (COUNT sempre retorna bigint no PostgreSQL)
                const count = Number(rows[0]?.total ?? 0);

                // Usa o nome da tabela como chave no resultado
                resultado[fk.tabela] = count;
            } catch (error) {
                // Em caso de erro na query (tabela inexistente, permissão, etc.), loga e define 0
                console.error(
                    `[ImpactoService] Erro ao contar FK ${fk.tabela}.${fk.coluna} para registro ${registroId}:`,
                    error instanceof Error ? error.message : error
                );
                resultado[fk.tabela] = 0;
            }
        }

        return resultado;
    }
}

// Exporta como singleton para uso em toda a aplicação
export const impactoService = new ImpactoService();

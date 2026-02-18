/**
 * MergeService — Motor transacional de unificação (merge) de duplicatas.
 *
 * Executa três operações principais:
 * - unificar: redireciona todas as FKs dos membros eliminados para o canônico e soft-deleta os eliminados
 * - reverter: desfaz uma unificação usando os logs granulares
 * - descartar: marca o grupo como descartado (sem ação no banco)
 *
 * Todas as operações de escrita rodam dentro de prisma.$transaction para atomicidade.
 * Cada alteração de FK é registrada em ms_merge_log para permitir rollback completo.
 */

import { prisma } from "../config/database.js";
import { FK_MAP } from "../database/fk-map.js";
import {
    StatusGrupo,
    type TipoEntidade,
    TIPO_ENTIDADE_TABELA,
} from "../types/index.js";

class MergeService {
    /**
     * Unifica um grupo de duplicatas, redirecionando todas as FKs para o registro canônico.
     *
     * Fluxo:
     * 1. Valida que o grupo existe e está com status Pendente
     * 2. Para cada membro que NÃO é o canônico:
     *    a. Para cada FK mapeada: atualiza referências e cria log
     *    b. Soft-delete do membro eliminado (excluido = true)
     * 3. Atualiza o nome do canônico se nomeFinal foi informado
     * 4. Atualiza o grupo com status Executado e metadados
     *
     * @param grupoId - ID do grupo de duplicatas
     * @param registroCanonicoId - ID do registro escolhido como canônico
     * @param nomeFinal - Nome final para o registro canônico (null para manter o original)
     * @param executadoPor - ID do usuário que executou a ação (null se automático)
     * @param decisaoContexto - JSON com contexto da decisão humana para feedback IA (null se não informado)
     * @returns Resumo com mensagem e total de alterações realizadas
     */
    async unificar(
        grupoId: string,
        registroCanonicoId: string,
        nomeFinal: string | null,
        executadoPor: string | null,
        decisaoContexto: string | null = null
    ): Promise<{ mensagem: string; totalAlteracoes: number }> {
        // Busca o grupo e valida que existe
        const grupo = await prisma.ms_grupo_duplicata.findUnique({
            where: { id: grupoId },
        });

        if (!grupo) {
            throw new Error(`Grupo ${grupoId} não encontrado.`);
        }

        // Valida que o grupo está com status Pendente ou Revertido (permite re-unificação após reversão)
        if (grupo.status !== StatusGrupo.Pendente && grupo.status !== StatusGrupo.Revertido) {
            throw new Error(
                `Grupo ${grupoId} não pode ser unificado (status atual: ${grupo.status}). Apenas grupos pendentes ou revertidos podem ser unificados.`
            );
        }

        // Determina a tabela da entidade com base no tipo (ex: "bairro", "logradouro")
        const entityTable =
            TIPO_ENTIDADE_TABELA[grupo.tipo_entidade as TipoEntidade];

        if (!entityTable) {
            throw new Error(
                `Tipo de entidade ${grupo.tipo_entidade} não possui tabela mapeada.`
            );
        }

        // Busca as FKs a serem atualizadas para este tipo de entidade
        const fks = FK_MAP[grupo.tipo_entidade] ?? [];

        // IDs dos membros que serão eliminados (todos exceto o canônico)
        const membrosEliminados = grupo.registro_ids.filter(
            (id) => id !== registroCanonicoId
        );

        // Contador total de alterações realizadas (FKs atualizadas)
        let totalAlteracoes = 0;

        // Executa tudo dentro de uma transação (timeout 30s para tabelas grandes como imovel_endereco)
        await prisma.$transaction(async (tx) => {
            // Processa cada membro eliminado
            for (const membroId of membrosEliminados) {
                // Para cada FK que referencia este tipo de entidade
                for (const fk of fks) {
                    // Cast apropriado: ::uuid para UUIDs, ::int para IDs numéricos
                    const castSuffix =
                        fk.tipoId === "uuid" ? "::uuid" : "::int";

                    // Coluna PK da tabela referenciadora (default: "id", configurável via pkColuna)
                    const pkCol = fk.pkColuna ?? "id";

                    // Busca todos os registros afetados (que apontam para o membro eliminado)
                    const registrosAfetados = await tx.$queryRawUnsafe<
                        { pk_val: string }[]
                    >(
                        `SELECT ${pkCol}::text AS pk_val FROM ${fk.tabela} WHERE ${fk.coluna} = $1${castSuffix}`,
                        membroId
                    );

                    // Se há registros afetados, atualiza as FKs e cria logs
                    if (registrosAfetados.length > 0) {
                        // Atualiza todas as FKs do membro eliminado para o canônico
                        await tx.$queryRawUnsafe(
                            `UPDATE ${fk.tabela} SET ${fk.coluna} = $2${castSuffix} WHERE ${fk.coluna} = $1${castSuffix}`,
                            membroId,
                            registroCanonicoId
                        );

                        // Cria um log individual para cada registro afetado (permite rollback granular)
                        for (const registro of registrosAfetados) {
                            await tx.ms_merge_log.create({
                                data: {
                                    grupo_id: grupoId,
                                    registro_eliminado_id: membroId,
                                    tabela_afetada: fk.tabela,
                                    registro_afetado_id: registro.pk_val,
                                    coluna_alterada: fk.coluna,
                                    valor_anterior: membroId,
                                    valor_novo: registroCanonicoId,
                                },
                            });

                            totalAlteracoes++;
                        }
                    }
                }

                // Soft-delete do membro eliminado (marca como excluído, não apaga fisicamente)
                await tx.$queryRawUnsafe(
                    `UPDATE ${entityTable} SET excluido = true WHERE id = $1${fks[0]?.tipoId === "int" ? "::int" : "::uuid"}`,
                    membroId
                );
            }

            // Se um nome final foi informado, atualiza o nome do registro canônico
            if (nomeFinal) {
                await tx.$queryRawUnsafe(
                    `UPDATE ${entityTable} SET nome = $1 WHERE id = $2${fks[0]?.tipoId === "int" ? "::int" : "::uuid"}`,
                    nomeFinal,
                    registroCanonicoId
                );
            }

            // Atualiza o grupo com status Executado, metadados da execução e contexto da decisão
            await tx.ms_grupo_duplicata.update({
                where: { id: grupoId },
                data: {
                    status: StatusGrupo.Executado,
                    registro_canonico_id: registroCanonicoId,
                    nome_canonico: nomeFinal ?? undefined,
                    data_execucao: new Date(),
                    executado_por: executadoPor ?? undefined,
                    total_registros_afetados: totalAlteracoes,
                    decisao_contexto: decisaoContexto ?? undefined,
                },
            });
        }, { timeout: 30000 }); // 30s timeout para tabelas grandes

        return {
            mensagem: `Grupo ${grupoId} unificado com sucesso. ${membrosEliminados.length} registro(s) eliminado(s), ${totalAlteracoes} FK(s) redirecionada(s).`,
            totalAlteracoes,
        };
    }

    /**
     * Reverte uma unificação previamente executada, restaurando todos os valores originais.
     *
     * Fluxo:
     * 1. Valida que o grupo existe e está com status Executado
     * 2. Busca todos os logs de merge não revertidos
     * 3. Para cada log: restaura o valor anterior da FK
     * 4. Reativa membros eliminados (excluido = false)
     * 5. Marca logs como revertidos e atualiza grupo para Revertido
     *
     * @param grupoId - ID do grupo a reverter
     * @param executadoPor - ID do usuário que executou a reversão
     * @returns Resumo com mensagem e total de registros revertidos
     */
    async reverter(
        grupoId: string,
        executadoPor: string | null
    ): Promise<{ mensagem: string; totalRevertidos: number }> {
        // Busca o grupo e valida que existe
        const grupo = await prisma.ms_grupo_duplicata.findUnique({
            where: { id: grupoId },
        });

        if (!grupo) {
            throw new Error(`Grupo ${grupoId} não encontrado.`);
        }

        // Valida que o grupo está com status Executado (só pode reverter grupos executados)
        if (grupo.status !== StatusGrupo.Executado) {
            throw new Error(
                `Grupo ${grupoId} não está executado (status atual: ${grupo.status}). Apenas grupos executados podem ser revertidos.`
            );
        }

        // Determina a tabela da entidade para reativar os membros eliminados
        const entityTable =
            TIPO_ENTIDADE_TABELA[grupo.tipo_entidade as TipoEntidade];

        if (!entityTable) {
            throw new Error(
                `Tipo de entidade ${grupo.tipo_entidade} não possui tabela mapeada.`
            );
        }

        // Busca as FKs para determinar o tipo de cast do ID
        const fks = FK_MAP[grupo.tipo_entidade] ?? [];

        // Busca todos os logs de merge que ainda não foram revertidos
        const logs = await prisma.ms_merge_log.findMany({
            where: {
                grupo_id: grupoId,
                revertido: false,
            },
        });

        // Se não há logs para reverter, retorna sem alterações
        if (logs.length === 0) {
            return {
                mensagem: `Grupo ${grupoId} não possui logs de merge para reverter.`,
                totalRevertidos: 0,
            };
        }

        // Coleta IDs únicos dos membros eliminados para reativá-los
        const membrosEliminados = [
            ...new Set(logs.map((log) => log.registro_eliminado_id)),
        ];

        // Executa a reversão dentro de uma transação
        await prisma.$transaction(async (tx) => {
            // Reverte cada alteração de FK individualmente usando o log
            for (const log of logs) {
                // Determina o cast e PK baseado na FK (busca na configuração)
                const fkConfig = fks.find(
                    (fk) =>
                        fk.tabela === log.tabela_afetada &&
                        fk.coluna === log.coluna_alterada
                );
                const castSuffix =
                    fkConfig?.tipoId === "int" ? "::int" : "::uuid";
                // Usa pkColuna da config ou default "id"
                const pkCol = fkConfig?.pkColuna ?? "id";

                // Restaura o valor anterior da FK no registro afetado
                await tx.$queryRawUnsafe(
                    `UPDATE ${log.tabela_afetada} SET ${log.coluna_alterada} = $1${castSuffix} WHERE ${pkCol} = $2::uuid`,
                    log.valor_anterior,
                    log.registro_afetado_id
                );
            }

            // Reativa os membros eliminados (remove soft-delete)
            for (const membroId of membrosEliminados) {
                const castSuffix =
                    fks[0]?.tipoId === "int" ? "::int" : "::uuid";
                await tx.$queryRawUnsafe(
                    `UPDATE ${entityTable} SET excluido = false WHERE id = $1${castSuffix}`,
                    membroId
                );
            }

            // Marca todos os logs como revertidos com timestamp
            await tx.ms_merge_log.updateMany({
                where: {
                    grupo_id: grupoId,
                    revertido: false,
                },
                data: {
                    revertido: true,
                    data_reversao: new Date(),
                },
            });

            // Atualiza o grupo para status Revertido
            await tx.ms_grupo_duplicata.update({
                where: { id: grupoId },
                data: {
                    status: StatusGrupo.Revertido,
                    data_reversao: new Date(),
                },
            });
        }, { timeout: 30000 }); // 30s timeout

        return {
            mensagem: `Grupo ${grupoId} revertido com sucesso. ${logs.length} alteração(ões) desfeita(s), ${membrosEliminados.length} registro(s) reativado(s).`,
            totalRevertidos: logs.length,
        };
    }

    /**
     * Descarta um grupo de duplicatas sem executar nenhuma alteração no banco.
     * Apenas atualiza o status do grupo para Descartado.
     *
     * @param grupoId - ID do grupo a descartar
     * @param executadoPor - ID do usuário que descartou (null se automático)
     * @param decisaoContexto - JSON com contexto da decisão humana para feedback IA (null se não informado)
     * @returns Resumo com mensagem de confirmação
     */
    async descartar(
        grupoId: string,
        executadoPor: string | null,
        decisaoContexto: string | null = null
    ): Promise<{ mensagem: string }> {
        // Busca o grupo e valida que existe
        const grupo = await prisma.ms_grupo_duplicata.findUnique({
            where: { id: grupoId },
        });

        if (!grupo) {
            throw new Error(`Grupo ${grupoId} não encontrado.`);
        }

        // Atualiza o status do grupo para Descartado, incluindo contexto da decisão
        await prisma.ms_grupo_duplicata.update({
            where: { id: grupoId },
            data: {
                status: StatusGrupo.Descartado,
                executado_por: executadoPor ?? undefined,
                decisao_contexto: decisaoContexto ?? undefined,
            },
        });

        return {
            mensagem: `Grupo ${grupoId} descartado com sucesso.`,
        };
    }
}

// Exporta como singleton para uso em toda a aplicação
export const mergeService = new MergeService();

import { FastifyInstance } from "fastify";
import { prisma } from "../config/database.js";
import { StatusGrupo, TipoEntidade, TIPO_ENTIDADE_TABELA } from "../types/index.js";
import { impactoService } from "../services/impacto.service.js";
import { openaiValidationService } from "../services/apis/openai.service.js";

// Rotas de listagem e detalhe de grupos de duplicatas
export async function gruposRoutes(app: FastifyInstance) {
    // GET /grupos — lista grupos de duplicatas com filtros (tipo, status, parentId, busca)
    app.get("/", async (request, reply) => {
        const { tipo, status, pagina, tamanhoPagina, parentId, busca } = request.query as {
            tipo?: string;
            status?: string;
            pagina?: string;
            tamanhoPagina?: string;
            parentId?: string;  // Filtro por cidade (parent_id)
            busca?: string;     // Busca por nome
        };

        const page = parseInt(pagina ?? "1");
        const size = parseInt(tamanhoPagina ?? "20");

        // Monta filtro dinâmico
        const where: Record<string, unknown> = {};
        if (tipo) where.tipo_entidade = parseInt(tipo);
        if (status) where.status = parseInt(status);
        else where.status = StatusGrupo.Pendente; // padrão: apenas pendentes
        if (parentId) where.parent_id = parentId;  // Filtra por cidade
        if (busca) where.nome_normalizado = { contains: busca.toLowerCase() };

        const [data, total] = await Promise.all([
            prisma.ms_grupo_duplicata.findMany({
                where,
                orderBy: { data_criacao: "desc" },
                skip: (page - 1) * size,
                take: size,
            }),
            prisma.ms_grupo_duplicata.count({ where }),
        ]);

        // Preenche parent_nome com o nome da cidade via SQL (bairros, logradouros e condominios têm parent_id numérico = cidade_id)
        const parentIds = [...new Set(data.map((g) => g.parent_id).filter(Boolean))];
        // Filtra apenas IDs numéricos (cidades têm estado_id como parent_id = string "SP")
        const parentIdsNumericos = parentIds.filter((id) => /^\d+$/.test(id!));
        let cidadeNomes: Record<string, string> = {};
        if (parentIdsNumericos.length > 0) {
            try {
                const cidades = await prisma.$queryRawUnsafe<Array<{ id: string; nome: string }>>(
                    `SELECT id::text, nome FROM cidade WHERE id = ANY($1::int[])`,
                    parentIdsNumericos.map((id) => parseInt(id!, 10))
                );
                cidadeNomes = Object.fromEntries(cidades.map((c) => [c.id, c.nome]));
            } catch {
                // Ignora erro inesperado
            }
        }

        // Busca hierarquia completa (UF → Cidade → Bairro → Logradouro) via ms_membro_contexto
        // Pega o contexto do primeiro membro de cada grupo para exibir na listagem
        const grupoIds = data.map((g) => g.id);
        let hierarquiaPorGrupo: Record<string, {
            estado_sigla: string | null;
            cidade_nome: string | null;
            bairro_nome: string | null;
            logradouro_nome: string | null;
        }> = {};
        if (grupoIds.length > 0) {
            try {
                // DISTINCT ON pega apenas o primeiro contexto por grupo (evita duplicatas)
                const contextos = await prisma.$queryRawUnsafe<Array<{
                    grupo_id: string;
                    estado_sigla: string | null;
                    cidade_nome: string | null;
                    bairro_nome: string | null;
                    logradouro_nome: string | null;
                }>>(
                    `SELECT DISTINCT ON (grupo_id)
                        grupo_id, estado_sigla, cidade_nome, bairro_nome, logradouro_nome
                     FROM ms_membro_contexto
                     WHERE grupo_id = ANY($1::uuid[])
                     ORDER BY grupo_id, id`,
                    grupoIds
                );
                hierarquiaPorGrupo = Object.fromEntries(
                    contextos.map((c) => [c.grupo_id, {
                        estado_sigla: c.estado_sigla,
                        cidade_nome: c.cidade_nome,
                        bairro_nome: c.bairro_nome,
                        logradouro_nome: c.logradouro_nome,
                    }])
                );
            } catch (err) {
                // Log para diagnóstico — contextos podem não existir ainda (pré-enriquecimento)
                console.error("[grupos] Erro ao buscar hierarquia:", err);
            }
        }

        // Anexa parent_nome e hierarquia a cada grupo
        const dataComNome = data.map((g) => ({
            ...g,
            parent_nome: g.parent_id ? cidadeNomes[g.parent_id] ?? null : null,
            // Hierarquia completa do endereço (UF > Cidade > Bairro > Logradouro)
            hierarquia: hierarquiaPorGrupo[g.id] ?? null,
        }));

        return { data: dataComNome, total };
    });

    // GET /grupos/auto-aprovaveis — retorna grupos seguros para auto-aprovação
    // Critérios: status Pendente, tem canonico_sugerido_id, tem nome_oficial,
    // IA confirmou duplicatas (saoDuplicatas=true) com confiança >= 90%
    app.get("/auto-aprovaveis", async () => {
        // Busca todos os pendentes com sugestão e nome oficial
        const candidatos = await prisma.ms_grupo_duplicata.findMany({
            where: {
                status: StatusGrupo.Pendente,
                canonico_sugerido_id: { not: null },
                nome_oficial: { not: null },
                detalhes_llm: { not: null },
            },
            select: { id: true, detalhes_llm: true },
        });

        // Filtra em memória: parseia detalhes_llm e verifica confiança >= 0.90 + saoDuplicatas
        const idsAutoAprovaveis: string[] = [];
        for (const grupo of candidatos) {
            try {
                const llm = JSON.parse(grupo.detalhes_llm!);
                if (llm.saoDuplicatas === true && typeof llm.confianca === "number" && llm.confianca >= 0.90) {
                    idsAutoAprovaveis.push(grupo.id);
                }
            } catch {
                // detalhes_llm inválido, ignora
            }
        }

        return { total: idsAutoAprovaveis.length, ids: idsAutoAprovaveis };
    });

    // GET /grupos/:id — detalhe de um grupo com membros, impacto e contexto hierárquico
    app.get("/:id", async (request, reply) => {
        const { id } = request.params as { id: string };

        // Busca grupo com contextos dos membros (ms_membro_contexto)
        const grupo = await prisma.ms_grupo_duplicata.findUnique({
            where: { id },
            include: {
                logs: true,
                contextos: true,
            },
        });

        if (!grupo) {
            return reply.status(404).send({ erro: "Grupo não encontrado" });
        }

        // Calcula impacto por membro (contagem de FKs)
        const membros = await impactoService.calcularImpactoGrupo(
            grupo.tipo_entidade,
            grupo.registro_ids,
            grupo.nomes_membros
        );

        // Anexa contexto hierárquico a cada membro (match por registro_id)
        const membrosComContexto = membros.map((membro) => {
            const ctx = grupo.contextos.find((c) => c.registro_id === membro.id);
            return {
                ...membro,
                contexto: ctx
                    ? {
                          cidade_nome: ctx.cidade_nome,
                          cidade_id: ctx.cidade_id,
                          estado_sigla: ctx.estado_sigla,
                          bairro_nome: ctx.bairro_nome,
                          bairro_id: ctx.bairro_id,
                          logradouro_nome: ctx.logradouro_nome,
                          logradouro_id: ctx.logradouro_id,
                          ceps: ctx.ceps,
                          total_logradouros: ctx.total_logradouros,
                          total_condominios: ctx.total_condominios,
                          total_bairros: ctx.total_bairros,
                      }
                    : null,
            };
        });

        // Remove o array de contextos cru do grupo (já está nos membros)
        const { contextos: _, ...grupoLimpo } = grupo;

        return { grupo: grupoLimpo, membros: membrosComContexto };
    });

    // GET /grupos/:id/impacto — contagem detalhada de impacto por membro
    app.get("/:id/impacto", async (request, reply) => {
        const { id } = request.params as { id: string };

        const grupo = await prisma.ms_grupo_duplicata.findUnique({
            where: { id },
        });

        if (!grupo) {
            return reply.status(404).send({ erro: "Grupo não encontrado" });
        }

        const membros = await impactoService.calcularImpactoGrupo(
            grupo.tipo_entidade,
            grupo.registro_ids,
            grupo.nomes_membros
        );

        return { membros };
    });

    // POST /grupos/revalidar-llm — re-valida grupos pendentes sem detalhes_llm via GPT
    // Descarta falsos positivos que o LLM identifica (ex: "São Geraldo" ≠ "São Geraldo do Baixio")
    app.post("/revalidar-llm", async (request, reply) => {
        if (!openaiValidationService.disponivel) {
            return reply.status(400).send({ erro: "OpenAI API key não configurada" });
        }

        // Busca grupos pendentes que não passaram pelo LLM
        const gruposSemLlm = await prisma.ms_grupo_duplicata.findMany({
            where: {
                status: StatusGrupo.Pendente,
                detalhes_llm: null,
            },
            include: { contextos: true },
        });

        if (gruposSemLlm.length === 0) {
            return { total: 0, descartados: 0, atualizados: 0 };
        }

        let descartados = 0;
        let atualizados = 0;
        const BATCH_SIZE = 10;

        // Processa em lotes de 10 para não sobrecarregar a API
        for (let i = 0; i < gruposSemLlm.length; i += BATCH_SIZE) {
            const batch = gruposSemLlm.slice(i, i + BATCH_SIZE);
            const tipoLabel = TIPO_ENTIDADE_TABELA[batch[0].tipo_entidade as TipoEntidade] ?? "localidade";

            // Monta dados para o LLM com contexto dos membros já salvos
            const gruposParaLlm = batch.map((g) => {
                const ctx = g.contextos[0];
                return {
                    nomesMembros: g.nomes_membros,
                    registroIds: g.registro_ids,
                    contexto: ctx
                        ? {
                              cidade: ctx.cidade_nome ?? undefined,
                              estado: ctx.estado_sigla ?? g.parent_id ?? undefined,
                              bairro: ctx.bairro_nome ?? undefined,
                              logradouro: ctx.logradouro_nome ?? undefined,
                          }
                        : { estado: g.parent_id ?? undefined },
                };
            });

            // Envia lote ao LLM
            const resultados = await openaiValidationService.validarGruposBatch(
                gruposParaLlm,
                tipoLabel
            );

            // Atualiza cada grupo com o resultado do LLM
            for (const [batchIdx, validacao] of resultados) {
                const grupo = batch[batchIdx];

                if (!validacao.saoDuplicatas) {
                    // LLM rejeitou — descartar o grupo
                    await prisma.ms_grupo_duplicata.update({
                        where: { id: grupo.id },
                        data: {
                            status: StatusGrupo.Descartado,
                            detalhes_llm: JSON.stringify(validacao),
                            fonte: "pg_trgm+llm",
                            decisao_contexto: JSON.stringify({
                                tipo: "descartado_revalidacao_llm",
                                justificativa: validacao.justificativa,
                            }),
                        },
                    });
                    descartados++;
                    console.log(
                        `[Revalidar] Descartado: [${grupo.nomes_membros.join(", ")}] — ${validacao.justificativa}`
                    );
                } else {
                    // LLM confirmou — atualiza detalhes_llm e nome canônico
                    await prisma.ms_grupo_duplicata.update({
                        where: { id: grupo.id },
                        data: {
                            detalhes_llm: JSON.stringify(validacao),
                            fonte: "pg_trgm+llm",
                            nome_normalizado: validacao.nomeCanonico || grupo.nome_normalizado,
                        },
                    });
                    atualizados++;
                }
            }

            console.log(
                `[Revalidar] Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(gruposSemLlm.length / BATCH_SIZE)} processado`
            );
        }

        return {
            total: gruposSemLlm.length,
            descartados,
            atualizados,
            mensagem: `${descartados} falsos positivos descartados, ${atualizados} confirmados pelo LLM`,
        };
    });
}

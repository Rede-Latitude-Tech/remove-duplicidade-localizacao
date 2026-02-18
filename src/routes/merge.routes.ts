import { FastifyInstance } from "fastify";
import { mergeService } from "../services/merge.service.js";
import { prisma } from "../config/database.js";

// Rotas de unificação (merge), reversão e descarte de grupos
export async function mergeRoutes(app: FastifyInstance) {
    // PUT /grupos/:id/unificar — executa merge transacional
    // Aceita decisaoContexto no body para registrar contexto da decisão humana
    app.put("/:id/unificar", async (request, reply) => {
        const { id } = request.params as { id: string };
        const { registroCanonico, nomeCanonicoFinal, executadoPor, decisaoContexto } =
            request.body as {
                registroCanonico: string;
                nomeCanonicoFinal?: string;
                executadoPor?: string;
                decisaoContexto?: string; // JSON stringificado do contexto da decisão
            };

        if (!registroCanonico) {
            return reply
                .status(400)
                .send({ erro: "registroCanonico é obrigatório" });
        }

        const resultado = await mergeService.unificar(
            id,
            registroCanonico,
            nomeCanonicoFinal ?? null,
            executadoPor ?? null,
            decisaoContexto ?? null
        );

        return resultado;
    });

    // PUT /grupos/:id/reverter — reverte merge usando ms_merge_log
    app.put("/:id/reverter", async (request, reply) => {
        const { id } = request.params as { id: string };
        const { executadoPor } = request.body as { executadoPor?: string };

        const resultado = await mergeService.reverter(
            id,
            executadoPor ?? null
        );
        return resultado;
    });

    // PUT /grupos/:id/aprovar-sugestao — aprova a sugestão automática do enriquecimento
    // Usa o canonico_sugerido_id e nome_oficial para executar merge automaticamente
    // Gera decisaoContexto automaticamente com tipo "unificacao_ia_aprovada_auto"
    app.put("/:id/aprovar-sugestao", async (request, reply) => {
        const { id } = request.params as { id: string };

        // Busca o grupo para pegar a sugestão
        const grupo = await prisma.ms_grupo_duplicata.findUnique({
            where: { id },
        });

        if (!grupo) {
            return reply.status(404).send({ erro: "Grupo não encontrado" });
        }

        if (!grupo.canonico_sugerido_id) {
            return reply.status(400).send({ erro: "Grupo não tem sugestão automática" });
        }

        // Gera contexto da decisão automaticamente para aprovação via sugestão
        let llmConfianca: number | null = null;
        let llmNomeSugerido: string | null = null;
        try {
            if (grupo.detalhes_llm) {
                const llm = JSON.parse(grupo.detalhes_llm);
                llmConfianca = llm.confianca ?? null;
                llmNomeSugerido = llm.nomeCanonico ?? null;
            }
        } catch { /* detalhes_llm inválido, ignora */ }

        const decisaoContexto = JSON.stringify({
            tipo: "unificacao_ia_aprovada_auto",
            iaDisponivel: !!grupo.detalhes_llm,
            iaConcordou: true,
            iaConfianca: llmConfianca,
            iaNomeSugerido: llmNomeSugerido,
            nomeEscolhido: grupo.nome_oficial ?? llmNomeSugerido,
            nomeAlteradoPeloUsuario: false,
        });

        // Executa merge usando a sugestão: canônico sugerido + nome oficial
        const resultado = await mergeService.unificar(
            id,
            grupo.canonico_sugerido_id,
            grupo.nome_oficial ?? null,
            "auto-aprovacao",
            decisaoContexto
        );

        return resultado;
    });

    // POST /grupos/aprovar-sugestoes-batch — aprova sugestões automáticas em lote
    // Recebe array de IDs de grupos e aprova todos que têm sugestão
    app.post("/aprovar-sugestoes-batch", async (request, reply) => {
        const { grupoIds } = request.body as { grupoIds: string[] };

        if (!grupoIds || grupoIds.length === 0) {
            return reply.status(400).send({ erro: "grupoIds é obrigatório" });
        }

        let aprovados = 0;
        let erros = 0;
        const resultados: Array<{ id: string; sucesso: boolean; erro?: string }> = [];

        for (const grupoId of grupoIds) {
            try {
                const grupo = await prisma.ms_grupo_duplicata.findUnique({
                    where: { id: grupoId },
                });

                if (!grupo || !grupo.canonico_sugerido_id || grupo.status !== 1) {
                    resultados.push({ id: grupoId, sucesso: false, erro: "Sem sugestão ou não pendente" });
                    erros++;
                    continue;
                }

                // Gera contexto da decisão para cada grupo aprovado em batch
                let llmConfianca: number | null = null;
                let llmNomeSugerido: string | null = null;
                try {
                    if (grupo.detalhes_llm) {
                        const llm = JSON.parse(grupo.detalhes_llm);
                        llmConfianca = llm.confianca ?? null;
                        llmNomeSugerido = llm.nomeCanonico ?? null;
                    }
                } catch { /* ignora */ }

                const decisaoCtx = JSON.stringify({
                    tipo: "unificacao_ia_aprovada_batch",
                    iaDisponivel: !!grupo.detalhes_llm,
                    iaConcordou: true,
                    iaConfianca: llmConfianca,
                    iaNomeSugerido: llmNomeSugerido,
                    nomeEscolhido: grupo.nome_oficial ?? llmNomeSugerido,
                    nomeAlteradoPeloUsuario: false,
                });

                await mergeService.unificar(
                    grupoId,
                    grupo.canonico_sugerido_id,
                    grupo.nome_oficial ?? null,
                    "auto-aprovacao-batch",
                    decisaoCtx
                );

                resultados.push({ id: grupoId, sucesso: true });
                aprovados++;
            } catch (err) {
                resultados.push({ id: grupoId, sucesso: false, erro: String(err) });
                erros++;
            }
        }

        return { aprovados, erros, total: grupoIds.length, resultados };
    });

    // PUT /grupos/:id/descartar — marca grupo como "não é duplicata"
    // Aceita decisaoContexto no body para registrar contexto da decisão humana
    app.put("/:id/descartar", async (request, reply) => {
        const { id } = request.params as { id: string };
        const { executadoPor, decisaoContexto } = request.body as {
            executadoPor?: string;
            decisaoContexto?: string; // JSON stringificado do contexto da decisão
        };

        const resultado = await mergeService.descartar(
            id,
            executadoPor ?? null,
            decisaoContexto ?? null
        );
        return resultado;
    });
}

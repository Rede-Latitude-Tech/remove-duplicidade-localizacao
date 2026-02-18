import { FastifyInstance } from "fastify";
import { deteccaoService } from "../services/deteccao.service.js";
import { enriquecimentoService } from "../services/enriquecimento.service.js";
import { prisma } from "../config/database.js";

// Rotas de detecção (scan) e enriquecimento de duplicatas
export async function scanRoutes(app: FastifyInstance) {
    // POST /scan — enfileira job de detecção batch (async)
    app.post("/", async (request, reply) => {
        const { tipo } = request.body as { tipo?: number };

        // Por enquanto executa síncrono — BullMQ será adicionado na Fase 8
        const resultado = await deteccaoService.executarDeteccao(tipo ?? null);
        return resultado;
    });

    // POST /scan/sync — executa detecção síncrona (para debug/teste)
    app.post("/sync", async (request, reply) => {
        const { tipo, parentId } = request.body as {
            tipo: number;
            parentId?: string;
        };

        if (!tipo) {
            return reply
                .status(400)
                .send({ erro: "tipo é obrigatório (2=Bairro, 3=Logradouro, 4=Condominio)" });
        }

        const grupos = await deteccaoService.detectarPorTipo(
            tipo,
            parentId ?? null
        );
        return { grupos, total: grupos.length };
    });

    // POST /scan/enriquecer — enriquece todos os grupos pendentes que ainda não têm nome_oficial
    // Busca grupos sem enriquecimento e processa em lotes de 10
    app.post("/enriquecer", async (request, reply) => {
        const gruposSemEnriquecimento = await prisma.ms_grupo_duplicata.findMany({
            where: {
                nome_oficial: null,
                status: 1, // Pendente
            },
            select: { id: true },
        });

        const ids = gruposSemEnriquecimento.map((g) => g.id);
        const totalGrupos = ids.length;

        if (totalGrupos === 0) {
            return { mensagem: "Todos os grupos já estão enriquecidos", total: 0 };
        }

        console.log(`[Enriquecer Batch] Iniciando enriquecimento de ${totalGrupos} grupo(s)...`);

        // Processa em lotes de 10 para não sobrecarregar APIs externas
        const LOTE = 10;
        let processados = 0;

        for (let i = 0; i < ids.length; i += LOTE) {
            const lote = ids.slice(i, i + LOTE);
            await enriquecimentoService.enriquecer(lote);
            processados += lote.length;
            console.log(`[Enriquecer Batch] Progresso: ${processados}/${totalGrupos}`);
        }

        console.log(`[Enriquecer Batch] Concluído — ${totalGrupos} grupo(s) enriquecidos`);
        return { mensagem: `${totalGrupos} grupo(s) enriquecidos`, total: totalGrupos };
    });

    // POST /scan/re-enriquecer-google — popula endereco_google em grupos que já têm fonte Google
    // Necessário após adição da coluna endereco_google (migração one-off)
    // Usa cache Redis, então chamadas repetidas são baratas
    app.post("/re-enriquecer-google", async (request, reply) => {
        const { googleGeocodingService } = await import("../services/apis/google.service.js");

        // Busca grupos com fonte Google mas sem endereco_google
        const grupos = await prisma.ms_grupo_duplicata.findMany({
            where: {
                fonte_oficial: { contains: "Google" },
                endereco_google: null,
            },
            select: { id: true, nome_oficial: true, registro_ids: true, tipo_entidade: true },
        });

        if (grupos.length === 0) {
            return { mensagem: "Todos os grupos Google já têm endereço", total: 0 };
        }

        console.log(`[Re-Enriquecer Google] ${grupos.length} grupo(s) precisam de endereco_google...`);

        let atualizados = 0;
        let erros = 0;

        // Processa em lotes de 20 para não sobrecarregar o Google
        const LOTE = 20;
        for (let i = 0; i < grupos.length; i += LOTE) {
            const lote = grupos.slice(i, i + LOTE);

            for (const grupo of lote) {
                try {
                    // Busca contexto do primeiro membro para montar a query ao Google
                    const ctx = await prisma.ms_membro_contexto.findFirst({
                        where: { grupo_id: grupo.id },
                    });

                    if (!ctx) continue;

                    // Monta a query de geocodificação baseada no tipo de entidade
                    let resultado;
                    if (grupo.tipo_entidade === 4) {
                        // Condomínio: nome + logradouro + bairro + cidade + UF
                        resultado = await googleGeocodingService.geocode(
                            [grupo.nome_oficial, ctx.logradouro_nome, ctx.bairro_nome, ctx.cidade_nome, ctx.estado_sigla]
                                .filter(Boolean).join(", ")
                        );
                    } else {
                        // Bairro/Logradouro/Cidade: nome + cidade + UF
                        resultado = await googleGeocodingService.geocode(
                            [grupo.nome_oficial, ctx.cidade_nome, ctx.estado_sigla]
                                .filter(Boolean).join(", ")
                        );
                    }

                    // Atualiza o campo endereco_google com o formatted_address do Google
                    if (resultado?.formattedAddress) {
                        await prisma.ms_grupo_duplicata.update({
                            where: { id: grupo.id },
                            data: { endereco_google: resultado.formattedAddress },
                        });
                        atualizados++;
                    }
                } catch (err) {
                    erros++;
                    console.warn(`[Re-Enriquecer Google] Erro no grupo ${grupo.id}:`, err);
                }
            }

            console.log(`[Re-Enriquecer Google] Progresso: ${Math.min(i + LOTE, grupos.length)}/${grupos.length}`);
        }

        console.log(`[Re-Enriquecer Google] Concluído — ${atualizados} atualizado(s), ${erros} erro(s)`);
        return { mensagem: `${atualizados} grupo(s) atualizados`, total: atualizados, erros };
    });

    // GET /scan/historico — lista execuções anteriores
    app.get("/historico", async (request, reply) => {
        const historico = await prisma.ms_execucao_log.findMany({
            orderBy: { data_execucao: "desc" },
            take: 20,
        });
        return { data: historico };
    });
}

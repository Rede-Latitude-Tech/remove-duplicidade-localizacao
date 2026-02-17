import { FastifyInstance } from "fastify";
import { mergeService } from "../services/merge.service.js";

// Rotas de unificação (merge), reversão e descarte de grupos
export async function mergeRoutes(app: FastifyInstance) {
    // PUT /grupos/:id/unificar — executa merge transacional
    app.put("/:id/unificar", async (request, reply) => {
        const { id } = request.params as { id: string };
        const { registroCanonico, nomeCanonicoFinal, executadoPor } =
            request.body as {
                registroCanonico: string;
                nomeCanonicoFinal?: string;
                executadoPor?: string;
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
            executadoPor ?? null
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

    // PUT /grupos/:id/descartar — marca grupo como "não é duplicata"
    app.put("/:id/descartar", async (request, reply) => {
        const { id } = request.params as { id: string };
        const { executadoPor } = request.body as { executadoPor?: string };

        const resultado = await mergeService.descartar(
            id,
            executadoPor ?? null
        );
        return resultado;
    });
}

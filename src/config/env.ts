import { z } from "zod";

// Schema de validação das variáveis de ambiente
const envSchema = z.object({
    // Banco PostgreSQL (mesmo do CRM Latitude)
    DATABASE_URL: z.string().url(),

    // Redis para BullMQ e cache
    REDIS_URL: z.string().default("redis://localhost:6379"),

    // Claude API para análise semântica
    ANTHROPIC_API_KEY: z.string().optional(),

    // Servidor
    PORT: z.coerce.number().default(3002),
    NODE_ENV: z
        .enum(["development", "production", "test"])
        .default("development"),

    // Thresholds de detecção
    THRESHOLD_SIMILARIDADE: z.coerce.number().default(0.4),
    THRESHOLD_LLM: z.coerce.number().default(0.8),
    LIMITE_PARES_POR_EXECUCAO: z.coerce.number().default(200),

    // Google Geocoding API (fallback para nome oficial)
    GOOGLE_GEOCODING_API_KEY: z.string().optional(),

    // OpenAI API para validação LLM de duplicatas
    OPENAI_API_KEY: z.string().optional(),

    // Enriquecimento — controle de APIs externas
    ENRIQUECIMENTO_HABILITADO: z
        .enum(["true", "false"])
        .default("true")
        .transform((v) => v === "true"),
    VIACEP_MAX_CEPS_POR_MEMBRO: z.coerce.number().default(10),
    VIACEP_CACHE_TTL_DIAS: z.coerce.number().default(7),
    GOOGLE_CACHE_TTL_DIAS: z.coerce.number().default(30),
});

export type Env = z.infer<typeof envSchema>;

// Valida e exporta as variáveis de ambiente
function loadEnv(): Env {
    const result = envSchema.safeParse(process.env);

    if (!result.success) {
        console.error(
            "Variáveis de ambiente inválidas:",
            result.error.format()
        );
        process.exit(1);
    }

    return result.data;
}

export const env = loadEnv();

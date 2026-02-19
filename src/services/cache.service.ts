/**
 * CacheService — Wrapper simples sobre Redis (ioredis) para cache da aplicação.
 *
 * Fornece get/set/del com serialização JSON automática.
 * Em caso de Redis indisponível, degrada graciosamente (log de warning, retorna null).
 */

import Redis from "ioredis";
import { env } from "../config/env.js";

type RedisClient = Redis.default;

class CacheService {
    // Conexão Redis — pode ser null se a conexão falhar
    private redis: RedisClient | null = null;

    constructor() {
        this.inicializarConexao();
    }

    /**
     * Inicializa a conexão Redis com tratamento de erros.
     * Se o Redis não estiver disponível, o service continua funcionando
     * sem cache (fallback gracioso).
     */
    private inicializarConexao(): void {
        try {
            this.redis = new Redis.default(env.REDIS_URL, {
                // Limita tentativas de reconexão para não bloquear a aplicação
                maxRetriesPerRequest: 3,
                // Timeout de conexão de 5 segundos
                connectTimeout: 5000,
                // Desativa reconexão automática infinita
                retryStrategy(times: number) {
                    // Para de tentar após 5 tentativas (backoff exponencial limitado)
                    if (times > 5) {
                        console.warn(
                            "[CacheService] Redis indisponível — desativando reconexão automática"
                        );
                        return null;
                    }
                    // Backoff: 200ms, 400ms, 800ms, 1600ms, 3200ms
                    return Math.min(times * 200, 3200);
                },
            });

            // Log de eventos de conexão para diagnóstico
            this.redis.on("connect", () => {
                console.log("[CacheService] Conectado ao Redis");
            });

            this.redis.on("error", (err: Error) => {
                console.warn(
                    "[CacheService] Erro na conexão Redis:",
                    err.message
                );
            });
        } catch (err) {
            // Se nem a instanciação funcionar, opera sem cache
            console.warn(
                "[CacheService] Falha ao inicializar Redis — operando sem cache:",
                err
            );
            this.redis = null;
        }
    }

    /**
     * Busca um valor no cache pelo key.
     * Retorna o valor deserializado ou null se não encontrado / Redis indisponível.
     */
    async get<T>(key: string): Promise<T | null> {
        try {
            // Se Redis não está conectado, retorna null (fallback gracioso)
            if (!this.redis) {
                return null;
            }

            const raw = await this.redis.get(key);

            // Key não encontrada no cache
            if (raw === null) {
                return null;
            }

            // Deserializa o JSON armazenado
            return JSON.parse(raw) as T;
        } catch (err) {
            console.warn(
                `[CacheService] Erro ao ler cache key="${key}":`,
                err
            );
            return null;
        }
    }

    /**
     * Armazena um valor no cache com TTL em segundos.
     * Serializa automaticamente o valor para JSON.
     */
    async set(
        key: string,
        value: unknown,
        ttlSeconds: number
    ): Promise<void> {
        try {
            // Se Redis não está conectado, ignora silenciosamente
            if (!this.redis) {
                return;
            }

            // Serializa para JSON e salva com expiração (EX = segundos)
            const serialized = JSON.stringify(value);
            await this.redis.set(key, serialized, "EX", ttlSeconds);
        } catch (err) {
            console.warn(
                `[CacheService] Erro ao gravar cache key="${key}":`,
                err
            );
        }
    }

    /**
     * Remove uma key do cache.
     * Útil para invalidar cache após merge ou atualização de dados.
     */
    async del(key: string): Promise<void> {
        try {
            // Se Redis não está conectado, ignora silenciosamente
            if (!this.redis) {
                return;
            }

            await this.redis.del(key);
        } catch (err) {
            console.warn(
                `[CacheService] Erro ao deletar cache key="${key}":`,
                err
            );
        }
    }
}

// Exporta como singleton para uso em toda a aplicação
export const cacheService = new CacheService();

/**
 * GoogleGeocodingService — Serviço de geocodificacao via Google Geocoding API.
 *
 * Usado como fallback quando IBGE e ViaCEP nao retornam resultados.
 * A API key e opcional — se nao estiver configurada, o servico degrada
 * graciosamente (retorna null em todas as consultas).
 *
 * Todas as respostas sao cacheadas no Redis para evitar chamadas repetidas
 * e custos desnecessarios com a API do Google.
 */

import { cacheService } from "../cache.service.js";
import { env } from "../../config/env.js";

// URL base da API de Geocoding do Google
const GOOGLE_GEOCODING_BASE =
    "https://maps.googleapis.com/maps/api/geocode/json";

// URL base da API Find Place from Text do Google Places
// Retorna o nome público do estabelecimento (ex: "Condomínio Edifício Rio Vermelho")
const GOOGLE_FIND_PLACE_BASE =
    "https://maps.googleapis.com/maps/api/place/findplacefromtext/json";

// ============================================================================
// Tipos internos para a resposta da API do Google Geocoding
// ============================================================================

/**
 * Componente de endereco retornado pela API do Google.
 * Cada componente tem um nome longo, nome curto e uma lista de tipos
 * que indicam o que ele representa (ex: "route", "sublocality", etc.)
 */
interface AddressComponent {
    long_name: string;
    short_name: string;
    types: string[];
}

/**
 * Resultado individual da geocodificacao.
 * Contem os componentes do endereco e o endereco formatado completo.
 */
interface GeocodingResult {
    address_components: AddressComponent[];
    formatted_address: string;
}

/**
 * Resposta completa da API de Geocoding do Google.
 * O campo status indica se a requisicao foi bem-sucedida ("OK")
 * ou se houve algum erro/sem resultados ("ZERO_RESULTS", etc.)
 */
interface GeocodingResponse {
    status: string;
    results: GeocodingResult[];
}

/**
 * Candidato retornado pela API Find Place from Text do Google Places.
 * O campo "name" é o nome público do estabelecimento no Google Maps.
 */
interface PlaceCandidate {
    name: string;
    formatted_address: string;
}

/**
 * Resposta da API Find Place from Text.
 * Retorna uma lista de candidatos encontrados para a query.
 */
interface FindPlaceResponse {
    status: string;
    candidates: PlaceCandidate[];
}

// ============================================================================
// Tipos exportados para uso externo
// ============================================================================

/**
 * Endereco oficial extraido da resposta do Google Geocoding.
 * Cada campo pode ser null caso a API nao retorne aquele componente.
 */
export interface GoogleEnderecoOficial {
    bairro: string | null;
    logradouro: string | null;
    cidade: string | null;
    estado: string | null;
    formattedAddress: string | null; // formatted_address completo do Google
}

/**
 * Resultado padronizado de busca por nome oficial.
 * Compativel com o mesmo formato do IbgeService.
 */
export interface ResultadoOficial {
    nomeOficial: string;
    fonte: string;
    score: number;
    enderecoCompleto?: string | null; // formatted_address do Google Geocoding
}

// ============================================================================
// Servico principal
// ============================================================================

class GoogleGeocodingService {
    /**
     * Indica se o servico esta disponivel (API key configurada).
     * Se false, todas as chamadas retornam null sem fazer requisicoes.
     */
    get disponivel(): boolean {
        return !!env.GOOGLE_GEOCODING_API_KEY;
    }

    /**
     * Geocodifica um endereco textual usando a API do Google.
     *
     * Fluxo:
     * 1. Verifica se a API key esta configurada
     * 2. Tenta buscar resultado do cache Redis
     * 3. Se nao houver cache, faz requisicao a API do Google
     * 4. Extrai os componentes estruturados do primeiro resultado
     * 5. Armazena no cache e retorna
     *
     * @param endereco - Endereco textual para geocodificar (ex: "Rua Augusta, Sao Paulo, SP")
     * @returns Endereco oficial extraido ou null se indisponivel/sem resultado
     */
    async geocode(endereco: string): Promise<GoogleEnderecoOficial | null> {
        // Verifica se a API key esta configurada
        if (!this.disponivel) {
            console.warn(
                "[GoogleGeocoding] API key nao configurada — ignorando geocodificacao"
            );
            return null;
        }

        // Monta a chave de cache normalizada para evitar duplicatas
        const cacheKey = `google:geocode:${this.normalizar(endereco)}`;

        // Tenta buscar do cache primeiro (evita chamadas desnecessarias e custos)
        const cached =
            await cacheService.get<GoogleEnderecoOficial>(cacheKey);
        if (cached) {
            return cached;
        }

        try {
            // Monta a URL com os parametros necessarios
            const params = new URLSearchParams({
                address: endereco,
                key: env.GOOGLE_GEOCODING_API_KEY!,
                language: "pt-BR",
                components: "country:BR",
            });

            const url = `${GOOGLE_GEOCODING_BASE}?${params.toString()}`;
            const response = await fetch(url);

            // Verifica se a resposta HTTP foi bem-sucedida
            if (!response.ok) {
                console.warn(
                    `[GoogleGeocoding] Erro HTTP ${response.status} ao geocodificar: "${endereco}"`
                );
                return null;
            }

            // Parse da resposta JSON
            const data: GeocodingResponse = await response.json();

            // Verifica se a API retornou resultados validos
            if (data.status !== "OK" || data.results.length === 0) {
                console.warn(
                    `[GoogleGeocoding] Sem resultados para "${endereco}" (status: ${data.status})`
                );
                return null;
            }

            // Extrai os componentes estruturados do primeiro resultado (inclui formatted_address)
            const resultado = this.extrairComponentes(data.results[0]);

            // Calcula o TTL do cache em segundos a partir da config em dias
            const ttlSegundos = env.GOOGLE_CACHE_TTL_DIAS * 24 * 60 * 60;

            // Armazena no cache para consultas futuras
            await cacheService.set(cacheKey, resultado, ttlSegundos);

            return resultado;
        } catch (err) {
            // Em caso de falha na rede ou parse, loga e retorna null
            console.warn(
                `[GoogleGeocoding] Falha ao geocodificar "${endereco}":`,
                err
            );
            return null;
        }
    }

    /**
     * Busca o nome oficial de um condominio via Google Places API (Find Place from Text).
     *
     * Tenta cada nome de membro no Google Places para encontrar o nome público
     * real do estabelecimento (ex: "Condomínio Edifício Rio Vermelho").
     * Se Places não encontrar, faz fallback para Geocoding (confirmação de localização).
     *
     * @param nomesMembros - Nomes de todos os membros do grupo para tentar na busca
     * @param logradouro - Logradouro onde o condominio esta localizado
     * @param bairro - Bairro do condominio
     * @param cidade - Cidade do condominio
     * @param uf - Sigla do estado (ex: "SP")
     * @returns Resultado oficial com nome público do Google Places (score 0.9) ou fallback Geocoding (score 0.7)
     */
    async buscarNomeCondominio(
        nomesMembros: string[],
        logradouro: string,
        bairro: string,
        cidade: string,
        uf: string
    ): Promise<ResultadoOficial | null> {
        // Tenta Google Places para cada membro — para ao primeiro resultado
        for (const nome of nomesMembros) {
            const placesResult = await this.findPlace(nome, cidade, uf);
            if (placesResult) {
                console.log(
                    `[GooglePlaces] Nome público encontrado: "${placesResult.name}" para "${nome}"`
                );
                return {
                    nomeOficial: placesResult.name,
                    fonte: "Google Places",
                    score: 0.9, // Score alto: nome público real do Google Maps
                    enderecoCompleto: placesResult.formatted_address,
                };
            }
        }

        // Fallback: Google Geocoding apenas confirma localização (não retorna nome de condomínio)
        const primeiroNome = nomesMembros[0] ?? "";
        const enderecoCompleto = [primeiroNome, logradouro, bairro, cidade, uf]
            .filter(Boolean)
            .join(", ");

        const resultado = await this.geocode(enderecoCompleto);
        if (!resultado) {
            return null;
        }

        // Score 0.7 — Geocoding confirma localização mas não normaliza nome de condomínio
        return {
            nomeOficial: primeiroNome,
            fonte: "Google Geocoding",
            score: 0.7,
            enderecoCompleto: resultado.formattedAddress,
        };
    }

    /**
     * Busca um estabelecimento pelo nome via Google Places API (Find Place from Text).
     *
     * Retorna o nome público do local no Google Maps (ex: "Condomínio Edifício Rio Vermelho")
     * e o endereço formatado. Usa cache Redis para evitar chamadas repetidas.
     *
     * @param nome - Nome do condomínio a buscar
     * @param cidade - Cidade para contexto (melhora a precisão)
     * @param uf - Estado para contexto
     * @returns Candidato do Places (name + formatted_address) ou null se não encontrar
     */
    private async findPlace(
        nome: string,
        cidade: string,
        uf: string
    ): Promise<PlaceCandidate | null> {
        if (!this.disponivel) return null;

        // Monta a query: "nome do condomínio, cidade - UF"
        const query = [nome, cidade, uf].filter(Boolean).join(", ");
        const cacheKey = `google:places:${this.normalizar(query)}`;

        // Tenta cache primeiro
        const cached = await cacheService.get<PlaceCandidate | "MISS">(cacheKey);
        if (cached === "MISS") return null; // Cache negativo (busca anterior não encontrou)
        if (cached) return cached;

        try {
            // Chama a API Find Place from Text com os campos necessários
            const params = new URLSearchParams({
                input: query,
                inputtype: "textquery",
                fields: "name,formatted_address",
                key: env.GOOGLE_GEOCODING_API_KEY!,
                language: "pt-BR",
                // Restringe a busca ao Brasil para evitar resultados de outros países
                locationbias: "rectangle:-33.75,-73.99,5.27,-34.79",
            });

            const url = `${GOOGLE_FIND_PLACE_BASE}?${params.toString()}`;
            const response = await fetch(url);

            if (!response.ok) {
                console.warn(
                    `[GooglePlaces] Erro HTTP ${response.status} ao buscar: "${query}"`
                );
                return null;
            }

            const data: FindPlaceResponse = await response.json();
            const ttlSegundos = env.GOOGLE_CACHE_TTL_DIAS * 24 * 60 * 60;

            // Se não encontrou candidatos, salva cache negativo e retorna null
            if (data.status !== "OK" || data.candidates.length === 0) {
                await cacheService.set(cacheKey, "MISS", ttlSegundos);
                return null;
            }

            // Pega o primeiro candidato (mais relevante)
            const candidato = data.candidates[0];

            // Salva no cache para consultas futuras
            await cacheService.set(cacheKey, candidato, ttlSegundos);

            return candidato;
        } catch (err) {
            console.warn(
                `[GooglePlaces] Falha ao buscar "${query}":`,
                err
            );
            return null;
        }
    }

    /**
     * Busca o nome oficial de uma entidade generica (bairro, logradouro ou cidade)
     * via Google Geocoding.
     *
     * Constroi uma query contextual com cidade/UF para melhorar a precisao,
     * e extrai o componente correspondente ao tipo solicitado da resposta.
     *
     * @param nome - Nome a buscar (ex: "Jd Paulista", "R. Augusta", "Sao Paulo")
     * @param tipo - Tipo da entidade: "bairro", "logradouro" ou "cidade"
     * @param cidade - Cidade para contexto (opcional, melhora a precisao)
     * @param uf - Estado para contexto (opcional, melhora a precisao)
     * @returns Resultado oficial com score 0.8 ou null se nao encontrar
     */
    async buscarNomeGenerico(
        nome: string,
        tipo: "bairro" | "logradouro" | "cidade",
        cidade?: string,
        uf?: string
    ): Promise<ResultadoOficial | null> {
        // Monta a query contextual incluindo cidade e UF quando disponiveis
        const partes = [nome];
        if (cidade) partes.push(cidade);
        if (uf) partes.push(uf);
        const query = partes.join(", ");

        // Faz a geocodificacao da query contextual
        const resultado = await this.geocode(query);

        // Se nao encontrou resultado, retorna null
        if (!resultado) {
            return null;
        }

        // Mapeia o tipo solicitado para o campo correspondente no resultado
        // - bairro → campo "bairro" (extraido de sublocality)
        // - logradouro → campo "logradouro" (extraido de route)
        // - cidade → campo "cidade" (extraido de locality/administrative_area_level_2)
        const nomeExtraido = resultado[tipo === "logradouro" ? "logradouro" : tipo === "bairro" ? "bairro" : "cidade"];

        // Se o componente especifico nao foi retornado pela API, nao temos nome oficial
        if (!nomeExtraido) {
            return null;
        }

        // Retorna com score 0.8 — Google e uma fonte confiavel para nomes oficiais
        return {
            nomeOficial: nomeExtraido,
            fonte: "Google Geocoding",
            score: 0.8,
            enderecoCompleto: resultado.formattedAddress, // formatted_address do Google
        };
    }

    // ========================================================================
    // Metodos privados auxiliares
    // ========================================================================

    /**
     * Extrai os componentes estruturados de endereco de um resultado do Google.
     *
     * Mapeia os tipos de componentes do Google para os campos do nosso dominio:
     * - bairro: sublocality_level_1 (preferencial) ou sublocality (fallback)
     * - logradouro: route
     * - cidade: administrative_area_level_2 (preferencial) ou locality (fallback)
     * - estado: administrative_area_level_1
     *
     * @param result - Resultado individual da API de Geocoding
     * @returns Endereco oficial com os campos extraidos
     */
    private extrairComponentes(result: GeocodingResult): GoogleEnderecoOficial {
        const componentes = result.address_components;

        // Extrai o bairro — tenta sublocality_level_1 primeiro (mais especifico),
        // depois sublocality como fallback
        const bairro =
            this.encontrarComponente(componentes, "sublocality_level_1") ??
            this.encontrarComponente(componentes, "sublocality") ??
            null;

        // Extrai o logradouro (rua, avenida, etc.)
        const logradouro =
            this.encontrarComponente(componentes, "route") ?? null;

        // Extrai a cidade — tenta administrative_area_level_2 primeiro (mais comum no Brasil),
        // depois locality como fallback
        const cidade =
            this.encontrarComponente(
                componentes,
                "administrative_area_level_2"
            ) ??
            this.encontrarComponente(componentes, "locality") ??
            null;

        // Extrai o estado (UF)
        const estado =
            this.encontrarComponente(
                componentes,
                "administrative_area_level_1"
            ) ?? null;

        // Inclui o formatted_address completo do Google (endereco legivel)
        const formattedAddress = result.formatted_address ?? null;

        return { bairro, logradouro, cidade, estado, formattedAddress };
    }

    /**
     * Encontra um componente de endereco pelo tipo na lista de componentes.
     *
     * Cada componente do Google pode ter multiplos tipos (ex: um componente
     * pode ser simultaneamente "locality" e "political"). Este metodo busca
     * o primeiro componente que contenha o tipo especificado.
     *
     * @param componentes - Lista de componentes de endereco da API do Google
     * @param tipo - Tipo a buscar (ex: "route", "sublocality_level_1", etc.)
     * @returns O long_name do componente encontrado, ou undefined se nao existir
     */
    private encontrarComponente(
        componentes: AddressComponent[],
        tipo: string
    ): string | undefined {
        // Busca o primeiro componente cujo array de tipos contenha o tipo desejado
        const componente = componentes.find((c) => c.types.includes(tipo));

        // Retorna o nome longo (ex: "Jardim Paulista" em vez de "Jd Paulista")
        return componente?.long_name;
    }

    /**
     * Normaliza uma string para uso como chave de cache.
     *
     * Aplica:
     * 1. Conversao para minusculo
     * 2. Decomposicao Unicode (NFD) para separar diacriticos
     * 3. Remocao de diacriticos (acentos, cedilha, til, etc.)
     * 4. Substituicao de espacos por hifens
     * 5. Trim de espacos nas bordas
     *
     * Exemplo: "Rua Augusta, Sao Paulo" → "rua-augusta,-sao-paulo"
     *
     * @param str - String original
     * @returns String normalizada para cache key
     */
    private normalizar(str: string): string {
        return (
            str
                // Converte para minusculo
                .toLowerCase()
                // Decompoe caracteres acentuados (ex: e → e + ´)
                .normalize("NFD")
                // Remove os diacriticos (combining marks Unicode)
                .replace(/[\u0300-\u036f]/g, "")
                // Substitui espacos por hifens (formato de cache key)
                .replace(/\s+/g, "-")
                // Remove espacos nas bordas
                .trim()
        );
    }
}

// Exporta como singleton para uso em toda a aplicacao
export const googleGeocodingService = new GoogleGeocodingService();

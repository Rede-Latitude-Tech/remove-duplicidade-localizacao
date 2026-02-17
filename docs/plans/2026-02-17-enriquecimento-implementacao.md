# Enriquecimento com Contexto Hierárquico e Nome Oficial — Plano de Implementação

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enriquecer grupos de duplicatas com hierarquia completa (cidade, bairro, logradouros, CEPs) e nome oficial (IBGE, ViaCEP, Google), com auto-sugestão do canônico e nome final.

**Architecture:** Novo passo no pipeline de scan do microserviço (`EnriquecimentoService`) que busca contexto hierárquico via SQL joins e nome oficial via APIs externas (IBGE → ViaCEP → Google). Dados persistidos em nova tabela `ms_membro_contexto` + campos novos em `ms_grupo_duplicata`. Frontend consome os dados prontos.

**Tech Stack:** Fastify, Prisma, ioredis (cache), APIs REST externas (IBGE, ViaCEP, Google Geocoding), Next.js 15, Ant Design 5, Tailwind CSS

---

## Task 1: Schema Prisma — novos campos e tabela

**Files:**
- Modify: `prisma/schema.prisma`

**Step 1: Adicionar campos em `ms_grupo_duplicata` e criar `ms_membro_contexto`**

Adicionar ao final do model `ms_grupo_duplicata` (antes de `logs`):

```prisma
  nome_oficial            String?   @db.VarChar(250)       // nome oficial da API externa
  fonte_oficial           String?   @db.VarChar(50)        // "IBGE", "ViaCEP", "Google"
  canonico_sugerido_id    String?   @db.VarChar(50)        // ID do membro sugerido automaticamente

  contextos ms_membro_contexto[]
```

Adicionar novo model após `ms_execucao_log`:

```prisma
/// Contexto hierárquico de cada membro de um grupo de duplicatas.
/// Preenchido durante o enriquecimento pós-scan.
model ms_membro_contexto {
  id                String    @id @default(uuid()) @db.Uuid
  grupo_id          String    @db.Uuid
  registro_id       String    @db.VarChar(50)

  // Hierarquia (preenchido conforme tipo_entidade)
  cidade_nome       String?   @db.VarChar(250)
  cidade_id         String?   @db.VarChar(50)
  estado_sigla      String?   @db.VarChar(5)
  bairro_nome       String?   @db.VarChar(250)
  bairro_id         String?   @db.VarChar(50)
  logradouro_nome   String?   @db.VarChar(250)
  logradouro_id     String?   @db.VarChar(50)
  ceps              String[]                     // CEPs associados
  total_logradouros Int?                         // para bairros
  total_condominios Int?                         // para logradouros
  total_bairros     Int?                         // para cidades

  grupo ms_grupo_duplicata @relation(fields: [grupo_id], references: [id], onDelete: Cascade)

  @@index([grupo_id])
  @@index([registro_id])
}
```

**Step 2: Gerar e aplicar migration**

Run: `npx prisma migrate dev --name enriquecimento-contexto`
Expected: Migration criada e aplicada com sucesso

**Step 3: Gerar Prisma Client**

Run: `npx prisma generate`
Expected: Prisma Client atualizado

**Step 4: Commit**

```bash
git add prisma/
git commit -m "feat: schema — campos nome_oficial e tabela ms_membro_contexto"
```

---

## Task 2: Variáveis de ambiente

**Files:**
- Modify: `src/config/env.ts`
- Modify: `.env.example`

**Step 1: Adicionar novas variáveis ao schema Zod**

Em `src/config/env.ts`, adicionar ao `envSchema`:

```typescript
    // Google Geocoding API (fallback para nome oficial)
    GOOGLE_GEOCODING_API_KEY: z.string().optional(),

    // Enriquecimento
    ENRIQUECIMENTO_HABILITADO: z
        .enum(["true", "false"])
        .default("true")
        .transform((v) => v === "true"),
    VIACEP_MAX_CEPS_POR_MEMBRO: z.coerce.number().default(10),
    VIACEP_CACHE_TTL_DIAS: z.coerce.number().default(7),
    GOOGLE_CACHE_TTL_DIAS: z.coerce.number().default(30),
```

**Step 2: Atualizar .env.example**

Adicionar ao final:

```
# Enriquecimento — APIs externas para nome oficial
GOOGLE_GEOCODING_API_KEY=
ENRIQUECIMENTO_HABILITADO=true
VIACEP_MAX_CEPS_POR_MEMBRO=10
VIACEP_CACHE_TTL_DIAS=7
GOOGLE_CACHE_TTL_DIAS=30
```

**Step 3: Commit**

```bash
git add src/config/env.ts .env.example
git commit -m "feat: variáveis de ambiente para enriquecimento"
```

---

## Task 3: Serviço IBGE

**Files:**
- Create: `src/services/apis/ibge.service.ts`

**Step 1: Implementar IbgeService**

```typescript
/**
 * IbgeService — Consulta API do IBGE para obter nomes oficiais de municípios.
 *
 * Endpoint: GET https://servicodados.ibge.gov.br/api/v1/localidades/estados/{UF}/municipios
 * Retorna todos os municípios de um estado. Filtramos por similaridade de nome.
 * Cache por estado no Redis (1 request cobre todas as cidades daquele UF).
 */

import { cacheService } from "../cache.service.js";

// Tipo retornado pela API do IBGE
interface MunicipioIBGE {
    id: number;
    nome: string;
}

// Resultado da busca por nome oficial
export interface ResultadoOficial {
    nomeOficial: string;
    fonte: string;
    score: number; // similaridade com o nome buscado
}

class IbgeService {
    private readonly BASE_URL = "https://servicodados.ibge.gov.br/api/v1/localidades";
    // TTL do cache: 30 dias (municípios mudam raramente)
    private readonly CACHE_TTL = 30 * 24 * 60 * 60;

    /**
     * Busca o nome oficial de uma cidade pelo nome e estado.
     * Consulta a lista completa de municípios do UF e filtra por similaridade.
     */
    async buscarCidade(nome: string, estadoSigla: string): Promise<ResultadoOficial | null> {
        try {
            // Busca lista de municípios do estado (com cache)
            const municipios = await this.listarMunicipios(estadoSigla);
            if (!municipios || municipios.length === 0) return null;

            // Normaliza o nome para comparação
            const nomeNorm = this.normalizar(nome);

            // Busca o município mais similar
            let melhorMatch: MunicipioIBGE | null = null;
            let melhorScore = 0;

            for (const mun of municipios) {
                const munNorm = this.normalizar(mun.nome);
                const score = this.calcularSimilaridade(nomeNorm, munNorm);
                if (score > melhorScore) {
                    melhorScore = score;
                    melhorMatch = mun;
                }
            }

            // Threshold mínimo: 0.5 para considerar match
            if (!melhorMatch || melhorScore < 0.5) return null;

            return {
                nomeOficial: melhorMatch.nome,
                fonte: "IBGE",
                score: Math.round(melhorScore * 100) / 100,
            };
        } catch (err) {
            console.warn(`[IbgeService] Erro ao buscar cidade "${nome}" em ${estadoSigla}:`, err);
            return null;
        }
    }

    /**
     * Lista todos os municípios de um estado via API IBGE.
     * Resultado cacheado no Redis por 30 dias.
     */
    private async listarMunicipios(uf: string): Promise<MunicipioIBGE[]> {
        const cacheKey = `ibge:municipios:${uf.toUpperCase()}`;

        // Tenta buscar no cache
        const cached = await cacheService.get<MunicipioIBGE[]>(cacheKey);
        if (cached) return cached;

        // Consulta API do IBGE
        const url = `${this.BASE_URL}/estados/${uf.toUpperCase()}/municipios`;
        const response = await fetch(url);

        if (!response.ok) {
            console.warn(`[IbgeService] API retornou ${response.status} para ${url}`);
            return [];
        }

        const municipios: MunicipioIBGE[] = await response.json();

        // Cacheia por 30 dias
        await cacheService.set(cacheKey, municipios, this.CACHE_TTL);

        return municipios;
    }

    /**
     * Normaliza string para comparação: minúsculo, sem acentos, sem espaços extras.
     */
    private normalizar(str: string): string {
        return str
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, " ")
            .trim();
    }

    /**
     * Calcula similaridade entre duas strings (bigram/dice coefficient).
     * Mais leve que pg_trgm para uso em memória.
     */
    private calcularSimilaridade(a: string, b: string): number {
        if (a === b) return 1;
        if (a.length < 2 || b.length < 2) return 0;

        // Gera bigramas
        const bigramsA = new Set<string>();
        for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.slice(i, i + 2));

        const bigramsB = new Set<string>();
        for (let i = 0; i < b.length - 1; i++) bigramsB.add(b.slice(i, i + 2));

        // Conta interseção
        let intersecao = 0;
        for (const bg of bigramsA) {
            if (bigramsB.has(bg)) intersecao++;
        }

        // Dice coefficient: 2 * |A ∩ B| / (|A| + |B|)
        return (2 * intersecao) / (bigramsA.size + bigramsB.size);
    }
}

export const ibgeService = new IbgeService();
```

**Step 2: Commit**

```bash
git add src/services/apis/ibge.service.ts
git commit -m "feat: serviço IBGE — busca nome oficial de cidades"
```

---

## Task 4: Serviço ViaCEP

**Files:**
- Create: `src/services/apis/viacep.service.ts`

**Step 1: Implementar ViaCepService**

```typescript
/**
 * ViaCepService — Consulta API do ViaCEP para obter nomes oficiais de bairros e logradouros.
 *
 * Estratégias:
 * - Por CEP: GET https://viacep.com.br/ws/{cep}/json/ → retorna bairro, logradouro
 * - Por endereço: GET https://viacep.com.br/ws/{UF}/{cidade}/{logradouro}/json/
 *
 * Para bairros: consulta CEPs dos logradouros filhos, extrai o nome de bairro mais frequente.
 * Para logradouros: consulta pelo próprio CEP.
 */

import { cacheService } from "../cache.service.js";
import { env } from "../../config/env.js";

// Tipo retornado pela API do ViaCEP
interface RespostaViaCep {
    cep: string;
    logradouro: string;
    complemento: string;
    unidade: string;
    bairro: string;
    localidade: string;
    uf: string;
    erro?: boolean;
}

export interface ResultadoOficial {
    nomeOficial: string;
    fonte: string;
    score: number;
}

class ViaCepService {
    // TTL configurável via env (default 7 dias)
    private get cacheTtl(): number {
        return env.VIACEP_CACHE_TTL_DIAS * 24 * 60 * 60;
    }

    // Máximo de CEPs consultados por membro (default 10)
    private get maxCepsPorMembro(): number {
        return env.VIACEP_MAX_CEPS_POR_MEMBRO;
    }

    /**
     * Consulta um CEP na API do ViaCEP.
     * Retorna dados de bairro, logradouro, cidade. Resultado cacheado no Redis.
     */
    async consultarCep(cep: string): Promise<RespostaViaCep | null> {
        // Limpa o CEP (remove hífen e espaços)
        const cepLimpo = cep.replace(/\D/g, "");
        if (cepLimpo.length !== 8) return null;

        const cacheKey = `viacep:${cepLimpo}`;

        // Tenta cache
        const cached = await cacheService.get<RespostaViaCep>(cacheKey);
        if (cached) return cached.erro ? null : cached;

        try {
            const response = await fetch(`https://viacep.com.br/ws/${cepLimpo}/json/`);
            if (!response.ok) return null;

            const data: RespostaViaCep = await response.json();

            // Cacheia mesmo se erro (evita reconsultar CEP inválido)
            await cacheService.set(cacheKey, data, this.cacheTtl);

            return data.erro ? null : data;
        } catch (err) {
            console.warn(`[ViaCepService] Erro ao consultar CEP ${cepLimpo}:`, err);
            return null;
        }
    }

    /**
     * Determina o nome oficial de um bairro consultando CEPs dos logradouros filhos.
     * Estratégia: consulta os N CEPs mais referenciados, extrai o nome de bairro mais frequente.
     *
     * @param ceps - CEPs dos logradouros filhos do bairro
     * @returns Nome oficial do bairro segundo Correios
     */
    async buscarNomeBairro(ceps: string[]): Promise<ResultadoOficial | null> {
        if (!ceps || ceps.length === 0) return null;

        // Limita a quantidade de consultas
        const cepsParaConsultar = ceps.slice(0, this.maxCepsPorMembro);

        // Consulta cada CEP em paralelo (com limite de concorrência)
        const resultados = await Promise.allSettled(
            cepsParaConsultar.map((cep) => this.consultarCep(cep))
        );

        // Conta frequência de cada nome de bairro retornado
        const contagem = new Map<string, number>();
        for (const res of resultados) {
            if (res.status === "fulfilled" && res.value?.bairro) {
                const bairro = res.value.bairro;
                contagem.set(bairro, (contagem.get(bairro) ?? 0) + 1);
            }
        }

        if (contagem.size === 0) return null;

        // Pega o nome de bairro mais frequente
        let maisFrequente = "";
        let maiorContagem = 0;
        for (const [nome, count] of contagem) {
            if (count > maiorContagem) {
                maiorContagem = count;
                maisFrequente = nome;
            }
        }

        // Score = proporção de CEPs que concordam com o nome
        const totalConsultados = resultados.filter(
            (r) => r.status === "fulfilled" && r.value?.bairro
        ).length;

        return {
            nomeOficial: maisFrequente,
            fonte: "ViaCEP",
            score: Math.round((maiorContagem / totalConsultados) * 100) / 100,
        };
    }

    /**
     * Determina o nome oficial de um logradouro consultando seu CEP.
     *
     * @param cep - CEP do logradouro
     * @returns Nome oficial do logradouro segundo Correios
     */
    async buscarNomeLogradouro(cep: string): Promise<ResultadoOficial | null> {
        const data = await this.consultarCep(cep);
        if (!data?.logradouro) return null;

        return {
            nomeOficial: data.logradouro,
            fonte: "ViaCEP",
            score: 1.0, // CEP retorna exatamente o logradouro oficial
        };
    }
}

export const viaCepService = new ViaCepService();
```

**Step 2: Commit**

```bash
git add src/services/apis/viacep.service.ts
git commit -m "feat: serviço ViaCEP — busca nome oficial de bairros e logradouros"
```

---

## Task 5: Serviço Google Geocoding

**Files:**
- Create: `src/services/apis/google.service.ts`

**Step 1: Implementar GoogleGeocodingService**

```typescript
/**
 * GoogleGeocodingService — Fallback para nome oficial via Google Maps Geocoding API.
 *
 * Usado quando IBGE/ViaCEP não retornam resultado (especialmente para condomínios).
 * API paga: ~$5/1000 requests. Cache longo (30 dias) no Redis para minimizar custo.
 */

import { cacheService } from "../cache.service.js";
import { env } from "../../config/env.js";

// Componente de endereço retornado pela API do Google
interface AddressComponent {
    long_name: string;
    short_name: string;
    types: string[];
}

// Resultado da API de Geocoding
interface GeocodingResult {
    address_components: AddressComponent[];
    formatted_address: string;
}

interface GeocodingResponse {
    status: string;
    results: GeocodingResult[];
}

// Resultado estruturado extraído da resposta do Google
export interface GoogleEnderecoOficial {
    bairro: string | null;
    logradouro: string | null;
    cidade: string | null;
    estado: string | null;
}

export interface ResultadoOficial {
    nomeOficial: string;
    fonte: string;
    score: number;
}

class GoogleGeocodingService {
    private readonly BASE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

    // TTL configurável via env (default 30 dias)
    private get cacheTtl(): number {
        return env.GOOGLE_CACHE_TTL_DIAS * 24 * 60 * 60;
    }

    /**
     * Verifica se a API key do Google está configurada.
     */
    get disponivel(): boolean {
        return !!env.GOOGLE_GEOCODING_API_KEY;
    }

    /**
     * Geocodifica um endereço e extrai componentes estruturados.
     * Resultado cacheado no Redis por 30 dias.
     */
    async geocode(endereco: string): Promise<GoogleEnderecoOficial | null> {
        if (!this.disponivel) {
            console.warn("[GoogleGeocoding] API key não configurada — skip");
            return null;
        }

        const cacheKey = `google:geocode:${this.normalizar(endereco)}`;

        // Tenta cache
        const cached = await cacheService.get<GoogleEnderecoOficial>(cacheKey);
        if (cached) return cached;

        try {
            const params = new URLSearchParams({
                address: endereco,
                key: env.GOOGLE_GEOCODING_API_KEY!,
                language: "pt-BR",
                components: "country:BR",
            });

            const response = await fetch(`${this.BASE_URL}?${params}`);
            if (!response.ok) return null;

            const data: GeocodingResponse = await response.json();

            if (data.status !== "OK" || data.results.length === 0) return null;

            // Extrai componentes do primeiro resultado
            const resultado = this.extrairComponentes(data.results[0]);

            // Cacheia por 30 dias
            await cacheService.set(cacheKey, resultado, this.cacheTtl);

            return resultado;
        } catch (err) {
            console.warn(`[GoogleGeocoding] Erro ao geocodificar "${endereco}":`, err);
            return null;
        }
    }

    /**
     * Busca nome oficial de um condomínio via Google.
     * Monta endereço: "{condominio}, {logradouro}, {bairro}, {cidade} - {UF}"
     */
    async buscarNomeCondominio(
        nomeCondominio: string,
        logradouro: string,
        bairro: string,
        cidade: string,
        uf: string
    ): Promise<ResultadoOficial | null> {
        const endereco = `${nomeCondominio}, ${logradouro}, ${bairro}, ${cidade} - ${uf}`;
        const resultado = await this.geocode(endereco);

        // Google não retorna "nome do condomínio" diretamente,
        // mas o formatted_address pode ajudar a confirmar a localização
        if (!resultado) return null;

        // Para condominios, retorna o nome original se Google encontrou o endereço
        return {
            nomeOficial: nomeCondominio, // mantém o nome original (Google não normaliza condos)
            fonte: "Google",
            score: 0.7, // score moderado pois Google confirma localização mas não o nome
        };
    }

    /**
     * Busca genérica por nome oficial de um bairro/logradouro/cidade via Google.
     * Usado como fallback quando IBGE/ViaCEP falham.
     */
    async buscarNomeGenerico(
        nome: string,
        tipo: "bairro" | "logradouro" | "cidade",
        cidade?: string,
        uf?: string
    ): Promise<ResultadoOficial | null> {
        // Monta query contextualizada
        let endereco = nome;
        if (cidade) endereco += `, ${cidade}`;
        if (uf) endereco += ` - ${uf}`;

        const resultado = await this.geocode(endereco);
        if (!resultado) return null;

        // Extrai o componente correspondente ao tipo
        let nomeOficial: string | null = null;
        switch (tipo) {
            case "bairro":
                nomeOficial = resultado.bairro;
                break;
            case "logradouro":
                nomeOficial = resultado.logradouro;
                break;
            case "cidade":
                nomeOficial = resultado.cidade;
                break;
        }

        if (!nomeOficial) return null;

        return {
            nomeOficial,
            fonte: "Google",
            score: 0.8,
        };
    }

    /**
     * Extrai componentes de endereço estruturados do resultado do Google.
     */
    private extrairComponentes(result: GeocodingResult): GoogleEnderecoOficial {
        const componentes = result.address_components;

        return {
            bairro:
                this.encontrarComponente(componentes, "sublocality_level_1") ??
                this.encontrarComponente(componentes, "sublocality") ??
                null,
            logradouro: this.encontrarComponente(componentes, "route") ?? null,
            cidade:
                this.encontrarComponente(componentes, "administrative_area_level_2") ??
                this.encontrarComponente(componentes, "locality") ??
                null,
            estado:
                this.encontrarComponente(componentes, "administrative_area_level_1") ?? null,
        };
    }

    /**
     * Encontra um componente de endereço pelo tipo.
     */
    private encontrarComponente(
        componentes: AddressComponent[],
        tipo: string
    ): string | undefined {
        return componentes.find((c) => c.types.includes(tipo))?.long_name;
    }

    /**
     * Normaliza string para chave de cache.
     */
    private normalizar(str: string): string {
        return str
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, "-")
            .trim();
    }
}

export const googleGeocodingService = new GoogleGeocodingService();
```

**Step 2: Commit**

```bash
git add src/services/apis/google.service.ts
git commit -m "feat: serviço Google Geocoding — fallback para nome oficial"
```

---

## Task 6: EnriquecimentoService — orquestrador

**Files:**
- Create: `src/services/enriquecimento.service.ts`

**Step 1: Implementar EnriquecimentoService**

```typescript
/**
 * EnriquecimentoService — Orquestra a busca de contexto hierárquico e nome oficial
 * para cada grupo de duplicatas criado pelo scan.
 *
 * Pipeline: busca hierarquia (SQL) → consulta APIs externas → determina canônico sugerido → persiste.
 */

import { prisma } from "../config/database.js";
import { env } from "../config/env.js";
import { TipoEntidade } from "../types/index.js";
import { ibgeService } from "./apis/ibge.service.js";
import { viaCepService } from "./apis/viacep.service.js";
import { googleGeocodingService } from "./apis/google.service.js";
import type { ResultadoOficial } from "./apis/ibge.service.js";

// Tipo intermediário para contexto de um membro antes de persistir
interface ContextoMembro {
    registroId: string;
    cidadeNome: string | null;
    cidadeId: string | null;
    estadoSigla: string | null;
    bairroNome: string | null;
    bairroId: string | null;
    logradouroNome: string | null;
    logradouroId: string | null;
    ceps: string[];
    totalLogradouros: number | null;
    totalCondominios: number | null;
    totalBairros: number | null;
}

class EnriquecimentoService {
    /**
     * Enriquece um array de grupos recém-criados pelo scan.
     * Para cada grupo: busca hierarquia, consulta APIs, sugere canônico, persiste.
     */
    async enriquecer(grupoIds: string[]): Promise<void> {
        if (!env.ENRIQUECIMENTO_HABILITADO) {
            console.log("[Enriquecimento] Desabilitado via env — skip");
            return;
        }

        console.log(`[Enriquecimento] Enriquecendo ${grupoIds.length} grupos...`);

        for (const grupoId of grupoIds) {
            try {
                await this.enriquecerGrupo(grupoId);
            } catch (err) {
                // Erro em um grupo não bloqueia os demais
                console.error(
                    `[Enriquecimento] Erro no grupo ${grupoId}:`,
                    err instanceof Error ? err.message : err
                );
            }
        }

        console.log(`[Enriquecimento] Concluído — ${grupoIds.length} grupos processados`);
    }

    /**
     * Enriquece um único grupo: hierarquia + nome oficial + sugestão.
     */
    private async enriquecerGrupo(grupoId: string): Promise<void> {
        // Busca o grupo do banco
        const grupo = await prisma.ms_grupo_duplicata.findUnique({
            where: { id: grupoId },
        });
        if (!grupo) return;

        const tipo = grupo.tipo_entidade as TipoEntidade;

        // 1. Busca contexto hierárquico para cada membro
        const contextos = await this.buscarContextosMembros(
            tipo,
            grupo.registro_ids,
            grupo.nomes_membros
        );

        // 2. Busca nome oficial via APIs externas
        const nomeOficial = await this.buscarNomeOficial(
            tipo,
            grupo.nomes_membros,
            contextos
        );

        // 3. Determina canônico sugerido
        const canonicoSugeridoId = this.determinarCanonicoSugerido(
            grupo.registro_ids,
            grupo.nomes_membros,
            nomeOficial
        );

        // 4. Persiste contextos na tabela ms_membro_contexto
        await prisma.ms_membro_contexto.createMany({
            data: contextos.map((ctx) => ({
                grupo_id: grupoId,
                registro_id: ctx.registroId,
                cidade_nome: ctx.cidadeNome,
                cidade_id: ctx.cidadeId,
                estado_sigla: ctx.estadoSigla,
                bairro_nome: ctx.bairroNome,
                bairro_id: ctx.bairroId,
                logradouro_nome: ctx.logradouroNome,
                logradouro_id: ctx.logradouroId,
                ceps: ctx.ceps,
                total_logradouros: ctx.totalLogradouros,
                total_condominios: ctx.totalCondominios,
                total_bairros: ctx.totalBairros,
            })),
        });

        // 5. Atualiza o grupo com nome oficial e canônico sugerido
        await prisma.ms_grupo_duplicata.update({
            where: { id: grupoId },
            data: {
                nome_oficial: nomeOficial?.nomeOficial ?? null,
                fonte_oficial: nomeOficial?.fonte ?? null,
                canonico_sugerido_id: canonicoSugeridoId,
            },
        });
    }

    /**
     * Busca hierarquia de cada membro via queries SQL diretas no banco do CRM.
     */
    private async buscarContextosMembros(
        tipo: TipoEntidade,
        registroIds: string[],
        nomes: string[]
    ): Promise<ContextoMembro[]> {
        const contextos: ContextoMembro[] = [];

        for (let i = 0; i < registroIds.length; i++) {
            const id = registroIds[i];
            let ctx: ContextoMembro;

            switch (tipo) {
                case TipoEntidade.Cidade:
                    ctx = await this.contextoParaCidade(id);
                    break;
                case TipoEntidade.Bairro:
                    ctx = await this.contextoParaBairro(id);
                    break;
                case TipoEntidade.Logradouro:
                    ctx = await this.contextoParaLogradouro(id);
                    break;
                case TipoEntidade.Condominio:
                    ctx = await this.contextoParaCondominio(id);
                    break;
                default:
                    ctx = this.contextoVazio(id);
            }

            contextos.push(ctx);
        }

        return contextos;
    }

    /**
     * Contexto para Cidade: busca estado_sigla e total de bairros.
     */
    private async contextoParaCidade(cidadeId: string): Promise<ContextoMembro> {
        const rows = await prisma.$queryRawUnsafe<
            { estado_id: string; total_bairros: bigint }[]
        >(
            `SELECT c.estado_id,
                    (SELECT COUNT(*) FROM bairro b WHERE b.cidade_id = c.id AND (b.excluido = false OR b.excluido IS NULL)) as total_bairros
             FROM cidade c WHERE c.id = $1::int`,
            cidadeId
        );

        const row = rows[0];
        return {
            registroId: cidadeId,
            cidadeNome: null,
            cidadeId: null,
            estadoSigla: row?.estado_id ?? null,
            bairroNome: null,
            bairroId: null,
            logradouroNome: null,
            logradouroId: null,
            ceps: [],
            totalLogradouros: null,
            totalCondominios: null,
            totalBairros: row ? Number(row.total_bairros) : null,
        };
    }

    /**
     * Contexto para Bairro: busca cidade+estado, CEPs dos logradouros filhos, total logradouros.
     */
    private async contextoParaBairro(bairroId: string): Promise<ContextoMembro> {
        // Busca cidade e estado do bairro
        const hierarquia = await prisma.$queryRawUnsafe<
            { cidade_nome: string; cidade_id: string; estado_sigla: string }[]
        >(
            `SELECT c.nome as cidade_nome, c.id::text as cidade_id, c.estado_id as estado_sigla
             FROM bairro b
             JOIN cidade c ON c.id = b.cidade_id
             WHERE b.id = $1::uuid`,
            bairroId
        );

        // Busca CEPs dos logradouros filhos (top N por referência)
        const cepRows = await prisma.$queryRawUnsafe<{ cep: string }[]>(
            `SELECT DISTINCT l.cep FROM logradouro l
             WHERE l.bairro_id = $1::uuid
               AND l.cep IS NOT NULL AND l.cep != ''
               AND (l.excluido = false OR l.excluido IS NULL)
             LIMIT $2`,
            bairroId,
            env.VIACEP_MAX_CEPS_POR_MEMBRO
        );

        // Conta total de logradouros
        const countRows = await prisma.$queryRawUnsafe<{ total: bigint }[]>(
            `SELECT COUNT(*) as total FROM logradouro
             WHERE bairro_id = $1::uuid AND (excluido = false OR excluido IS NULL)`,
            bairroId
        );

        const h = hierarquia[0];
        return {
            registroId: bairroId,
            cidadeNome: h?.cidade_nome ?? null,
            cidadeId: h?.cidade_id ?? null,
            estadoSigla: h?.estado_sigla ?? null,
            bairroNome: null,
            bairroId: null,
            logradouroNome: null,
            logradouroId: null,
            ceps: cepRows.map((r) => r.cep),
            totalLogradouros: Number(countRows[0]?.total ?? 0),
            totalCondominios: null,
            totalBairros: null,
        };
    }

    /**
     * Contexto para Logradouro: busca bairro+cidade+estado, CEP próprio, total condos.
     */
    private async contextoParaLogradouro(logradouroId: string): Promise<ContextoMembro> {
        const hierarquia = await prisma.$queryRawUnsafe<
            {
                bairro_nome: string;
                bairro_id: string;
                cidade_nome: string;
                cidade_id: string;
                estado_sigla: string;
                cep: string | null;
            }[]
        >(
            `SELECT b.nome as bairro_nome, b.id::text as bairro_id,
                    c.nome as cidade_nome, c.id::text as cidade_id, c.estado_id as estado_sigla,
                    l.cep
             FROM logradouro l
             JOIN bairro b ON b.id = l.bairro_id
             JOIN cidade c ON c.id = b.cidade_id
             WHERE l.id = $1::uuid`,
            logradouroId
        );

        // Conta condominios neste logradouro
        const countRows = await prisma.$queryRawUnsafe<{ total: bigint }[]>(
            `SELECT COUNT(*) as total FROM condominio
             WHERE logradouro_id = $1::uuid AND (excluido = false OR excluido IS NULL)`,
            logradouroId
        );

        const h = hierarquia[0];
        return {
            registroId: logradouroId,
            cidadeNome: h?.cidade_nome ?? null,
            cidadeId: h?.cidade_id ?? null,
            estadoSigla: h?.estado_sigla ?? null,
            bairroNome: h?.bairro_nome ?? null,
            bairroId: h?.bairro_id ?? null,
            logradouroNome: null,
            logradouroId: null,
            ceps: h?.cep ? [h.cep] : [],
            totalLogradouros: null,
            totalCondominios: Number(countRows[0]?.total ?? 0),
            totalBairros: null,
        };
    }

    /**
     * Contexto para Condomínio: busca logradouro+bairro+cidade+estado, CEP do logradouro pai.
     */
    private async contextoParaCondominio(condominioId: string): Promise<ContextoMembro> {
        const hierarquia = await prisma.$queryRawUnsafe<
            {
                logradouro_nome: string;
                logradouro_id: string;
                bairro_nome: string;
                bairro_id: string;
                cidade_nome: string;
                cidade_id: string;
                estado_sigla: string;
                cep: string | null;
            }[]
        >(
            `SELECT l.nome as logradouro_nome, l.id::text as logradouro_id,
                    b.nome as bairro_nome, b.id::text as bairro_id,
                    c.nome as cidade_nome, c.id::text as cidade_id, c.estado_id as estado_sigla,
                    l.cep
             FROM condominio co
             JOIN logradouro l ON l.id = co.logradouro_id
             JOIN bairro b ON b.id = l.bairro_id
             JOIN cidade c ON c.id = b.cidade_id
             WHERE co.id = $1::uuid`,
            condominioId
        );

        const h = hierarquia[0];
        return {
            registroId: condominioId,
            cidadeNome: h?.cidade_nome ?? null,
            cidadeId: h?.cidade_id ?? null,
            estadoSigla: h?.estado_sigla ?? null,
            bairroNome: h?.bairro_nome ?? null,
            bairroId: h?.bairro_id ?? null,
            logradouroNome: h?.logradouro_nome ?? null,
            logradouroId: h?.logradouro_id ?? null,
            ceps: h?.cep ? [h.cep] : [],
            totalLogradouros: null,
            totalCondominios: null,
            totalBairros: null,
        };
    }

    /**
     * Contexto vazio (fallback).
     */
    private contextoVazio(registroId: string): ContextoMembro {
        return {
            registroId,
            cidadeNome: null, cidadeId: null, estadoSigla: null,
            bairroNome: null, bairroId: null,
            logradouroNome: null, logradouroId: null,
            ceps: [], totalLogradouros: null, totalCondominios: null, totalBairros: null,
        };
    }

    /**
     * Busca nome oficial nas APIs externas (IBGE → ViaCEP → Google).
     */
    private async buscarNomeOficial(
        tipo: TipoEntidade,
        nomes: string[],
        contextos: ContextoMembro[]
    ): Promise<ResultadoOficial | null> {
        // Usa o primeiro contexto como referência para dados hierárquicos
        const ctx = contextos[0];
        if (!ctx) return null;

        // Nome de referência para busca
        const nomeRef = nomes[0];

        switch (tipo) {
            case TipoEntidade.Cidade: {
                // IBGE é a fonte primária para cidades
                if (ctx.estadoSigla) {
                    const ibge = await ibgeService.buscarCidade(nomeRef, ctx.estadoSigla);
                    if (ibge) return ibge;
                }
                // Fallback: Google
                return googleGeocodingService.buscarNomeGenerico(
                    nomeRef, "cidade", undefined, ctx.estadoSigla ?? undefined
                );
            }

            case TipoEntidade.Bairro: {
                // ViaCEP é a fonte primária para bairros (via CEPs dos logradouros)
                // Coleta todos os CEPs de todos os membros
                const todosCeps = contextos.flatMap((c) => c.ceps);
                if (todosCeps.length > 0) {
                    const viacep = await viaCepService.buscarNomeBairro(todosCeps);
                    if (viacep) return viacep;
                }
                // Fallback: Google
                return googleGeocodingService.buscarNomeGenerico(
                    nomeRef, "bairro", ctx.cidadeNome ?? undefined, ctx.estadoSigla ?? undefined
                );
            }

            case TipoEntidade.Logradouro: {
                // ViaCEP é a fonte primária (via CEP do logradouro)
                // Tenta o CEP de cada membro até encontrar
                for (const c of contextos) {
                    if (c.ceps.length > 0) {
                        const viacep = await viaCepService.buscarNomeLogradouro(c.ceps[0]);
                        if (viacep) return viacep;
                    }
                }
                // Fallback: Google
                return googleGeocodingService.buscarNomeGenerico(
                    nomeRef, "logradouro", ctx.cidadeNome ?? undefined, ctx.estadoSigla ?? undefined
                );
            }

            case TipoEntidade.Condominio: {
                // Google é a fonte primária (e única) para condominios
                return googleGeocodingService.buscarNomeCondominio(
                    nomeRef,
                    ctx.logradouroNome ?? "",
                    ctx.bairroNome ?? "",
                    ctx.cidadeNome ?? "",
                    ctx.estadoSigla ?? ""
                );
            }
        }

        return null;
    }

    /**
     * Determina o membro sugerido como canônico.
     * Critérios: 1) maior similaridade com nome oficial, 2) desempate por posição original.
     */
    private determinarCanonicoSugerido(
        registroIds: string[],
        nomes: string[],
        nomeOficial: ResultadoOficial | null
    ): string | null {
        if (registroIds.length === 0) return null;

        // Se não tem nome oficial, retorna null (frontend usa lógica padrão: mais referências)
        if (!nomeOficial) return null;

        const nomeOfNorm = this.normalizar(nomeOficial.nomeOficial);

        let melhorIdx = 0;
        let melhorScore = 0;

        for (let i = 0; i < nomes.length; i++) {
            const nomeNorm = this.normalizar(nomes[i]);
            const score = this.similaridadeDice(nomeOfNorm, nomeNorm);
            if (score > melhorScore) {
                melhorScore = score;
                melhorIdx = i;
            }
        }

        return registroIds[melhorIdx];
    }

    /**
     * Normaliza string para comparação.
     */
    private normalizar(str: string): string {
        return str
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, " ")
            .trim();
    }

    /**
     * Dice coefficient entre duas strings.
     */
    private similaridadeDice(a: string, b: string): number {
        if (a === b) return 1;
        if (a.length < 2 || b.length < 2) return 0;

        const bigramsA = new Set<string>();
        for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.slice(i, i + 2));

        const bigramsB = new Set<string>();
        for (let i = 0; i < b.length - 1; i++) bigramsB.add(b.slice(i, i + 2));

        let intersecao = 0;
        for (const bg of bigramsA) {
            if (bigramsB.has(bg)) intersecao++;
        }

        return (2 * intersecao) / (bigramsA.size + bigramsB.size);
    }
}

export const enriquecimentoService = new EnriquecimentoService();
```

**Step 2: Commit**

```bash
git add src/services/enriquecimento.service.ts
git commit -m "feat: EnriquecimentoService — orquestrador de hierarquia + nome oficial"
```

---

## Task 7: Integrar enriquecimento no pipeline de scan

**Files:**
- Modify: `src/services/deteccao.service.ts:96-141`

**Step 1: Importar e chamar EnriquecimentoService após persistência dos grupos**

Adicionar import no topo do arquivo:

```typescript
import { enriquecimentoService } from "./enriquecimento.service.js";
```

No método `executarDeteccao`, após o loop de persistência dos grupos (após a linha `totalGrupos += grupos.length;`), coletar os IDs criados e chamar o enriquecimento:

Substituir o bloco do for (linhas 108-141) por:

```typescript
            // Processa cada tipo de entidade sequencialmente
            for (const tipoAtual of tipos) {
                console.log(
                    `[DeteccaoService] Processando tipo ${TIPO_ENTIDADE_TABELA[tipoAtual as TipoEntidade]}...`
                );

                // Detecta grupos para esse tipo (sem filtro de parentId, pega todos)
                const grupos = await this.detectarPorTipo(tipoAtual, null);

                // Coleta IDs dos grupos criados para enriquecimento posterior
                const grupoIdsCriados: string[] = [];

                // Persiste cada grupo no banco
                for (const grupo of grupos) {
                    const criado = await prisma.ms_grupo_duplicata.create({
                        data: {
                            tipo_entidade: grupo.tipoEntidade,
                            parent_id: grupo.parentId,
                            nome_normalizado: grupo.nomeNormalizado,
                            registro_ids: grupo.registroIds,
                            nomes_membros: grupo.nomesMembros,
                            score_medio: grupo.scoreMedio,
                            fonte: "pg_trgm",
                            status: 1, // Pendente
                        },
                    });
                    grupoIdsCriados.push(criado.id);
                }

                totalGrupos += grupos.length;
                totalAnalisados += grupos.reduce(
                    (acc, g) => acc + g.registroIds.length,
                    0
                );

                console.log(
                    `[DeteccaoService] Tipo ${TIPO_ENTIDADE_TABELA[tipoAtual as TipoEntidade]}: ${grupos.length} grupos encontrados`
                );

                // Enriquece os grupos recém-criados com hierarquia e nome oficial
                if (grupoIdsCriados.length > 0) {
                    await enriquecimentoService.enriquecer(grupoIdsCriados);
                }
            }
```

**Step 2: Testar o scan manualmente**

Run: `curl -X POST http://localhost:3003/scan -H "Content-Type: application/json" -d '{"tipo": 2}'`
Expected: Scan de bairros executa com logs de enriquecimento no console

**Step 3: Commit**

```bash
git add src/services/deteccao.service.ts
git commit -m "feat: integrar enriquecimento no pipeline de scan"
```

---

## Task 8: Atualizar endpoint GET /grupos/:id para retornar contextos

**Files:**
- Modify: `src/routes/grupos.routes.ts:39-60`

**Step 1: Incluir contextos e novos campos na resposta**

Substituir o handler do `GET /:id` por:

```typescript
    // GET /grupos/:id — detalhe de um grupo com membros, impacto e contexto
    app.get("/:id", async (request, reply) => {
        const { id } = request.params as { id: string };

        // Busca grupo com contextos dos membros
        const grupo = await prisma.ms_grupo_duplicata.findUnique({
            where: { id },
            include: {
                logs: true,
                contextos: true, // ms_membro_contexto
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

        // Anexa contexto a cada membro (match por registro_id)
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
```

**Step 2: Testar endpoint**

Run: `curl http://localhost:3003/grupos/{ID_DE_UM_GRUPO} | jq .`
Expected: Resposta inclui `nome_oficial`, `fonte_oficial`, `canonico_sugerido_id` no grupo e `contexto` em cada membro

**Step 3: Commit**

```bash
git add src/routes/grupos.routes.ts
git commit -m "feat: endpoint GET /grupos/:id retorna contextos e nome oficial"
```

---

## Task 9: Frontend — atualizar types

**Files:**
- Modify: `latitude.crm.frontend-main/src/screens/deduplicacao-localidades/types.ts`

**Step 1: Adicionar interfaces de contexto e campos novos**

Adicionar interface `ContextoMembro` antes de `MembroGrupo`:

```typescript
// Contexto hierárquico de um membro (preenchido pelo enriquecimento)
export interface ContextoMembro {
    cidade_nome: string | null;
    cidade_id: string | null;
    estado_sigla: string | null;
    bairro_nome: string | null;
    bairro_id: string | null;
    logradouro_nome: string | null;
    logradouro_id: string | null;
    ceps: string[];
    total_logradouros: number | null;
    total_condominios: number | null;
    total_bairros: number | null;
}
```

Adicionar `contexto` em `MembroGrupo`:

```typescript
export interface MembroGrupo {
    id: string;
    nome: string;
    impacto: Record<string, number>;
    totalReferencias: number;
    contexto: ContextoMembro | null; // NOVO
}
```

Adicionar campos em `GrupoDuplicata`:

```typescript
    nome_oficial: string | null;          // NOVO
    fonte_oficial: string | null;         // NOVO
    canonico_sugerido_id: string | null;  // NOVO
```

**Step 2: Commit**

```bash
git add src/screens/deduplicacao-localidades/types.ts
git commit -m "feat: types — adicionar ContextoMembro e campos de nome oficial"
```

---

## Task 10: Frontend — atualizar hook useGrupoDeduplicacaoDetail

**Files:**
- Modify: `latitude.crm.frontend-main/src/screens/deduplicacao-localidades/grupo-detail/useGrupoDeduplicacaoDetail.ts`

**Step 1: Usar canonico_sugerido_id e nome_oficial para inicializar estados**

Substituir a lógica de pré-seleção do canônico (linhas 39-43) por:

```typescript
            // Pré-seleciona canônico: usa sugestão do enriquecimento se disponível,
            // senão usa o membro com mais referências (primeiro da lista)
            if (data.grupo.canonico_sugerido_id) {
                setCanonicoId(data.grupo.canonico_sugerido_id);
                // Nome final: usa nome oficial se disponível, senão nome do membro sugerido
                const sugerido = data.membros.find(
                    (m) => m.id === data.grupo.canonico_sugerido_id
                );
                setNomeFinal(data.grupo.nome_oficial ?? sugerido?.nome ?? "");
            } else if (data.membros.length > 0) {
                setCanonicoId(data.membros[0].id);
                setNomeFinal(data.membros[0].nome);
            }
```

**Step 2: Commit**

```bash
git add src/screens/deduplicacao-localidades/grupo-detail/useGrupoDeduplicacaoDetail.ts
git commit -m "feat: hook detalhe — auto-selecionar canônico e nome oficial"
```

---

## Task 11: Frontend — atualizar componente GrupoDeduplicacaoDetail

**Files:**
- Modify: `latitude.crm.frontend-main/src/screens/deduplicacao-localidades/grupo-detail/GrupoDeduplicacaoDetail.tsx`

**Step 1: Adicionar card de referência oficial**

Adicionar import do `CheckCircleOutlined` e `QuestionCircleOutlined`:

```typescript
import { ArrowLeftOutlined, CheckOutlined, CloseOutlined, UndoOutlined, CheckCircleOutlined, QuestionCircleOutlined } from "@ant-design/icons";
```

Adicionar import do `ContextoMembro` e `TipoEntidade`:

```typescript
import {
    TIPO_ENTIDADE_LABEL,
    TIPO_ENTIDADE_COLOR,
    STATUS_GRUPO_LABEL,
    STATUS_GRUPO_COLOR,
    StatusGrupo,
    TipoEntidade,
    type MembroGrupo,
    type ContextoMembro,
} from "../types";
```

Após o header (após `</div>` da linha 232), antes do Card principal, inserir o card de referência oficial:

```tsx
            {/* Card de Referência Oficial */}
            <Card className="shadow-sm mb-4">
                <div className="flex items-center gap-3">
                    {grupo.nome_oficial ? (
                        <>
                            <CheckCircleOutlined className="text-green-600 text-xl" />
                            <div>
                                <span className="text-sm text-gray-500">Nome Oficial:</span>
                                <span className="ml-2 font-semibold text-gray-900 text-lg">
                                    {grupo.nome_oficial}
                                </span>
                                <span className="ml-3 px-2 py-1 text-xs bg-green-100 text-green-700 rounded-full">
                                    {grupo.fonte_oficial}
                                </span>
                            </div>
                        </>
                    ) : (
                        <>
                            <QuestionCircleOutlined className="text-gray-400 text-xl" />
                            <span className="text-sm text-gray-500">
                                Sem referência oficial disponível — decida manualmente
                            </span>
                        </>
                    )}
                </div>
            </Card>
```

**Step 2: Adicionar coluna Contexto na tabela de membros**

Inserir nova coluna após a coluna "Nome" (após o objeto com key "nome"):

```typescript
        {
            title: "Contexto",
            key: "contexto",
            render: (_: unknown, record: MembroGrupo) => {
                const ctx = record.contexto;
                if (!ctx) return <span className="text-xs text-gray-400">-</span>;

                // Monta string de hierarquia conforme o tipo
                const partes: string[] = [];
                if (ctx.bairro_nome) partes.push(ctx.bairro_nome);
                if (ctx.cidade_nome) partes.push(ctx.cidade_nome);
                if (ctx.estado_sigla) partes.push(ctx.estado_sigla);

                // Monta info de filhos
                const filhos: string[] = [];
                if (ctx.total_bairros != null) filhos.push(`${ctx.total_bairros} bairros`);
                if (ctx.total_logradouros != null) filhos.push(`${ctx.total_logradouros} logradouros`);
                if (ctx.total_condominios != null) filhos.push(`${ctx.total_condominios} condos`);

                return (
                    <div>
                        <div className="text-sm text-gray-700">
                            {partes.join(", ") || "-"}
                        </div>
                        {filhos.length > 0 && (
                            <div className="text-xs text-gray-500">{filhos.join(" · ")}</div>
                        )}
                    </div>
                );
            },
        },
```

**Step 3: Adicionar coluna CEPs na tabela de membros**

Inserir nova coluna após a coluna "Contexto":

```typescript
        {
            title: "CEPs",
            key: "ceps",
            width: 160,
            render: (_: unknown, record: MembroGrupo) => {
                const ceps = record.contexto?.ceps ?? [];
                if (ceps.length === 0) return <span className="text-xs text-gray-400">-</span>;

                // Mostra os 2 primeiros CEPs + tooltip com todos
                const visivel = ceps.slice(0, 2);
                const restante = ceps.length - 2;

                return (
                    <Tooltip title={ceps.join(", ")}>
                        <div className="text-xs text-gray-700">
                            {visivel.join(", ")}
                            {restante > 0 && (
                                <span className="ml-1 text-blue-600 cursor-pointer">
                                    (+{restante})
                                </span>
                            )}
                        </div>
                    </Tooltip>
                );
            },
        },
```

**Step 4: Atualizar card "Nome Final" para mostrar fonte**

Adicionar hint da fonte abaixo do Input (dentro do card `isPendente`, após o `<Input>`):

```tsx
                    {grupo.nome_oficial && (
                        <p className="text-xs text-gray-400 mt-1">
                            Sugerido pela fonte: {grupo.fonte_oficial}
                        </p>
                    )}
```

**Step 5: Commit**

```bash
git add src/screens/deduplicacao-localidades/grupo-detail/GrupoDeduplicacaoDetail.tsx
git commit -m "feat: tela detalhe — card oficial + colunas contexto e CEPs"
```

---

## Task 12: Teste end-to-end manual

**Step 1: Reiniciar o microserviço**

Run: `screen -S dedup -X stuff "^C"` (para o processo) e depois restartar

**Step 2: Rodar migration**

Run: `cd /Users/azaeldourado/Documents/git-latitude/remove-duplicidade-localizacao && npx prisma migrate dev --name enriquecimento-contexto`

**Step 3: Executar scan de teste (bairros)**

Run: `curl -X POST http://localhost:3003/scan -H "Content-Type: application/json" -d '{"tipo": 2}'`
Expected: Scan conclui com logs de enriquecimento no console

**Step 4: Verificar dados no banco**

Run: `curl http://localhost:3003/grupos?tipo=2&tamanhoPagina=1 | jq '.data[0] | {nome_oficial, fonte_oficial, canonico_sugerido_id}'`
Expected: Campos preenchidos (ou null se as APIs não retornaram)

**Step 5: Verificar frontend**

Acessar: `http://localhost:3001/deduplicacao-localidades/grupos`
Clicar em um grupo → verificar:
- Card de referência oficial aparece
- Colunas Contexto e CEPs estão preenchidas
- Canônico pré-selecionado e Nome Final preenchido

**Step 6: Commit final se necessário**

```bash
git commit -am "fix: ajustes finais do enriquecimento pós-teste"
```

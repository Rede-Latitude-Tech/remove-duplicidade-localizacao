# remove-duplicidade-localizacao

Microserviço para detecção e eliminação de duplicidades semânticas em entidades geográficas do CRM Latitude.

> **Status:** Em desenvolvimento. Não está ativo em homologação nem em produção.

## O que resolve

O banco de dados do CRM Latitude acumula duplicatas não-óbvias em localidades:

| Exemplo | Tipo |
|---|---|
| "Marista" vs "Setor Marista" vs "St. Marista" | Bairro |
| "BELVEDERE 2" vs "Belvedere II" vs "Belvedere dois" | Bairro |
| "Av Brasil" vs "Avenida Brasil" vs "AV. BRASIL" | Logradouro |
| "Cond Solar das Palmeiras" vs "Condomínio Solar Palmeiras" | Condomínio |

Essas duplicatas poluem filtros, relatórios e buscas. O microserviço detecta, agrupa e permite unificar esses registros com rollback completo.

## Arquitetura

```
┌─────────────────────────────────────────────────┐
│  Frontend (Next.js CRM)                         │
│  /src/screens/deduplicacao-localidades/          │
└──────────────────┬──────────────────────────────┘
                   │ REST/HTTP
┌──────────────────▼──────────────────────────────┐
│  Fastify (porta 3003)                           │
│  ┌────────────────────────────────────────────┐ │
│  │  Routes                                    │ │
│  │  /health  /grupos  /scan  /stats /relatorio│ │
│  └──────┬─────────────────────────────────────┘ │
│  ┌──────▼─────────────────────────────────────┐ │
│  │  Services                                  │ │
│  │  Normalizador → Detecção → LLM → Impacto  │ │
│  │  Enriquecimento → Merge → Cache            │ │
│  └──────┬──────────────┬──────────────────────┘ │
│         │              │                         │
│  ┌──────▼──────┐ ┌─────▼──────────────────────┐ │
│  │ PostgreSQL  │ │ APIs externas              │ │
│  │ (Azure HML) │ │ IBGE / ViaCEP / Google     │ │
│  └─────────────┘ │ Claude / OpenAI (LLM)      │ │
│  ┌─────────────┐ └────────────────────────────┘ │
│  │ Redis       │                                 │
│  │ (cache+jobs)│                                 │
│  └─────────────┘                                 │
└──────────────────────────────────────────────────┘
```

Serviço 100% independente — não modifica o backend .NET (Locare.API). Opera diretamente no banco compartilhado via Prisma, em tabelas próprias prefixadas com `ms_`.

## Stack

| Componente | Tecnologia |
|---|---|
| Runtime | Node.js 22+ |
| Framework | Fastify 5 |
| ORM | Prisma 6 |
| Banco | PostgreSQL (Azure) |
| Cache / Jobs | Redis + ioredis |
| Similaridade | PostgreSQL pg_trgm |
| LLM (semântica) | Claude API (Anthropic SDK) |
| LLM (validação) | OpenAI (batch rejeição falsos positivos) |
| Validação | Zod |
| Testes | Vitest |

## Setup

### Pré-requisitos

- Node.js >= 22
- PostgreSQL com extensão `pg_trgm`
- Redis

### Instalação

```bash
git clone https://github.com/Rede-Latitude-Tech/remove-duplicidade-localizacao.git
cd remove-duplicidade-localizacao
npm install
cp .env.example .env
# Editar .env com credenciais reais
npx prisma generate
npx prisma db push    # cria as tabelas ms_* no banco
```

### Executar

```bash
npm run dev       # dev com hot-reload (tsx watch)
npm run build     # compilar TypeScript
npm start         # produção (dist/)
```

### Testes

```bash
npm test          # vitest run
npm run test:watch
```

## Variáveis de ambiente

```env
# Banco PostgreSQL (mesmo do CRM Latitude)
DATABASE_URL=postgresql://user:pass@host:5432/db?sslmode=require

# Redis
REDIS_URL=redis://localhost:6379

# Servidor
PORT=3003
NODE_ENV=development

# LLM — análise semântica (opcional, melhora detecção)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Thresholds de detecção
THRESHOLD_SIMILARIDADE=0.4   # mínimo pg_trgm para considerar par
THRESHOLD_LLM=0.8            # mínimo LLM para confirmar duplicata
LIMITE_PARES_POR_EXECUCAO=200

# Enriquecimento — APIs externas para nome oficial
ENRIQUECIMENTO_HABILITADO=true
GOOGLE_GEOCODING_API_KEY=AIza...
VIACEP_MAX_CEPS_POR_MEMBRO=10
VIACEP_CACHE_TTL_DIAS=7
GOOGLE_CACHE_TTL_DIAS=30
```

## API

### Health

```
GET /health → { status, service, version, uptime }
```

### Grupos de duplicatas

```
GET  /grupos                         Lista grupos (filtros: tipo, status, pagina, tamanhoPagina)
GET  /grupos/:id                     Detalhe com contextos e nome oficial
GET  /grupos/:id/impacto             FKs afetadas por merge
GET  /grupos/auto-aprovaveis         Grupos com confiança >= 90%
POST /grupos/revalidar-llm           Re-analisa grupos com novo modelo LLM
```

### Merge (unificação)

```
PUT  /grupos/:id/unificar            Executa merge (atualiza FKs, soft-delete duplicatas)
PUT  /grupos/:id/reverter            Rollback completo do merge
PUT  /grupos/:id/descartar           Marca como falso positivo
PUT  /grupos/:id/aprovar-sugestao    Aceita sugestão automática do LLM
POST /grupos/aprovar-sugestoes-batch Aprovação em lote
POST /grupos/reverter-todos          Reverte todos os merges executados
```

### Scan (detecção)

```
POST /scan                           Dispara detecção assíncrona
POST /scan/sync                      Detecção síncrona (espera resultado)
POST /scan/enriquecer                Enriquece grupos existentes com APIs externas
POST /scan/re-enriquecer-google      Re-enriquece via Google Geocoding
GET  /scan/historico                 Histórico de execuções
```

### Estatísticas e relatórios

```
GET /stats                           Contadores por tipo e status
GET /relatorio                       Relatório de auditoria (merges executados)
```

## Pipeline de detecção

```
1. Normalização
   Remove acentos, lowercase, colapsa espaços, strip prefixos
   ("Setor", "Jardim", "Av.", etc.), converte romanos (II → 2)

2. Similaridade (pg_trgm)
   Compara pares dentro do mesmo parent (bairros na mesma cidade, etc.)
   Score >= THRESHOLD_SIMILARIDADE → candidato

3. Agrupamento (Union-Find)
   Pares com interseção → mesmo grupo (A~B, B~C → grupo {A,B,C})

4. LLM (Claude/OpenAI)
   Casos ambíguos (score 0.4–0.8) → análise semântica
   Retorna: { saoDuplicatas, confianca, nomeCanonico, justificativa }

5. Enriquecimento
   Contexto hierárquico (cidade/bairro/logradouro/CEPs)
   Nome oficial via IBGE, ViaCEP ou Google Geocoding
   Auto-sugestão de canônico (maior similaridade com nome oficial)

6. Persistência
   Grupos salvos com status Pendente → aguardam aprovação humana
```

## Tabelas do banco (`ms_*`)

| Tabela | Propósito |
|---|---|
| `ms_grupo_duplicata` | Grupos detectados com membros, scores, LLM e status |
| `ms_merge_log` | Log granular de cada FK alterada (permite rollback) |
| `ms_execucao_log` | Histórico de execuções de scan |
| `ms_membro_contexto` | Contexto hierárquico de cada membro |

## FKs afetadas por merge

### Bairro (4 FKs)
- `logradouro.bairro_id`
- `imovel_endereco.bairro_comercial_id`
- `empresa.bairro_id`
- `property_draft_addresses.bairro_comercial_id`

### Logradouro (5 FKs)
- `imovel.logradouro_id`
- `condominio.logradouro_id`
- `pessoa.endereco_logradouro_id`
- `building_address.logradouro_id`
- `property_drafts.logradouro_id`

### Condominio (6 FKs)
- `imovel_endereco.condominio_id`
- `pessoa.condominio_id`
- `building.condominio_id`
- `benfeitoria_condominio.condominios_id`
- `condominio_imagem.condominio_id`
- `property_draft_addresses.condominio_id`

### Cidade (3 FKs)
- `bairro.cidade_id`
- `empresa.cidade_id`
- `pessoa_fisica.naturalidade_id`

## Estrutura do projeto

```
src/
├── app.ts                          # Bootstrap Fastify
├── config/
│   ├── env.ts                      # Validação de env vars (Zod)
│   └── database.ts                 # Prisma client
├── routes/
│   ├── health.routes.ts
│   ├── grupos.routes.ts
│   ├── merge.routes.ts
│   ├── scan.routes.ts
│   ├── stats.routes.ts
│   └── relatorio.routes.ts
├── services/
│   ├── normalizador.service.ts     # Normalização de nomes
│   ├── deteccao.service.ts         # Similaridade + agrupamento
│   ├── llm.service.ts              # Claude API (análise semântica)
│   ├── impacto.service.ts          # Contagem de FKs
│   ├── merge.service.ts            # Unificação transacional + rollback
│   ├── cache.service.ts            # Redis wrapper
│   ├── enriquecimento.service.ts   # Orquestrador de contexto + nome oficial
│   └── apis/
│       ├── google.service.ts       # Google Geocoding
│       ├── ibge.service.ts         # IBGE localidades
│       ├── openai.service.ts       # OpenAI validação batch
│       └── viacep.service.ts       # ViaCEP
├── database/
│   └── fk-map.ts                   # Mapa declarativo de FKs por entidade
└── types/
    └── index.ts                    # Enums e interfaces

tests/
├── services/
│   ├── normalizador.test.ts
│   ├── deteccao-scoping.test.ts
│   ├── enriquecimento.test.ts
│   └── llm-validation.test.ts

prisma/
└── schema.prisma                   # Schema das tabelas ms_*

docs/plans/
├── 2026-02-17-enriquecimento-contexto-oficial-design.md
└── 2026-02-17-enriquecimento-implementacao.md
```

## Ordem recomendada de resolução

```
1° Cidades → 2° Bairros → 3° Logradouros → 4° Condomínios
```

Resolver de cima para baixo evita que merges de filhos fiquem órfãos.

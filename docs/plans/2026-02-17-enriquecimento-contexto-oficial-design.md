# Design: Enriquecimento com Contexto Hierárquico e Nome Oficial

**Data:** 2026-02-17
**Status:** Aprovado
**Escopo:** Microserviço `remove-duplicidade-localizacao` + Frontend Next.js

---

## Problema

Na tela de detalhe de um grupo de duplicatas, o usuário não tem contexto suficiente para decidir qual membro manter como canônico. Faltam:

1. **Hierarquia completa** — para bairros, não mostra a cidade; para logradouros, não mostra bairro/cidade; CEPs ausentes
2. **Referência oficial** — sem nome oficial do IBGE, Correios ou Google para comparar

## Solução

Enriquecer automaticamente cada grupo durante o scan com:
- Contexto hierárquico por membro (cidade, bairro, logradouros, CEPs)
- Nome oficial consultado em APIs externas (IBGE, ViaCEP, Google)
- Auto-sugestão inteligente (pré-seleciona canônico + preenche nome final)

---

## Seção 1 — Dados e Schema

### Novos campos em `ms_grupo_duplicata`

| Campo | Tipo | Descrição |
|---|---|---|
| `nome_oficial` | String? | Nome oficial retornado pela API externa |
| `fonte_oficial` | String? | "IBGE", "ViaCEP" ou "Google" |
| `canonico_sugerido_id` | String? | ID do membro sugerido como canônico |

### Nova tabela `ms_membro_contexto`

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | String @id | UUID |
| `grupo_id` | String | FK → ms_grupo_duplicata |
| `registro_id` | String | ID do membro |
| `cidade_nome` | String? | Nome da cidade |
| `cidade_id` | String? | ID da cidade |
| `estado_sigla` | String? | UF |
| `bairro_nome` | String? | Nome do bairro |
| `bairro_id` | String? | ID do bairro |
| `logradouro_nome` | String? | Nome do logradouro |
| `logradouro_id` | String? | ID do logradouro |
| `ceps` | String[] | CEPs associados |
| `total_logradouros` | Int? | Contagem de logradouros (para bairros) |
| `total_condominios` | Int? | Contagem de condominios (para logradouros) |
| `total_bairros` | Int? | Contagem de bairros (para cidades) |

### Preenchimento por tipo

| Tipo | Campos preenchidos |
|---|---|
| **Cidade** | estado_sigla, total_bairros |
| **Bairro** | cidade_nome, estado_sigla, ceps (logradouros filhos), total_logradouros |
| **Logradouro** | bairro_nome, cidade_nome, estado_sigla, ceps (próprio), total_condominios |
| **Condomínio** | logradouro_nome, bairro_nome, cidade_nome, estado_sigla, ceps (logradouro pai) |

### Fontes oficiais por tipo

| Tipo | Fonte primária | Fallback |
|---|---|---|
| **Cidade** | IBGE (API localidades) | Google Geocoding |
| **Bairro** | ViaCEP (via CEPs dos logradouros) | Google Geocoding |
| **Logradouro** | ViaCEP (via CEP próprio) | Google Geocoding |
| **Condomínio** | Google Geocoding | — |

---

## Seção 2 — Pipeline do Microserviço

### Novo passo no scan

```
DeteccaoService.detectar()
  → pares similares (pg_trgm)
  → agrupamento (Union-Find)
  → persistência dos grupos
  → NOVO: EnriquecimentoService.enriquecer(grupos)
      → 1. Busca hierarquia do banco (queries JOIN)
      → 2. Consulta APIs externas (IBGE/ViaCEP/Google)
      → 3. Determina nome_oficial + canonico_sugerido
      → 4. Persiste ms_membro_contexto + atualiza grupo
```

### Novos serviços

**`enriquecimento.service.ts`** — orquestra a busca de contexto e nome oficial para cada grupo.

**`apis/ibge.service.ts`**
- `buscarCidade(nome, estadoSigla)` → GET `servicodados.ibge.gov.br/api/v1/localidades/estados/{UF}/municipios`
- Filtra por similaridade de nome no resultado
- Retorna nome oficial do município

**`apis/viacep.service.ts`**
- `buscarPorCep(cep)` → GET `viacep.com.br/ws/{cep}/json/`
- `buscarPorEndereco(uf, cidade, logradouro)` → GET `viacep.com.br/ws/{UF}/{cidade}/{logradouro}/json/`
- Estratégia: pega CEPs dos logradouros filhos, consulta ViaCEP, extrai nome de bairro mais frequente

**`apis/google.service.ts`**
- `geocode(endereco)` → GET Google Geocoding API
- Fallback para condos e quando IBGE/ViaCEP falha
- Extrai sublocality (bairro), route (logradouro), locality (cidade)

### Lógica de sugestão automática

```
Para cada grupo:
  1. Busca nome_oficial via fonte primária (IBGE/ViaCEP)
  2. Se não encontrou → fallback Google
  3. Compara nome_oficial com cada membro (similaridade)
  4. canonico_sugerido = membro com:
     a) maior similaridade com nome_oficial
     b) desempate: mais referências FK
  5. Persiste nome_oficial, fonte_oficial, canonico_sugerido_id
```

### Cache e rate limiting

- **IBGE**: cachear por estado no Redis (1 request por estado cobre todas as cidades). TTL 30 dias
- **ViaCEP**: sem API key, ~300/min. Cachear por CEP no Redis. TTL 7 dias. Limitar a 10 CEPs por membro
- **Google**: pago ($5/1000). Cachear por query no Redis. TTL 30 dias. Só como fallback

### Variáveis de ambiente novas

```
GOOGLE_GEOCODING_API_KEY=AIza...
ENRIQUECIMENTO_HABILITADO=true
VIACEP_MAX_CEPS_POR_MEMBRO=10
VIACEP_CACHE_TTL_DIAS=7
GOOGLE_CACHE_TTL_DIAS=30
```

---

## Seção 3 — Frontend (Tela de Detalhe)

### Card "Referência Oficial" (topo)

Badge verde se encontrou nome oficial, cinza se nenhuma fonte retornou. Mostra fonte e score de similaridade.

### Tabela de membros — colunas novas

| Canônico | Nome | Contexto | CEPs | Referências | Impacto |
|---|---|---|---|---|---|
| ● | Jd Paulista | São Paulo - SP | 01234-000 (+3) | 47 ref(s) | imovel: 30 |
| ○ | Jardim Paulista | São Paulo - SP | 01234-000 (+5) | 12 ref(s) | imovel: 8 |

- **Contexto**: hierarquia completa por tipo
- **CEPs**: primeiros 2-3 + tooltip com todos

### Nome Final auto-preenchido

- Se scan encontrou nome oficial → campo preenchido com ele
- Senão → nome do membro sugerido
- Sempre editável

### Endpoint GET /grupos/:id atualizado

Retorna `nome_oficial`, `fonte_oficial`, `canonico_sugerido_id` no grupo e `contexto` em cada membro.

---

## Seção 4 — Tratamento de Erros e Edge Cases

### APIs externas falhando

- Qualquer API fora → graceful skip, grupo criado sem enriquecimento
- Frontend mostra badge cinza "Sem referência oficial"
- Cadeia de fallback: fonte primária → Google → null

### Bairro sem logradouros

- Sem CEPs → tenta Google com `"{bairro}, {cidade} - {UF}"`
- Se falha → null

### Ordem de resolução recomendada

```
1° Cidades → 2° Bairros → 3° Logradouros → 4° Condomínios
```

Dashboard mostra alerta orientativo (não bloqueante).

### Rate limiting ViaCEP

- Máximo 10 CEPs por membro (configurável via env)
- Prioriza logradouros mais referenciados

### Google Geocoding custo

- ~308 grupos × ~20% fallback = ~60 requests/scan ≈ $0.30/scan
- Cache Redis evita reconsultas

# P2 — Data Layer & Hybrid Search

> Status: implemented · 2026-10-28
> Related: [Architecture](ARCHITECTURE.md) §5–§7 · [Data sources](DATA_SOURCES.md)

## What exists now

| Layer | Package | Responsibility |
|---|---|---|
| Domain | [`packages/core`](../packages/core) | Zod query schemas, types, errors, ULIDs |
| Truth store | [`packages/db`](../packages/db) | Postgres 17 schema, migration runner, repositories |
| Ingestion | [`packages/ingest`](../packages/ingest) | Section markdown → companies/documents/chunks → Qdrant |
| Retrieval | [`packages/retrieval`](../packages/retrieval) | jieba/Intl tokenizer, BM25 sparse encoder, BGE-M3 client, Qdrant, RRF/DBSF, indexer |
| API | [`apps/api`](../apps/api) | Hono search API + OpenAPI |
| CLI | [`apps/cli`](../apps/cli) | `occ migrate/seed/ingest/search/documents/company/health` |
| Embeddings | [`services/embeddings`](../services/embeddings) | Local BGE-M3 / reranker sidecar (TEI-compatible `/embed`, `/rerank`) |

Postgres is the **truth store and job queue**; Qdrant is the **retrieval engine**.
We do not turn Postgres into a search engine. `pg_trgm` is used only for ASCII
fuzzy name lookup, and the API falls back to a CJK-aware character-bigram Dice
score for Chinese names (pg_trgm ignores CJK characters entirely).

## Hybrid retrieval

```text
query
  ├─ normalize (NFKC, lowercase)
  ├─ planner: identifier / exact alias → Postgres (short-circuit ranking boost)
  ├─ sparse branch: jieba cut_for_search + Porter2 → FNV-1a 32 → Qdrant sparse (idf)
  ├─ dense branch:  BGE-M3 1024d → Qdrant dense (cosine)
  └─ Qdrant Query API: prefetch(100) + RRF/DBSF (server-side)
        → dedupe by company_id / chunk_id
        → optional rerank (bge-reranker-v2-m3)
        → hydrate from Postgres (aliases, tickers, sources)
```

- **Sparse values** are sublinear term frequencies `1 + ln(tf)`; Qdrant's `idf`
  modifier applies corpus IDF server-side.
- **Explain mode** runs the sparse and dense branches separately, then returns
  each branch's rank/score plus the fused order. Hybrid hits carry
  `explain.sparseRank`, `denseRank`, `fusedScore`, and `matchedTerms`.
- **Exact-match guard**: identifier queries such as `00700.HK` skip fuzzy
  lookup, so unrelated HK tickers do not pollute the results.
- **Company index text** includes display name, legal name, aliases,
  description, sector, and document titles/snippets, so a company's own
  documents improve company-level recall.

## Data model (P2)

Migrations live in [`packages/db/migrations/0001_init.sql`](../packages/db/migrations/0001_init.sql).

`companies`, `company_ids`, `aliases`, `securities`, `index_memberships`,
`sources`, `documents`, `chunks`, `facts`, `financial_facts`, `products`,
`relations`, `relation_evidence`, `review_queue`, `outbox`.

Every derived row is designed to carry provenance (`source_id`, `quote`, `page`,
`method`, `confidence`, versions). The P2 seed only exercises the company /
document / chunk path; facts and relations are ready for P3 ingestion.

## Search API

```bash
curl 'http://127.0.0.1:8787/v1/search/companies?q=宁德时代&limit=5&explain=true'
curl 'http://127.0.0.1:8787/v1/search/companies?q=NVDA&mode=keyword'
curl 'http://127.0.0.1:8787/v1/search/documents?q=云%20业务%20增长&limit=5'
curl 'http://127.0.0.1:8787/v1/companies/catl'
curl 'http://127.0.0.1:8787/v1/health'
curl 'http://127.0.0.1:8787/openapi.json'
```

Response envelope:

```json
{
  "data": {
    "hits": [
      {
        "id": "01J...",
        "slug": "catl",
        "displayName": "宁德时代",
        "matchType": "alias",
        "score": 1,
        "tickers": [{ "ticker": "300750", "exchange": "SZSE" }],
        "indices": ["A500"],
        "explain": {
          "sparseRank": 1,
          "sparseScore": 3.1,
          "denseRank": 2,
          "denseScore": 0.56,
          "fusedScore": 0.83,
          "matchedTerms": ["宁德", "时代", "电池"]
        }
      }
    ],
    "explain": { "branches": { "bm25": [], "dense": [] }, "fusion": [] }
  },
  "meta": {
    "request_id": "...",
    "as_of": "2026-10-28T...",
    "took_ms": 82,
    "query": "宁德时代",
    "normalized_query": "宁德时代",
    "mode": "hybrid",
    "total": 5,
    "embedding_version": "bge-m3@1024",
    "fusion": "rrf",
    "rerank": false,
    "citations": []
  }
}
```

Modes: `hybrid` (default), `keyword` (sparse only), `semantic` (dense only).
Filters: `market`, `index`, `coverage` for companies; `company_id`, `doc_type`,
`lang` for documents. `rerank` is opt-in and requires
`OCC_RERANK_ENABLED=true`.

## Running it locally

No Docker required on the development laptop.

```bash
# 1. services
scripts/dev-db.sh start
scripts/dev-qdrant.sh start          # downloads Qdrant 1.18 arm64 once
scripts/dev-embeddings.sh start      # BGE-M3 loads on first request (~2.3 GB)

# 2. build + schema
corepack pnpm -r build
node apps/cli/dist/occ.js migrate

# 3. synthetic corpus (24 companies, 31 documents)
node apps/cli/dist/occ.js seed --reset

# 4. API + CLI
node apps/api/dist/server.js
node apps/cli/dist/occ.js search "宁德时代" --explain
node apps/cli/dist/occ.js documents "云 业务 增长"

# 5. real research sections → documents/chunks + Qdrant
node apps/cli/dist/occ.js ingest --sections phase0/out/sections --concurrency 4
```

Or run the whole thing:

```bash
corepack pnpm e2e:search
```

## Verified E2E (2026-10-28)

`node scripts/e2e-search.mjs` — **35/35 checks passed** against live Postgres,
Qdrant 1.18, and local BGE-M3 (1024d).

Selected results:

| Query | Mode | Top result |
|---|---|---|
| `宁德时代` | hybrid | CATL (alias) |
| `茅台` | hybrid | 贵州茅台 (alias) |
| `gzmt` | hybrid | 贵州茅台 (alias) |
| `NVDA` | hybrid | NVIDIA (identifier) |
| `600519` | hybrid | 贵州茅台 (identifier) |
| `00700.HK` | hybrid | 腾讯控股 (identifier) |
| `AI 芯片` | hybrid | 寒武纪, AMD, 华为, NVIDIA in top5 |
| `大模型 公司` | hybrid | 智谱, DeepSeek, 商汤, Anthropic, OpenAI in top5 |
| `白酒` | hybrid | 贵州茅台 |
| `动力电池` | hybrid | 宁德时代 |
| `社交 平台` | hybrid | 腾讯 / Meta |
| `动力电池` | keyword | 宁德时代 |
| `电动车 储能` | semantic | Tesla, CATL, BYD |
| `云 业务 增长` | documents | 阿里巴巴, 亚马逊, Apple |

Explain mode verified: BM25 branch, dense branch, fusion list, and per-hit
branch ranks are all present.

## Known limits / next

- The seed corpus is **synthetic fixtures** (`fixture://` URLs,
  `trust_tier = 'fixture'`). Real profiles enter through `occ ingest` or the
  worker's `ingest.company` queue; they are content-hashed and idempotent.
- Ingestion currently writes section markdown as one `company_profile` document
  per company (14 chunks for the A/HK profiles). Fact/product/relation
  extraction is still P3.
- MinIO snapshot upload is still pending; `documents.storage_key` is populated
  by ingestion but no object is written.
- Rerank is implemented and wired, but the E2E run uses `OCC_RERANK_ENABLED=false`
  so it does not download the second model.
- The `occ` CLI currently calls the API for search; entity resolution, graph
  queries, and MCP search tools land in P3.
- Index constituent snapshots (P4) are not loaded yet; the seeded `A500`/`HSI`/
  `SPX`/`NDX` memberships are fixture metadata.

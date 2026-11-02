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
| CLI | [`apps/cli`](../apps/cli) | `occ migrate/seed/ingest/sync-fixtures/search/documents/company/health` |
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
- **Fixture isolation**: synthetic seed rows carry `is_fixture=true` in
  Postgres and in the Qdrant payload. Company and document search add a
  `must_not is_fixture=true` filter (and the exact-match planner skips fixture
  companies), so the visible corpus is real research only. Pass
  `include_fixtures=true` for development/E2E. `occ sync-fixtures` reconciles
  flags for corpora created before migration `0002`, backfills pinyin aliases,
  and patches the Qdrant payloads.

## Data model (P2)

Migrations live in [`packages/db/migrations/`](../packages/db/migrations):
`0001_init.sql` (schema) and `0002_fixture_isolation.sql` (`is_fixture` flags).

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
curl 'http://127.0.0.1:8787/v1/search/companies?q=OpenAI&include_fixtures=true'
curl 'http://127.0.0.1:8787/v1/search/documents?q=云%20业务%20增长&limit=5'
curl 'http://127.0.0.1:8787/v1/companies/catl'
curl 'http://127.0.0.1:8787/v1/health'
curl 'http://127.0.0.1:8787/openapi.json'
```

Response envelope (legacy seed fixtures still carry old A500/SPX index labels;
real memberships are loaded for NDX / HSI / ChiNext 50, and A500/SPX are P1
placeholder pages):

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
scripts/dev-minio.sh start           # optional: snapshots (brew install minio)

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

## Real-corpus evaluation (2026-10-28, NDX baseline)

The NDX-100 backfill is ingested and indexed: 100 companies, 1,428 profile
chunks, 1,459 document points. `scripts/eval-search.mjs` reports hybrid
ticker/English-name **top-1 100%**, semantic recall@5 **90%**, document
recall@5 **100%**, and p95 **214–278ms**. Exact identifier/alias/fuzzy matches
now sort ahead of unbounded BM25 scores. The live corpus has since grown to
236 companies (NDX + HSI + CYB50); these numbers are an NDX baseline, not a
full-corpus score. Full method and comparisons: [EVAL.md](EVAL.md).

## Known limits / next

- The visible corpus is **real research only**: 236 companies (NDX 100,
  HSI 85, CYB50 50, plus one discovered); the 14 fixture-only companies and
  all 31 fixture documents are hidden by default (`include_fixtures=true`
  restores them for E2E). Old corpora need one `occ sync-fixtures` run.
- A500/SPX placeholders (P1.1) will be searchable with a `未收录` badge; they
  carry no documents, chunks or embeddings.
- News documents (`doc_type='news'`) are ingested per company from Google News
  RSS; they are searchable through `/v1/search/documents?doc_type=news` and
  appear in the company card's `events`. See [NEWS.md](NEWS.md).
- Chinese alias coverage: curated names in
  [`config/aliases/zh.yaml`](../config/aliases/zh.yaml) cover the NDX corpus and
  the A/HK profiles (`奈飞`, `好市多`, `茅台`, `腾讯`). `occ aliases sync` inserts
  them and re-indexes company points; derived pinyin aliases come from the same
  pass (`英伟达 → ywd`). New names still need a curated entry.
- Ingestion writes section markdown as one `company_profile` document per
  company (14 chunks for the A/HK profiles). Fact/product/relation extraction
  is P3 and lives in [`EXTRACT.md`](EXTRACT.md).
- Snapshot upload is implemented: `occ snapshots upload` writes every section to
  the S3-compatible store (MinIO via `scripts/dev-minio.sh`), and ingestion
  uploads new sections automatically. F10 pages are stored as structured JSON
  snapshots; raw HTML capture is still a sidecar follow-up.
- Rerank is implemented and wired, but the E2E run uses `OCC_RERANK_ENABLED=false`
  so it does not download the second model.
- The `occ` CLI calls the API for search; entity resolution, graph queries and
  MCP search tools are implemented (P3).
- Index snapshots are loaded for NDX / HSI / ChiNext 50 and write real
  `index_memberships`. P1.1 adds CSI A500 + S&P 500 **searchable placeholder**
  rows (`coverage_tier='stub'`); STAR 50 is deferred backfill. Legacy
  `A500`/`SPX` seed fixtures remain for E2E compatibility only.
- Placeholder rows are searchable with a `未收录` badge (decision 30 revised
  2026-11-01); rank them below real profiles and never render fake metrics.
- `scripts/e2e-search.sh` runs `occ seed --reset`, which **truncates the target
  database and Qdrant collections**. `occ seed` without `--reset` is also not
  safe on a shared corpus: it rewrites the 24 seed companies' aliases and
  company points. Do not run either against the research corpus; run
  `node scripts/e2e-search.mjs` directly against a live corpus, or point
  `DATABASE_URL`/`OCC_QDRANT_*` at disposable resources.

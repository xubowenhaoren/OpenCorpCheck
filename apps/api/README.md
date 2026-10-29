# @occ/api — search API

Hono + Zod server over Postgres (truth) and Qdrant (hybrid retrieval).

```bash
corepack pnpm -r build
node apps/api/dist/server.js       # OCC_API_PORT, default 8787
curl localhost:8787/v1/health
curl 'localhost:8787/v1/search/companies?q=宁德时代&explain=true'
curl 'localhost:8787/v1/search/documents?q=云%20业务%20增长'
curl localhost:8787/openapi.json
```

| Route | Purpose |
|---|---|
| `GET /v1/health` | DB, Qdrant, embedding sidecar status |
| `GET /v1/search/companies` | hybrid/keyword/semantic company search + optional explain |
| `GET /v1/search/documents` | chunk search with source citations |
| `GET /v1/companies/{id-or-slug}` | profile, aliases, listings, indices, financials |
| `GET /v1/review/queue` | pending/accepted/rejected review items |
| `POST /v1/review/proposals` | stage a fact/relation proposal (never writes directly) |
| `POST /v1/review/items/{id}/decision` | accept/reject one item; accepted items write canonical rows |
| `POST /v1/review/batch` | accept/reject a filtered batch (`ids`, `kind`, `company`, or `all`) |
| `GET /v1/review/ui` | dependency-free local review console |
| `GET /openapi.json` | OpenAPI 3.1 document |

Config comes from env (see [`.env.example`](../../.env.example)): `DATABASE_URL`,
`OCC_QDRANT_URL`, `OCC_EMBEDDING_URL`, `OCC_EMBEDDING_DIM`,
`OCC_RERANK_ENABLED`, `OCC_FUSION`.

Search internals live in [`@occ/retrieval`](../../packages/retrieval) and
[`src/services/search.ts`](src/services/search.ts). See
[`docs/SEARCH.md`](../../docs/SEARCH.md) for the design and E2E results.

Tests (`vitest`) use a fake search service; live end-to-end checks are
`corepack pnpm e2e:search`.

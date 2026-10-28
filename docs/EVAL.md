# Search Evaluation

> Status: harness implemented · live results pending the NDX-100 backfill
> Related: [Data layer & hybrid search](SEARCH.md) · [NDX snapshot](../config/indices/ndx.yaml)

## What we measure

`scripts/eval-search.mjs` runs three query families against the live API and
reports **top-1 accuracy, MRR@10, recall@5, zero-result rate, p50/p95 latency**:

| Family | Examples | Expectation |
|---|---|---|
| Ticker | `AAPL`, `ADBE`, `BRK.B` | exact identifier hit at rank 1 |
| English name | `Analog Devices`, `Automatic Data Processing` | alias/hybrid hit at rank 1 |
| Semantic (companies) | `模拟芯片 电源管理`, `短租 民宿` | expected company in top 5 |
| Semantic (documents) | `薪酬外包 人力资源`, `创意软件 订阅` | expected profile chunk in top 5 |

The ticker/name sets are generated from `config/indices/ndx.yaml`, so the eval
stays in sync with the constituent snapshot. The semantic sets are curated and
live in the script; extend them when a real query fails.

```bash
# API + services must be running, and the corpus ingested
corepack pnpm eval:search -- --mode hybrid
node scripts/eval-search.mjs --mode keyword --json > /tmp/eval-keyword.json
node scripts/eval-search.mjs --mode semantic
```

## Method

- Queries hit the real Hono API (`/v1/search/companies`, `/v1/search/documents`)
  with the selected `mode`; rerank stays off so the numbers reflect the base
  hybrid path.
- A company hit matches when any of its tickers equals the expected ticker, or
  its display/legal name contains the expected label.
- A document hit matches when `companyDisplayName` contains the expected company
  name. This is deliberately lenient: document-level relevance is checked by
  reading the returned chunk text, not just the company label.
- Latency uses `meta.took_ms` (Qdrant + embedding + hydration), reported as
  p50/p95; wall-clock p95 is also recorded by the harness.

## Results

Filled in after the 100-company NDX backfill completes.

## Known limits

- The visible corpus still contains the 24 synthetic fixture companies, which
  can outrank a real profile for broad semantic queries. A fixture-free run is
  the cleanest comparison.
- Chinese descriptions for US companies depend on the model writing the section
  with Chinese aliases; ticker/English-name queries are the primary acceptance
  gate.
- The eval is single-process and not a load test; for latency under concurrency
  use `autocannon` against the API separately.

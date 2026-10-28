# Search Evaluation

> Status: measured on the fixture-isolated NDX-100 corpus · 2026-10-28
> Related: [Data layer & hybrid search](SEARCH.md) · [NDX snapshot](../config/indices/ndx.yaml) · [Golden queries](../scripts/golden-queries.mjs)

## Corpus

The visible corpus used for these numbers contains **real research profiles
only**:

| Layer | Visible | Hidden fixtures |
|---|---:|---:|
| Companies | 102 (100 NDX + 600519/00700) | 14 fixture-only |
| Documents | 102 `company_profile` docs | 31 `fixture://` docs |
| Chunks | 1,428 | 31 |

Synthetic seed data stays in Postgres/Qdrant for pipeline and E2E tests, but
company search, document search, and the exact-match planner all exclude
`is_fixture=true` unless the caller passes `include_fixtures=true`. The numbers
below therefore reflect real backfilled research, not the hand-written fixture
corpus.

## What we measure

`scripts/eval-search.mjs` runs seven query families against the live API and
reports **top-1 accuracy, MRR@10, nDCG@10, recall@5, zero-result rate, and
p50/p95 latency**:

| Family | Examples | Cases |
|---|---|---:|
| Ticker | `AAPL`, `ADBE`, `BRK.B` | 100 (generated) |
| English name | `Analog Devices`, `Automatic Data Processing` | 100 (generated) |
| Typo | `Nvdia`, `Micrsoft`, `Thompson Reuters` | 24 |
| Pinyin | `ywd`, `yingweida`, `gzmt`, `tx` | 16 |
| Natural language | `做 GPU 和 AI 芯片的数据中心公司`, `咖啡连锁店` | 32 |
| Chinese name | `英伟达`, `奈飞`, `好市多` | 16 |
| Documents | `模拟芯片 工业 汽车`, `流媒体 内容 订阅` | 10 |

Ticker/name cases are generated from `config/indices/ndx.yaml`, so the eval
stays in sync with the constituent snapshot. The curated sets live in
[`scripts/golden-queries.mjs`](../scripts/golden-queries.mjs); extend them when
a real query fails. Genuinely ambiguous queries accept any of several expected
tickers (e.g. `半导体制造设备供应商` accepts AMAT/ASML/LRCX/KLAC), and a hit at
rank 1 for any of them counts.

## Method

- Queries hit the real Hono API (`/v1/search/companies`,
  `/v1/search/documents`) with the selected `mode`; rerank stays off so the
  numbers reflect the base hybrid path.
- A company hit matches when any of its tickers equals an expected ticker, or
  its display/legal name contains an expected label.
- A document hit matches when `companyDisplayName` contains the expected company
  name. This is deliberately lenient: document-level relevance is checked by
  reading the returned chunk text, not just the company label.
- **MRR@10** counts only hits inside the top 10. **nDCG@10** uses binary
  relevance with one relevant company per query, so IDCG@10 = 1 and
  nDCG@10 = `1/log2(rank+1)` for a hit inside the cutoff.
- Latency uses `meta.took_ms` (Qdrant + embedding + hydration), reported as
  p50/p95; wall-clock p95 is also recorded by the harness.

```bash
# API + services must be running, and the corpus ingested
node scripts/eval-search.mjs --mode hybrid
node scripts/eval-search.mjs --mode keyword
node scripts/eval-search.mjs --mode semantic
# include the synthetic corpus for comparison
node scripts/eval-search.mjs --mode hybrid --include-fixtures
```

## Results

All numbers are `limit=10`, rerank off, local Postgres + Qdrant 1.18 + BGE-M3,
fixtures hidden.

### Hybrid (default)

| Family | Cases | Top-1 | MRR@10 | nDCG@10 | Recall@5 | Zero | p50 | p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Ticker | 100 | **100%** | 1.000 | 1.000 | 100% | 0% | 178ms | 292ms |
| English name | 100 | **100%** | 1.000 | 1.000 | 100% | 0% | 201ms | 300ms |
| Typo | 24 | **95.8%** | 0.972 | 0.979 | 100% | 0% | 174ms | 233ms |
| Pinyin | 16 | **100%** | 1.000 | 1.000 | 100% | 0% | 178ms | 220ms |
| Natural language | 32 | 78.1% | 0.873 | 0.905 | **100%** | 0% | 236ms | 327ms |
| Chinese name | 16 | 87.5% | 0.891 | 0.914 | 87.5% | 0% | 190ms | 236ms |
| Documents | 10 | 80.0% | 0.900 | 0.926 | **100%** | 0% | 251ms | 317ms |

### Keyword (planner + sparse only)

| Family | Cases | Top-1 | MRR@10 | nDCG@10 | Recall@5 | Zero | p50 | p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Ticker | 100 | 100% | 1.000 | 1.000 | 100% | 0% | 175ms | 227ms |
| English name | 100 | 100% | 1.000 | 1.000 | 100% | 0% | 201ms | 269ms |
| Typo | 24 | 79.2% | 0.792 | 0.792 | 79.2% | **20.8%** | 177ms | 234ms |
| Pinyin | 16 | 100% | 1.000 | 1.000 | 100% | 0% | 168ms | 221ms |
| Natural language | 32 | 78.1% | 0.841 | 0.865 | 93.8% | 0% | 237ms | 330ms |
| Chinese name | 16 | 87.5% | 0.875 | 0.875 | 87.5% | 6.3% | 171ms | 284ms |
| Documents | 10 | 60.0% | 0.743 | 0.805 | 90.0% | 0% | 233ms | 291ms |

### Semantic (dense only)

| Family | Cases | Top-1 | MRR@10 | nDCG@10 | Recall@5 | Zero | p50 | p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Ticker | 100 | 100% | 1.000 | 1.000 | 100% | 0% | 178ms | 279ms |
| English name | 100 | 100% | 1.000 | 1.000 | 100% | 0% | 207ms | 303ms |
| Typo | 24 | 95.8% | 0.972 | 0.979 | 100% | 0% | 182ms | 240ms |
| Pinyin | 16 | 100% | 1.000 | 1.000 | 100% | 0% | 170ms | 286ms |
| Natural language | 32 | 68.8% | 0.818 | 0.864 | 96.9% | 0% | 225ms | 383ms |
| Chinese name | 16 | 87.5% | 0.904 | 0.926 | 93.8% | 0% | 183ms | 222ms |
| Documents | 10 | **90.0%** | 0.911 | 0.930 | 90.0% | 0% | 227ms | 307ms |

### What the numbers mean

- **Acceptance gates met**: ticker and English-name top-1 accuracy remain
  **100%** in all three modes (target ≥ 90%). Exact identifier → alias → fuzzy
  matches still sort ahead of unbounded BM25 scores.
- **Pinyin works because aliases exist, not because of the model.** Derived
  full-pinyin and initials aliases (`英伟达 → ywd`, `腾讯控股 → txkg`) make all
  16 pinyin cases top-1 in every mode. Before the alias backfill these queries
  had no exact path and fell back to fuzzy/semantic retrieval.
- **Typo handling depends on the planner.** Hybrid/semantic reach 95.8% top-1;
  keyword-only drops to 79.2% with a 20.8% zero-result rate. The one remaining
  miss (`Adboe` → ADBE at rank 3) is listed in the known limits.
- **Hybrid is the default for natural language.** It beats dense-only by 9.3
  points of top-1 (78.1% vs 68.8%) and reaches 100% recall@5. Keyword-only is
  level on top-1 (78.1%) but misses semantically paraphrased queries such as
  `在线支付 数字钱包`.
- **Chinese names are the weak spot.** 87.5% top-1: `奈飞` (NFLX) and `好市多`
  (COST) rank 8 because those common Chinese names appear neither as aliases nor
  in the English-titled profile sections. Curated Chinese aliases are the next
  fix.
- **Document search:** semantic-only wins top-1 (90% vs 80%), while hybrid
  reaches 100% recall@5. The hybrid top-1 miss is a same-company section rather
  than a wrong company, so the practical gap is small.
- **Latency:** p95 is 220–383ms (meta `took_ms`), under the 400ms local target
  on the full corpus. These are single-process numbers, not a load test.

## Known limits

- The visible corpus is still NDX-100 plus 600519/00700. A500/HSI/SPX and the
  AI watchlist are not backfilled, so the golden set cannot cover them yet.
- Chinese alias coverage for US companies is incomplete (see `奈飞`/`好市多`
  above). The model writes Chinese section bodies but the snapshot names are
  English, and ingestion only derives aliases from parsed names/tickers.
- Ambiguous natural-language queries use multi-expected sets; this measures
  "did a reasonable company come first", not a unique ground truth.
- The document probes are matched on `companyDisplayName`, which is lenient.
  Reading the returned chunk text is still manual.
- The eval is single-process; for latency under concurrency use `autocannon`
  against the API separately.
- HNSW dense retrieval is approximate, so near-tied semantic cases can move by
  one rank between runs (roughly ±3 points on a 32-case family). The 100-case
  ticker/name and 16-case pinyin families were stable across reruns.

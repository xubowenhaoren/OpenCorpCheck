# Search Evaluation

> Status: measured on the fixture-isolated NDX-100 corpus · 2026-10-28
> (re-run after curated Chinese aliases; `Adboe` typo and `奈飞`/`好市多` fixed)
> Related: [Data layer & hybrid search](SEARCH.md) · [NDX snapshot](../config/indices/ndx.yaml) · [Golden queries](../scripts/golden-queries.mjs) · [Curated aliases](../config/aliases/zh.yaml)

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
| Ticker | 100 | **100%** | 1.000 | 1.000 | 100% | 0% | 182ms | 240ms |
| English name | 100 | **100%** | 1.000 | 1.000 | 100% | 0% | 214ms | 275ms |
| Typo | 24 | **100%** | 1.000 | 1.000 | 100% | 0% | 187ms | 259ms |
| Pinyin | 16 | **100%** | 1.000 | 1.000 | 100% | 0% | 176ms | 234ms |
| Natural language | 32 | 81.3% | 0.880 | 0.910 | 96.9% | 0% | 220ms | 300ms |
| Chinese name | 16 | **100%** | 1.000 | 1.000 | 100% | 0% | 186ms | 218ms |
| Documents | 10 | 80.0% | 0.900 | 0.926 | **100%** | 0% | 326ms | 473ms |

### Keyword (planner + sparse only)

| Family | Cases | Top-1 | MRR@10 | nDCG@10 | Recall@5 | Zero | p50 | p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Ticker | 100 | 100% | 1.000 | 1.000 | 100% | 0% | 168ms | 240ms |
| English name | 100 | 100% | 1.000 | 1.000 | 100% | 0% | 213ms | 296ms |
| Typo | 24 | 83.3% | 0.833 | 0.833 | 83.3% | **16.7%** | 175ms | 220ms |
| Pinyin | 16 | 100% | 1.000 | 1.000 | 100% | 0% | 169ms | 245ms |
| Natural language | 32 | 84.4% | 0.875 | 0.891 | 93.8% | 0% | 209ms | 299ms |
| Chinese name | 16 | 100% | 1.000 | 1.000 | 100% | 0% | 184ms | 241ms |
| Documents | 10 | 50.0% | 0.693 | 0.768 | 90.0% | 0% | 222ms | 286ms |

### Semantic (dense only)

| Family | Cases | Top-1 | MRR@10 | nDCG@10 | Recall@5 | Zero | p50 | p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Ticker | 100 | 100% | 1.000 | 1.000 | 100% | 0% | 175ms | 260ms |
| English name | 100 | 100% | 1.000 | 1.000 | 100% | 0% | 207ms | 269ms |
| Typo | 24 | **100%** | 1.000 | 1.000 | 100% | 0% | 171ms | 206ms |
| Pinyin | 16 | 100% | 1.000 | 1.000 | 100% | 0% | 193ms | 242ms |
| Natural language | 32 | 71.9% | 0.833 | 0.875 | 96.9% | 0% | 224ms | 350ms |
| Chinese name | 16 | 100% | 1.000 | 1.000 | 100% | 0% | 170ms | 265ms |
| Documents | 10 | **90.0%** | 0.911 | 0.930 | 90.0% | 0% | 216ms | 270ms |

### What the numbers mean

- **Acceptance gates met**: ticker and English-name top-1 accuracy remain
  **100%** in all three modes. Exact identifier → alias → fuzzy matches still
  sort ahead of unbounded BM25 scores.
- **Pinyin works because aliases exist, not because of the model.** Derived
  full-pinyin and initials aliases (`英伟达 → ywd`, `腾讯控股 → txkg`) make all
  16 pinyin cases top-1 in every mode.
- **Typo handling depends on the planner.** Hybrid/semantic now reach 100%;
  keyword-only stays at 83.3% with a 16.7% zero-result rate. The vector branch
  recovers misspellings the sparse branch cannot.
- **Hybrid is the default for natural language.** It beats dense-only by 9.4
  points of top-1 (81.3% vs 71.9%) and reaches 96.9% recall@5. Keyword-only is
  slightly better on top-1 (84.4%) but misses paraphrases such as
  `在线支付 数字钱包`.
- **Chinese names are fixed.** Curated aliases in
  [`config/aliases/zh.yaml`](../config/aliases/zh.yaml) plus
  `occ aliases sync` make the whole `zh-name` family top-1 in every mode,
  including `奈飞` (NFLX) and `好市多` (COST).
- **Document search:** semantic-only still wins top-1 (90% vs 80%), while hybrid
  reaches 100% recall@5. The hybrid top-1 miss is a same-company section rather
  than a wrong company, so the practical gap is small.
- **Latency:** company families are 218–300ms p95; document search measured
  366–473ms across runs. The 400ms local target is met on most runs but not
  consistently on this macOS VM while Postgres/Qdrant/BGE-M3/MinIO are all
  resident. These are single-process numbers, not a load test.

## Known limits

- The visible corpus is still NDX-100 plus 600519/00700. A500/HSI/SPX and the
  AI watchlist are not backfilled, so the golden set cannot cover them yet.
- Curated Chinese aliases are hand-maintained. Add a ticker to
  `config/aliases/zh.yaml`, run `occ aliases sync`, and company points are
  re-indexed automatically; forgetting that step leaves Qdrant behind Postgres
  for semantic recall (exact alias lookup still works).
- Ambiguous natural-language queries use multi-expected sets; this measures
  "did a reasonable company come first", not a unique ground truth. Six
  natural-language probes still rank the right company at 2–6, including
  `独立站 电商 SaaS` (SHOP at 6).
- The document probes are matched on `companyDisplayName`, which is lenient.
  Reading the returned chunk text is still manual.
- The eval is single-process; for latency under concurrency use `autocannon`
  against the API separately.
- HNSW dense retrieval is approximate, so near-tied semantic cases can move by
  one rank between runs (roughly ±3 points on a 32-case family). The 100-case
  ticker/name and 16-case pinyin/zh-name families were stable across reruns.
- Latency varies with the other local services; document-search p95 crossed
  400ms in one of three runs on this VM.

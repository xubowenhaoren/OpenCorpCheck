# @occ/worker — parallel backfill

Postgres + [pg-boss](https://github.com/timgit/pg-boss) worker that turns company
research and F10 crawls into independent, retryable, resumable jobs. It replaces
the Phase 0 pattern of running companies one at a time in one process.

## Model

| Queue | Job | Handler |
|---|---|---|
| `research.company` | one company → one dsh headless turn | [jobs/research.ts](src/jobs/research.ts) |
| `ingest.company` | one finished section → documents/chunks + Qdrant | [jobs/ingest.ts](src/jobs/ingest.ts) |
| `news.company` | one company → Google News RSS → `doc_type='news'` documents | [jobs/news.ts](src/jobs/news.ts) |
| `f10.page` | one company × one F10 page | [jobs/f10.ts](src/jobs/f10.ts) |
| `*.dead` | exhausted jobs | marks the DB row `dead` |

- **Granularity**: research is one job per company; F10 is one job per page, so a
  failed page retries without re-crawling the company. Ingestion is one job per
  company, enqueued automatically when a research section is written (including
  cache hits). Use `--no-ingest` to disable it for a run.
- **Extraction after ingest**: a successful ingest (including an unchanged
  `skipped` section) also runs deterministic financial/fact extraction from the
  section markdown. Failures are logged as `extract_failed` and never fail the
  ingest job. LLM relation extraction is opt-in with `OCC_EXTRACT_RELATIONS=llm`
  (default `none`, so bulk backfills do not spend tokens silently).
- **Concurrency**: pg-boss `localConcurrency` — research defaults to 4, ingest to
  4, F10 to 4, news to 2 (`OCC_RESEARCH_CONCURRENCY`, `OCC_INGEST_CONCURRENCY`,
  `OCC_F10_CONCURRENCY`, `OCC_NEWS_CONCURRENCY`). The sidecar still caps Playwright
  at 2 pages globally and 5 req/s per domain, so F10 jobs queue behind that limit
  instead of hammering Eastmoney. News makes one polite RSS request per company.
- **Retries**: research 2 retries (30s exponential backoff, 10m cap); F10 3
  retries (15s base, 5m cap). Exhausted jobs move to a dead-letter queue and the
  DB records `dead` + the last error.
- **Checkpoint / resume**: `backfill_runs` + `backfill_jobs` hold per-job state.
  Completed jobs are skipped on rerun; pg-boss persists queued/retry jobs across
  worker restarts. Research also has a content cache: `research_cache` stores the
  prompt hash (prompt + date + model + skill + patches) and section SHA-256, so a
  rerun with identical inputs makes no LLM call.
- **Priority / sharding**: AI watchlist 100, MAG7 60, explicit 50; financial
  pages get a small boost. `--shard 0/4` splits targets by `sha256(key) % N` so
  several worker processes can share the load.
- **Idempotency**: `UNIQUE (run_id, queue, job_key)` plus pg-boss `singletonKey`
  per run; F10 rows are upserted by `(market, code, page)`; sections are written
  atomically (tmp + rename).
- **Observability**: every job logs one JSON line (duration, tokens, error,
  retry count) to stderr; `status --run` reports counts, p50/p95/avg duration and
  dead jobs; queue depth comes from pg-boss's job table (not its 60s cache).

## Setup

Requires Node 24, pnpm (corepack), PostgreSQL 17, and — for F10 — the
[finance-analyst sidecar](../finance-analyst/README.md).

```bash
# 1. local Postgres (project-local cluster, gitignored)
brew install postgresql@17
scripts/dev-db.sh init          # first time only
scripts/dev-db.sh start         # prints DATABASE_URL

# 2. build and migrate
corepack pnpm -r build
node apps/worker/dist/cli.js migrate

# 3. sidecar, for F10 jobs
cd services/finance-analyst && uv run occ-f10 serve --port 8090
```

Environment:

| Env | Default |
|---|---|
| `DATABASE_URL` | `postgres://occ@127.0.0.1:5432/occdb` |
| `OCC_RESEARCH_CONCURRENCY` | `4` |
| `OCC_INGEST_CONCURRENCY` | `4` |
| `OCC_F10_CONCURRENCY` | `4` |
| `OCC_NEWS_CONCURRENCY` | `2` |
| `OCC_FINANCE_ANALYST_URL` | `http://127.0.0.1:8090` |
| `OCC_QDRANT_URL` | `http://127.0.0.1:6333` |
| `OCC_EMBEDDING_URL` | `http://127.0.0.1:8080` |
| `OCC_DSH_HOME` | `phase0/.dsh-home` |
| `OCC_RUNS_DIR` | `.occ/runs` |
| `OCC_WORKER_SECTIONS_DIR` | `.occ/sections` (falls back to `OCC_SECTIONS_DIR`) |
| `OCC_RESEARCH_MODEL` | `deepseek-flash` |
| `DEEPSEEK_API_KEY` | required for live research |
| `OCC_S3_ENDPOINT` / `OCC_S3_BUCKET` | unset → snapshots disabled |
| `OCC_S3_ACCESS_KEY` / `OCC_S3_SECRET_KEY` | required when the store is enabled |
| `OCC_S3_REGION` / `OCC_S3_PREFIX` | `us-east-1` / none |

Worker output goes under `.occ/` (gitignored) so a backfill can never overwrite
the committed Phase 0 corpus in `phase0/`. If you still point
`OCC_SECTIONS_DIR` at `phase0/out/sections`, that value is honoured for
compatibility, but new runs write to `.occ/sections` by default.

## Usage

```bash
# research: MAG7, 4 at a time
node apps/worker/dist/cli.js enqueue research --universe mag7
node apps/worker/dist/cli.js work --queues research --drain

# research + ingest: NASDAQ-100 snapshot, 4 companies in parallel
node apps/worker/dist/cli.js enqueue research --universe ndx --limit 5
node apps/worker/dist/cli.js work --queues research,ingest --drain

# research: A/HK companies with the F10 data layer attached (sidecar must be up)
node apps/worker/dist/cli.js enqueue research --tickers 600519:A,00700:HK --include-f10
node apps/worker/dist/cli.js work --queues research,ingest --drain

# research without an API key (fixture sections; exercises the queue)
node apps/worker/dist/cli.js enqueue research --tickers AAPL,MSFT --mock
node apps/worker/dist/cli.js work --queues research --drain

# ingest mock sections too (local pipeline test; do not mix into real search data)
node apps/worker/dist/cli.js enqueue research --tickers AAPL --mock --ingest-mock

# F10: 600519 preset default, or an explicit page list
node apps/worker/dist/cli.js enqueue f10 --tickers 600519:A --preset default
node apps/worker/dist/cli.js enqueue f10 --tickers AAPL:US --pages cwfx,gsgk
node apps/worker/dist/cli.js work --queues f10 --drain

# news: Google News RSS → news documents (company must already be ingested)
node apps/worker/dist/cli.js enqueue news --tickers AAPL --max-items 10 --since-days 30
node apps/worker/dist/cli.js work --queues news --drain

# operations
node apps/worker/dist/cli.js status
node apps/worker/dist/cli.js status --run <uuid> --json
node apps/worker/dist/cli.js status --run <uuid> --json --out phase0/out/backfill-summary.json
node apps/worker/dist/cli.js targets --universe mag7
```

`--drain` exits when every queue is empty (useful for CI and one-shot
backfills); without it the worker stays up and polls. `--force` ignores both the
completed checkpoint and the research cache.

## Tables

- `backfill_runs` — one row per enqueue: kind, status, totals, options.
- `backfill_jobs` — per company/page: status, attempts, duration, last error.
- `research_cache` — company → prompt hash, section hash, tokens.
- `f10_pages` — latest snapshot per `(market, code, page)`: HTTP status, text
  length, table count, `html_sha256`, `storage_key`, warnings. With `OCC_S3_*`
  configured, `storage_key` is an `s3://` URI pointing at the structured page
  JSON snapshot; the sidecar does not yet return raw HTML bytes.

pg-boss owns its own `pgboss` schema.

## Verified (2026-10-28, local)

| Scenario | Result |
|---|---|
| F10 AAPL `minimal` | 2/2 pages, ~14s each, `f10_pages` upserted |
| Research mock ×2 | second run: both jobs `cache_hit`, no work |
| Live research AAPL + MSFT, concurrency 4 | wall **147s** vs ~273s serial; 2/2 completed |
| Live A/HK research 600519 + 00700, `--include-f10` | 2/2 completed (202s / 219s, wall 221s); full names resolved, 13 sections, F10 cited with `fetched_at` |
| NDX pilot AAPL/ABNB/ADBE/ADI/ADP, research + ingest, concurrency 4 | 5/5 research + 5/5 ingest, wall **281s**; research p50 131s / p95 234s, ingest p50 13s; 285k input / 78k output tokens; 70 chunks indexed, 0 retries |
| NDX full backfill, 100 companies, research 6 / ingest 4 | **200/200 jobs** (100 research + 100 ingest), wall **~42 min**; research p50 143s / p95 221s, ingest p50 15s; 4.94M input / 1.57M output tokens; 1,428 chunks; 0 failures / 0 dead letters |
| `occ ingest` rerun | unchanged sections skipped without embeddings; `--force` reindexes |
| Sidecar down | 4 attempts over ~151s → dead-letter; run `failed`, error recorded |

## Skill selection

Research prompts are market-aware: MAG7-universe targets load the tuned
`mag7-profile` skill; everything else (A-share, HK, US non-MAG7, AI watchlist)
loads `.dsh/skills/company-profile`, which carries per-market source
hierarchies (CNINFO / HKEXnews as citation truth, F10 as the secondary data
layer) and F10 cross-check discipline. The `research_cache` prompt hash includes
the skill file, so switching skills invalidates cached sections. Pass
`--include-f10` on A/HK runs to attach the F10 MCP tools to dsh (the sidecar
must be running, or dsh startup fails).

## Known limits

- `config/universe.yaml` covers the AI watchlist; `config/indices/ndx.yaml` is
  the NASDAQ-100 constituent snapshot (100 primary listings, official Nasdaq
  source, `as_of` recorded). STAR 50 (`000688`) / ChiNext 50 (`399673`) / HSI
  snapshots are still P4; S&P 500 was cancelled on 2026-10-29.
- Live queue counts query `pgboss.job` directly, assuming the default schema.
- Token/cost is logged per job but not summed per run.
- Snapshots: ingest uploads each section to `sections/<slug>/<sha256>.md`;
  `f10.page` jobs upload `f10/<market>/<code>/<page>/<sha>.json`. Both are
  no-ops unless `OCC_S3_ENDPOINT`/`OCC_S3_BUCKET` are set. Raw F10 HTML capture
  remains a sidecar follow-up (`F10_SNAPSHOT_DIR` writes local files today).
- Ingest writes section markdown to `documents`/`chunks`; it does not yet
  extract facts/products/relations or upload raw snapshots.

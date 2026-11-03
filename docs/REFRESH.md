# Daily company-data / filing refresh (P1.5)

> Status: implemented 2026-11-03 · Related: [FILINGS](FILINGS.md),
> [NEWS](NEWS.md), [EXTRACT](EXTRACT.md), [OWNERSHIP](OWNERSHIP.md),
> [CONTEXT_TRANSFER](../CONTEXT_TRANSFER.md) §10

## 1. Goal

Keep every researched company's filing and structured-financial state fresh
without an operator running `occ filings sync` / `enqueue financials` by hand:

- check each company's official filing index **once a day**;
- a **new** periodic report (10-K/10-Q/20-F/40-F, annual/interim/quarterly
  report) triggers the deterministic `financials.company` pipeline;
- a **new** announcement is ingested as a P1.4 filing document (`ingest.filing`);
- the company page shows the latest report line and the last check time;
- unchanged days do no writes and spend **0 LLM tokens**.

This is pure code. The optional LLM fallback for discovery/conflicts remains a
P2 idea and is **not** part of P1.5.

## 2. Architecture

```text
data.sweep (daily cron / occ-refresh sweep --now; advisory-locked singleton)
  → plan due (company, source) pairs from securities + identifiers
  → lease company_filing_state rows (claim timeout)
  → create a backfill_runs(kind='data') row + one data.source.check per pair
data.source.check (concurrency 4)
  → EDGAR submissions / CNINFO announcements / HKEXnews titles
  → insert only unseen (source, accession) rows into `filings`
  → enqueue ingest.filing for announcements (P1.4 document layer)
  → enqueue financials.company(force data fetch, bypassCache) for a new
    periodic report
  → stamp cursor / next_due_at / status
ingest.filing (concurrency 2)
  → build FilingItems from `filings` rows
  → ingestFilings(...) → documents/chunks/Qdrant (same shape as P1.4)
  → mark rows applied/failed
financials.company (existing pipeline)
  → EDGAR companyfacts for US; F10 cwfx/NewFinancialAnalysis for A/HK
  → upsert financial_facts; the company page shows the new period
```

The TaskDock stays **news-only** (decision 33). The filing refresh is visible
on the company page, not as a second dock producer.

## 3. Data model

Migration `0011_filing_refresh.sql`.

### `company_filing_state` — one row per (company, source)

| Column | Meaning |
|---|---|
| `company_id`, `source` | primary key; source is `edgar` / `cninfo` / `hkexnews` / `f10` |
| `market`, `code` | market + adapter code (CIK-backed ticker, numeric ticker) |
| `cursor` | newest external id seen, or the F10 content hash |
| `last_checked_at` | last successful check (including a valid empty window) |
| `last_changed_at` | last check that inserted a new filing |
| `last_status` | `never` / `ok` / `changed` / `empty` / `failed` / `paused` |
| `last_error` | last adapter error (truncated) |
| `consecutive_failures` | reset on success; paused after `OCC_DATA_PAUSE_AFTER` |
| `last_enqueued_at`, `next_due_at` | lease while claimed, then schedule |

It is **state, not a registry**: the sweep derives candidates from
`companies` + `securities` + `company_ids` and merges this table in. A company
with no row is immediately due. Fixtures and `coverage_tier='stub'` rows never
participate.

### `filings` — deterministic detection inbox

| Column | Meaning |
|---|---|
| `id` | `fil_<sha256(source + accession)[:24]>` |
| `company_id`, `source`, `accession` | identity; unique `(source, accession)` |
| `title`, `form`, `category` | announcement metadata |
| `filed_at`, `period_end` | source dates |
| `periodic`, `period_kind` | `annual` / `half` / `quarter` when unambiguous |
| `url`, `pdf_url` | where the document lives |
| `content_hash` | document sha256 after ingestion |
| `status` | `detected` / `applied` / `failed` (the P1.4 lifecycle names are kept) |
| `metadata` | source provenance + `{baseline, language, trustTier, periodKind}` |
| `first_seen_at`, `detected_at`, `processed_at` | audit timestamps |

`filings` is **not** the user-facing document store. `ingest.filing` writes
`documents(doc_type='filing')` exactly as P1.4 does; the 公告文件 tab still reads
documents. Keeping the inbox separate lets the daily diff use
`(source, accession)` without touching user documents.

## 4. Source selection

`candidatesForCompany` (`apps/worker/src/data/plan.ts`) is pure and tested:

| Condition | Source | Notes |
|---|---|---|
| US exchange listing + SEC CIK | `edgar` | CIK required; ticker from the US security |
| SSE/SZSE listing | `cninfo` | CNINFO covers both boards |
| HKEX listing | `hkexnews` | numeric 5-digit stock id |
| A/HK listing with no usable official feed (e.g. BSE-only) | `f10` | `cwfx` / `NewFinancialAnalysis` content-hash fallback |

A dual-listed A/HK company gets **two** checks (e.g. `HK:02318` → cninfo +
hkexnews). A US company without a CIK is not polled (EDGAR cannot resolve it).
Current corpus: **236 researched companies → 251 checks** (100 EDGAR,
66 CNINFO, 85 HKEXnews; 0 F10 fallback).

## 5. Detection and cadence

- **Window:** cold start = `OCC_DATA_COLD_DAYS` (30) days. Steady state =
  `ceil(hours since last check / 24) + 2` days, capped at
  `OCC_DATA_MAX_STEADY_DAYS` (30), so a long worker outage still re-reads a
  bounded index.
- **Diff:** only `(source, accession)` pairs absent from `filings` are new.
  `INSERT ... ON CONFLICT DO NOTHING RETURNING` is the diff; a rerun inserts 0.
- **Periodic classification** is deterministic (`@occ/sources-filings`
  `periodic.ts`):
  - EDGAR: `10-K`, `20-F`, `40-F` (annual), `10-Q` (quarter); amendment
    suffixes (`/A`) inherit the base form. `8-K`/`6-K` are announcements, not
    periodic reports.
  - CNINFO: a title containing 年度报告/半年报/季度报告 etc., excluding
    摘要/英文版/业绩说明会/业绩预告/快报/问询/停牌/澄清.
  - HKEXnews: annual/interim/quarterly results or reports in the title/
    category, excluding board-meeting dates, profit warnings, monthly returns,
    clarification/suspension notices.
- **Cold baseline:** the first successful check records what already exists
  without ingesting a historical backlog or re-running financials for the whole
  universe. The exception is a **recent periodic report** (filed within
  `OCC_DATA_COLD_DAYS`): it is ingested and triggers one financials run, so a
  deployment catches a just-filed 10-K/10-Q. Other backlog rows are inserted as
  `applied` with `metadata.baseline=true`.
- **Steady state:** every new filing is ingested; any new periodic report also
  enqueues `financials.company` with `bypassCache: true` (fresh EDGAR/F10
  fetch). `force` stays false so a check retry cannot re-run a completed
  financials job.

### Why `bypassCache`

EDGAR `companyfacts`/`submissions` and F10 snapshots are cached for 24 h. A
daily check can detect a new 10-Q while the financials job would still read
yesterday's cache. `financials.company` therefore accepts `bypassCache` —
it forces the upstream fetch and the extraction hash check, while the normal
`force` flag (operator) remains the only thing that bypasses the
completed-job guard.

## 6. Scheduling, retries and concurrency

- `data.sweep` queue policy `short` (one queued producer), pg-boss schedule
  `data-sweep`, cron `OCC_DATA_SWEEP_CRON` (default `0 8 * * *`) in
  `OCC_DATA_SWEEP_TZ`. `missed: "once"` sends one catch-up sweep after downtime.
- The handler takes `pg_try_advisory_lock(hashtext('occ:data:sweep'))`; a second
  producer is a no-op.
- Each check is leased (`OCC_DATA_CLAIM_TIMEOUT_MS`, 30 min). A worker crash
  leaves the lease; the next sweep re-selects the row after it expires.
- Success: `last_checked_at = now()`, `next_due_at = now() + OCC_DATA_TTL_MS`
  (23 h, deliberately shorter than the daily period), failures reset.
- Failure: never advances `last_checked_at`; increments failures; backs off
  `min(15 min × 2^n, TTL)`; after `OCC_DATA_PAUSE_AFTER` (5) sets `paused` for
  one TTL.
- `data.source.check` runs `OCC_DATA_CONCURRENCY` (4) in parallel;
  `ingest.filing` runs `OCC_FILINGS_CONCURRENCY` (2) because PDF extraction is
  heavy. Keep the F10 sidecar's browser concurrency at 2.
- Run the `financials` queue in **one process per host**: the EDGAR 110 ms
  limiter is per process, so a second financials worker doubles the SEC request
  rate. `scripts/dev-data-worker.sh` (`data,financials`) is that process; do
  not also start a full worker with `financials` on the same host unless the
  data worker is stopped.
- EDGAR requests stay on the existing 110 ms global limiter; HKEXnews searches
  remain 1 request/second in the sidecar.

## 7. Company page / API

`GET /v1/companies/:ref?include=filings` now returns `filingRefresh`:

```json
{
  "latest": { "source": "edgar", "form": "10-K", "periodEnd": "2026-09-26",
              "filedAt": "2026-11-03T13:05:15.000Z", "status": "applied",
              "title": "10-K", "url": "https://www.sec.gov/..." },
  "latestAny": { "...": "..." },
  "lastCheckedAt": "2026-11-03T22:36:42.372Z",
  "lastStatus": "changed",
  "pending": false,
  "consecutiveFailures": 0,
  "sources": [
    { "source": "edgar", "market": "US", "lastStatus": "changed",
      "lastCheckedAt": "...", "lastChangedAt": "...", "nextDueAt": "..." }
  ]
}
```

- The 公告文件 tab shows `最新报告 2026-09-26 (10-K) · 财报更新于 …`; while a
  check is queued/active it shows `披露检查排队中…`; after a failure it shows
  `披露检查失败，将自动重试（连续 N 次）` in the warning colour.
- The 财务数据 coverage line adds `财报更新于 <date>` when a latest periodic
  filing exists.
- `pending` comes from queued/active/retrying `data.source.check` and follow-up
  rows (`ingest.filing` / `financials.company`) in `backfill_jobs`; a failed
  source state renders `重试中` even while a retry is queued. The page polls
  every 15 s while pending.
- A dead-lettered follow-up job is visible in `backfill_jobs` and the worker
  log; `filingRefresh` reflects the source check, not downstream job death.
- The TaskDock is unchanged (news-only, decision 33).

## 8. Commands

```bash
# schema (run after pulling migrations; P1.5 adds 0011)
node apps/cli/dist/occ.js migrate

# automatic worker (keep running; no Docker)
scripts/dev-data-worker.sh start     # status | stop | restart | logs
#   == node apps/worker/dist/cli.js work --queues data,financials

# observe cursors and recent data runs
node apps/worker/dist/refresh-cli.js status
#   or: node apps/worker/dist/cli.js data status

# force one sweep (still advisory-locked; leases the same cursor rows)
node apps/worker/dist/refresh-cli.js sweep --now
node apps/worker/dist/refresh-cli.js sweep --now --limit 2 --source edgar
node apps/worker/dist/refresh-cli.js sweep --now --company AAPL --source edgar
#   --source edgar,cninfo,hkexnews,f10
#   or via occ-backfill: node apps/worker/dist/cli.js data sweep --now

# the P1.4 operator path is unchanged
node apps/cli/dist/occ.js filings sync --market US --company AAPL --days 90
```

The data worker needs the F10/PDF/HKEXnews sidecar for A/HK PDFs and
HKEXnews checks:

```bash
cd services/finance-analyst && uv run occ-f10 serve --port 8090
```

Without it, US/A checks still run; HK checks fail honestly and back off. The
company page shows `重试中` rather than fake success.

## 9. Environment

| Env | Default |
|---|---|
| `OCC_DATA_SWEEP` | on; `none`/`off` disables the automatic sweep |
| `OCC_DATA_SWEEP_CRON` / `_TZ` | `0 8 * * *` / machine timezone |
| `OCC_DATA_TTL_MS` | `82800000` (23 h; shorter than the daily period) |
| `OCC_DATA_CLAIM_TIMEOUT_MS` | `1800000` (30 min lease) |
| `OCC_DATA_SWEEP_BATCH` | `500` (checks per sweep) |
| `OCC_DATA_HISTORY_MS` | `259200000` (3 days of data-run history) |
| `OCC_DATA_PAUSE_AFTER` | `5` consecutive failures → `paused` |
| `OCC_DATA_CONCURRENCY` | `4` |
| `OCC_DATA_COLD_DAYS` | `30` |
| `OCC_DATA_MAX_STEADY_DAYS` | `30` (lookback cap after an outage) |
| `OCC_DATA_MAX_ITEMS` | `20` discovered/ingested filings per source per check |
| `OCC_FILINGS_CONCURRENCY` | `2` |
| `OCC_FILINGS_FULL_TEXT` | off; `1`/`on` follows EDGAR HTML in the automatic path |
| `OCC_FILINGS_MAX_PAGES` | `80` |
| `OCC_FILINGS_DIR` | `.occ/filings` (shared with the P1.4 CLI cache) |
| `OCC_EDGAR_DIR` / `OCC_EDGAR_USER_AGENT` | shared with financials/ownership |
| `OCC_FINANCE_ANALYST_URL` | `http://127.0.0.1:8090` |

## 10. Live verification (2026-11-03)

- Migration `0011_filing_refresh.sql` applied.
- Planned coverage: **236 researched companies → 251 checks** (100 `edgar`,
  66 `cninfo`, 85 `hkexnews`; 850 stubs excluded).
- Cold EDGAR sample (`--limit 2`, AAPL + MSFT):
  - AAPL's new **10-K** (period 2026-09-26, filed 2026-11-03) and MSFT's
    **10-Q** (filed 2026-10-28) were detected as recent periodic reports.
  - `ingest.filing` wrote 1 link-only document + 1 chunk each (Qdrant indexed).
  - `financials.company` ran with `bypassCache` and wrote **340 EDGAR facts**
    each; AAPL's latest structured period is now `2026-09-26` (FY2026 revenue
    **478.834B USD**, FY2025 416.161B).
  - `filingRefresh` on `/v1/companies/AAPL` returned the 10-K, `lastStatus
    = changed`, and `pending=false`; the 公告文件 tab sees 3 documents.
- Steady rerun for AAPL: `discovered=2, inserted=0, enqueuedFilings=0,
  enqueuedFinancials=0`; 3-day window after a check 1 minute earlier.
- Failure path: an HKEXnews check with the sidecar down returned
  `last_status=failed`, `consecutive_failures=1`, `next_due_at` +15 min, and
  the company card showed `lastStatus=failed` (UI would render `重试中`).
- All runs report **0 LLM tokens**; no LLM call is on the path.

## 11. Known limits

- **Baseline, not backfill:** the first check does not ingest historical
  announcements. Only recent periodic reports are acted on. A full historical
  filing corpus remains an explicit operator batch (P1.4 `occ filings sync`).
- **EDGAR recent window only:** `submissions.filings.recent` is used; older
  paginated `filings.files` are not followed. The daily window is at most 30
  days, so this is sufficient for incremental checks.
- **CNINFO `orgId` is resolved per check** (two requests per A company). It is
  not persisted; a P1.4 follow-up can store `cninfo_org` in `company_ids`.
- **HKEXnews requires the sidecar** and one Playwright page load per company;
  the first result page is used. Pagination/load-more is not followed.
- **No OCR:** scanned PDFs remain link-only. PDFs are capped (30 MB / 80 pages
  / 20k chars per page).
- **F10 fallback is rare:** it is selected only when no official feed exists
  (e.g. BSE-only). It hashes the `cwfx` page content; it is not a filing list.
- **Dead-lettered filing ingestion** leaves its `filings` rows `failed`. Inspect
  `backfill_jobs` / the worker log; rerunning the same company/source after the
  cause is fixed reuses the rows only if they are re-detected or the operator
  runs `occ filings sync`. The rows are internal, so no user document is
  silently lost.
- **The TaskDock remains news-only.** A "财报更新" dock group would be an
  explicit decision-33 change.
- **The data worker must be running** for the cron/lazy follow-ups. With no
  worker, `data.source.check` / `ingest.filing` jobs stay queued and the page
  shows `排队中`.

## 12. Tests

- `packages/sources/filings`: 25 tests (periodic EDGAR/CNINFO/HKEXnews
  classification, content loader link-only/HTML).
- `apps/worker`: 52 tests (source planning, due/lease filtering, cold/steady
  window; existing research/reviewer/universe tests).
- `packages/db`: 11 tests (run store, companies, deterministic filing id).
- `apps/web`: 48 tests (filing status branches).
- Full serial suite: **363 TypeScript tests** green;
  `corepack pnpm -r --workspace-concurrency=1 test`.
- Python sidecar unchanged at 30 tests.

# Daily company-data / filing refresh (P1.5)

> Status: implemented 2026-11-03; follow-ups **financials verification/retry**
> and the **shared TaskDock** shipped 2026-11-03 · Related:
> [FILINGS](FILINGS.md), [NEWS](NEWS.md), [EXTRACT](EXTRACT.md),
> [OWNERSHIP](OWNERSHIP.md), [ROADMAP](ROADMAP.md)

## 1. Goal

Keep every researched company's filing and structured-financial state fresh
without an operator running `occ filings sync` / `enqueue financials` by hand:

- check each company's official filing index **once a day**;
- a **new** periodic report (10-K/10-Q/20-F/40-F, annual/interim/quarterly
  report) triggers the deterministic `financials.company` pipeline;
- a **new** announcement is ingested as a P1.4 filing document (`ingest.filing`);
- **verify that the expected period actually landed** in structured
  financials; while A/HK F10 lags, keep the company `pending` and retry on a
  bounded 1h/6h/1d schedule instead of treating the one-shot run as success;
- the company page and the top-nav TaskDock show the latest report line, the
  check time and whether financials are still pending;
- unchanged days do no writes and spend **0 LLM tokens**.

This is pure code. The optional LLM fallback for discovery/conflicts remains a
P2 idea and is **not** part of P1.5.

## 2. Architecture

```text
data.sweep (daily cron / occ-refresh sweep --now; advisory-locked singleton)
  → plan due (company, source) pairs from securities + identifiers
  → lease company_filing_state rows (claim timeout)
  → lease due pending `financials_refresh_state` rows (catch-up pass)
  → create a backfill_runs(kind='data') row + one job per unit:
      data.source.check (concurrency 4) and financials.company (catch-up)
data.source.check
  → EDGAR submissions / CNINFO announcements / HKEXnews titles
  → insert only unseen (source, accession) rows into `filings`
  → derive the expected statement period and upsert financials_refresh_state
  → enqueue ingest.filing for announcements (P1.4 document layer)
  → lease the financials state, then enqueue financials.company
    (bypassCache) for a new periodic report — only once per company per run
  → stamp cursor / next_due_at / status
ingest.filing (concurrency 2)
  → build FilingItems from `filings` rows
  → ingestFilings(...) → documents/chunks/Qdrant (same shape as P1.4)
  → mark rows applied/failed
financials.company (existing pipeline)
  → EDGAR companyfacts for US; F10 cwfx/NewFinancialAnalysis for A/HK
  → upsert financial_facts
  → verify max(financial_facts.period_end) against the expected period
  → applied, or pending with backoff, or failed after OCC_DATA_FIN_RETRY_MAX_DAYS
```

The **TaskDock is shared** (2026-11-03 decision 33): `更新新闻` and
`财报更新` are two automatic producers in one top-right dock, with
`全部 / 更新新闻 / 财报更新` filters and per-company subtasks. There is still
no manual refresh control (decision 34).

## 3. Data model

Migrations `0011_filing_refresh.sql` and `0012_financials_verification.sql`.

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

### `financials_refresh_state` — one row per company

| Column | Meaning |
|---|---|
| `company_id` | primary key; the expected period is a company-level fact |
| `expected_period_end` | `YYYY-MM-DD` the newest periodic report should add |
| `market`, `ticker`, `code`, `name`, `source`, `filing_id` | how to run the catch-up financials job and label it in the dock |
| `status` | `pending` / `applied` / `failed` |
| `attempts` | verification attempts that did not cover the period |
| `next_retry_at` | retry schedule, and a lease while a catch-up is queued |
| `first_seen_at` | bounded retry window start (`OCC_DATA_FIN_RETRY_MAX_DAYS`) |
| `last_error` | last verification/fetch error (truncated) |

`expected_period_end` is derived deterministically
(`@occ/sources-filings` `expected-period.ts`):

1. adapter `periodEnd` (EDGAR `reportDate`);
2. an explicit title date (`... ended 30 June 2026`, `截至2025年12月31日止年度`);
3. a CNINFO title with a year + quarter/half/year (`2026年第三季度报告`);
4. a bounded fallback from the period kind and filing date (A/HK issuers are
   mostly December year-end).

The period is also written to `filings.period_end`, so the company page and the
dock can show `2026-09-30` even when the source publishes only a title.

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
Current corpus: **286 researched companies → 301 checks** (100 EDGAR,
116 CNINFO, 85 HKEXnews; 0 F10 fallback).

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

### Financials verification (P1.5 follow-up)

A periodic report can arrive days before F10 publishes the structured
statements. The one-shot run used to finish "successfully" without the new
period, and nothing re-triggered it because the accession was already consumed.

- When a periodic report is detected, the expected period is stored in
  `financials_refresh_state` (`pending`).
- After every `financials.company` run, the worker reads
  `max(financial_facts.period_end)` **for structured methods only**
  (`xbrl`/`f10`; profile-derived rows are ignored) and compares it with the
  expected period. A 7-day tolerance covers 52/53-week fiscal years (Apple's
  10-K ends `2026-09-26` for a `2026-09-30` expectation) without accepting the
  previous quarter.
- Covered → `applied`; not covered → `pending` with `attempts + 1` and the
  next retry; after `OCC_DATA_FIN_RETRY_MAX_DAYS` (7) → `failed`. The job row
  records `meta.financialsStatus`, so the dock can say `财报待更新` instead of
  `已完成`.
- The daily `data.sweep` has a **catch-up pass**: due `pending` rows are
  leased and enqueued as `financials.company` in the same data run. It does
  not re-fetch the filing index or re-ingest the document.
- The check leases the state before enqueuing its own financials job. If a
  catch-up already leased it in that sweep, the check does not enqueue a
  second pg-boss job for the same period (both could otherwise be active
  before either marks the run row completed).

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
- **Financials retry:** 1 h after the first miss, then 6 h, then daily. The
  window is `OCC_DATA_FIN_RETRY_MAX_DAYS` (7) from `first_seen_at`; a next retry
  that would land past the deadline marks the row `failed` instead. A
  `financials.company` failure also schedules the same backoff, so a temporary
  F10/sidecar error is retried by the next sweep even if pg-boss is done.
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
  ],
  "financials": {
    "expectedPeriodEnd": "2026-09-30", "status": "pending", "attempts": 1,
    "source": "hkexnews", "nextRetryAt": "2026-11-04T00:29:36.478Z"
  }
}
```

- The 公告文件 tab shows `最新报告 2026-09-26 (10-K) · 财报更新于 …`; while a
  check is queued/active it shows `披露检查排队中…`; after a source failure it
  shows `披露检查失败，将自动重试（连续 N 次）` in the warning colour.
- While `financials.status = pending`, the 公告文件 tab shows
  `财报更新中 — 等待 <period> 结构化财报` (and `财报更新失败 …` after the
  bounded window) instead of claiming the financials were updated. The
  财务数据 coverage line adds `财报更新于 <date>` when a latest periodic
  filing exists.
- `pending` comes from queued/active/retrying `data.source.check` and follow-up
  rows (`ingest.filing` / `financials.company`) in `backfill_jobs`; a failed
  source state renders `重试中` even while a retry is queued. The page polls
  every 15 s while pending.
- A dead-lettered follow-up job is visible in `backfill_jobs` and the worker
  log; `filingRefresh` reflects the source check, not downstream job death.
- **Shared TaskDock (shipped 2026-11-03):** `GET /v1/news/status` returns a
  `dataRefresh` block (`active`, `lastRun`, `runs[20]`, `dueChecks`,
  `pendingFinancials`, `dueFinancials`, `appliedFinancials`,
  `failedFinancials`, `nextDueAt`, `nextRetryAt`, `pendingSweep`). Run details
  and per-company subtasks still come from `GET /v1/runs/:id`. The dock has
  `全部 / 更新新闻 / 财报更新` filters; there is still no `POST
  /v1/news/refresh`, no page-entry nudge and no manual control (decision 34).

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
| `OCC_DATA_FIN_RETRY_MAX_DAYS` | `7` days to wait for a lagging A/HK F10 period |
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

### Follow-up acceptance (2026-11-03)

- Migration `0012_financials_verification.sql` applied.
- **Deliberate F10 lag (HK 00700):** a pending state expecting `2026-09-30`
  ran the catch-up; F10's newest period was `2026-06-30`, so the job completed
  with `meta.financialsStatus=pending`, the state stayed `pending` with
  `attempts=1` and `next_retry_at=+1h`; `financialRefresh.financials` exposed it
  and the 公告文件 tab read `财报更新中 — 等待 2026-09-30 结构化财报`.
- **Covered period (A 600519):** the same catch-up with expected `2026-09-30`
  and F10 max `2026-09-30` marked the state `applied`, `next_retry_at` null,
  and the job meta `financialsStatus=applied`.
- **No duplicate financials job:** a sweep with both a due check and a due
  catch-up for 600519 produced exactly one `financials.company` execution
  (the check's lease lost to the catch-up; `enqueuedFinancials=0` on the
  check).
- **Dock:** `/v1/news/status.dataRefresh` showed 11 recent runs,
  `pendingFinancials=1`, `appliedFinancials=1`; the desktop/mobile/dark dock
  rendered both tabs and the per-company `已完成` row with no console errors
  and no horizontal scroll.

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
- **Shared TaskDock shipped.** `GET /v1/news/status` carries `dataRefresh`;
  the dock renders `更新新闻` + `财报更新` with filter tabs and per-company
  rows. It remains read-only: no manual refresh/retry buttons (decision 34).
- **The data worker must be running** for the cron/lazy follow-ups. With no
  worker, `data.source.check` / `ingest.filing` jobs stay queued and the page
  shows `排队中`.
- **A lagging F10 period stays pending, then fails honestly.** Verification
  retries for `OCC_DATA_FIN_RETRY_MAX_DAYS` (7 days); after that the state is
  `failed` and the page/dock say so. The period still needs an operator run of
  `occ filings sync` / a fixed F10 source once available. Verification only
  sees `xbrl`/`f10` facts, never profile-derived periods.
- **The catch-up pass is bounded by the sweep batch** and one row per company;
  it never re-fetches the filing index or creates documents.
- **Period derivation can only be as good as the title.** A title with no date
  uses the period-kind fallback (December year-end for annual reports); if an
  issuer uses a non-calendar fiscal year and the title omits the date, the
  expected period can be off by up to a quarter. EDGAR and most A/HK titles
  carry an explicit period, so this is a bounded fallback, not the norm.

## 12. Tests

- `packages/sources/filings`: 30 tests (periodic EDGAR/CNINFO/HKEXnews
  classification, expected-period derivation, content loader link-only/HTML).
- `apps/worker`: 58 tests (source planning, due/lease filtering, cold/steady
  window, financials verification/backoff; existing
  research/reviewer/universe tests).
- `packages/db`: 11 tests (run store, companies, deterministic filing id).
- `apps/web`: 53 tests (filing status branches, data-run/subtask mapping,
  dual-listed aggregation).
- Full serial suite: **379 TypeScript tests** green;
  `corepack pnpm -r --workspace-concurrency=1 test`.
- Python sidecar unchanged at 30 tests.

## 13. Follow-up — financials verification/retry ✅ done 2026-11-03

Shipped with migration `0012_financials_verification.sql`; see §5 and §6.

- `financials_refresh_state` (one row per company) stores
  `expected_period_end`, `status`, `attempts`, `next_retry_at`,
  `first_seen_at` and the market/ticker/code/name needed for a catch-up job.
- `@occ/sources-filings` `expected-period.ts` derives the period from the
  adapter, an explicit title date, a CNINFO year+quarter title, or a bounded
  period-kind fallback. It is written to `filings.period_end` too.
- After every `financials.company` run, `max(financial_facts.period_end)`
  (structured methods only) is compared to the expectation; 7-day tolerance.
  Covered → `applied`; otherwise `pending` with 1h/6h/1d backoff and a
  `OCC_DATA_FIN_RETRY_MAX_DAYS` (7) deadline, then `failed`.
- `data.sweep` gained a catch-up pass; the check leases the same state so a
  catch-up and a check in one sweep cannot enqueue two financials jobs for the
  same period.
- `filingRefresh.financials` and the 公告文件 status line surface the state;
  the dock shows `财报更新中` / `财报待更新` / `财报更新失败` honestly.
- Live-accepted A/HK: 00700 pending (`max=2026-06-30` vs expected
  `2026-09-30`, retry +1h), 600519 applied (`max=2026-09-30`); no duplicate
  financials execution.

Separately, the P1.5 cadence note about a **weekly/monthly profile,
description and sector refresh** (content-hash gated, re-extract only on
change) was **not** implemented. It is not part of the daily filing poll.

## 14. Follow-up — restore shared TaskDock (news + data refresh) ✅ done 2026-11-03

Shipped: one top-nav dock with `全部 / 更新新闻 / 财报更新`, the shared ring
(aggregate progress across active producers), per-company data subtasks
(`检查中` / `无更新` / `发现 N 条` / `财报更新中` / `财报待更新` /
`公告入库中` / `重试中` / `已完成`) and dual-listed A/HK checks merged into
one row without hiding a failure.

- API: `GET /v1/news/status` gained `dataRefresh` (active/last/recent data
  runs, due checks, pending/applied/failed financials, next due/retry,
  `pendingSweep`); `GET /v1/runs/:id` remains the subtask source. No new POST
  route and no lazy data trigger (the data worker owns its cron).
- Web: `TaskDock.tsx` + pure `lib/task-dock.ts`; tests cover run state,
  descriptions, grouping and the dual-listed failure case.
- No manual refresh-news button, no `POST /v1/news/refresh`, no page-entry
  nudge (decision 34). Retry/review buttons are not restored because both
  producers retry automatically.
- `company_research` stays operator-only and is not a dock producer.
- Verified desktop/mobile/dark with a live 11-run data history: no console
  errors, no horizontal scroll, `aria-live` announcements present.

### Decision history

- **2026-10-30 (`08519b1`)** — original design: one top-right dock for news
  **and** company research, with task-kind badges (`更新新闻` /
  `公司数据获取`), `全部 / 新闻更新 / 公司数据` filter tabs, per-company
  subtasks and retry/review actions. The prototype
  [`docs/prototypes/task-dock.html`](prototypes/task-dock.html) still shows
  both kinds.
- **2026-11-01 (`fa84287`)** — narrowed to news-only: manual refresh button
  cancelled, `公司数据` tab and filter tabs out of scope, no retry/review
  buttons.
- **2026-11-03 (user decision)** — restore the **shared information
  architecture** for the two **automatic** producers. The manual refresh-news
  button stays cancelled.

### Target design (historical)

- Producers: `news_refresh` (automatic `news.sweep`, badge `更新新闻`) and
  `data_refresh` (automatic `data.sweep` → `data.source.check` →
  `ingest.filing` / `financials.company`, badge `财报更新`).
- One top-nav dock; collapsed ring/badge; expanded card with
  `全部 / 更新新闻 / 财报更新` filter tabs and per-company subtasks.
- Data rows: `检查中` / `无更新` / `发现 N 条` / `财报更新中` / `公告入库中` /
  `重试中` / `已完成`; text names the state, no fake success.
- **No manual refresh-news button**, no `POST /v1/news/refresh`, no page-entry
  nudge (decision 34). Retry/review buttons are not restored in this cut —
  both producers retry automatically.
- `company_research` stays operator-only (decision 34); do not wire it just
  because the prototype has it.
- API: one `GET /v1/tasks/status` (news + data) or extend `/v1/news/status`
  with a `data` block; keep the lazy news sweep trigger. `GET /v1/runs/:id`
  stays the expanded subtask source.
- Reuse the prototype's two-kind visuals, filters and mobile/dark states;
  remove its manual controls and research mock rows.

### Acceptance

- With both workers running, the dock shows the active/recent news sweep and
  the active/recent data run; filters switch between them.
- A failed HKEXnews check shows `失败/重试中`; an unchanged company shows
  `无更新`; a detected 10-K shows `财报更新中` then `已完成`.
- No refresh button anywhere; the News tab still updates automatically.
- Mobile 390 px, dark mode, `aria-live`/`progressbar`, no horizontal scroll.
- Tests cover the status mapping and two-kind grouping; 0 LLM tokens.

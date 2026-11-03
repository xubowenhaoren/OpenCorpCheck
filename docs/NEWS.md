# News ingestion

> Status: P3 · automatic refresh shipped 2026-11-01
> Related: [Data sources](DATA_SOURCES.md) · [Company facts](EXTRACT.md) · [Search](SEARCH.md)

News articles are stored as first-class `documents` (`doc_type='news'`), chunked
and indexed in Qdrant. The company card's `events` block reads them alongside
profile timeline events, and `search_documents` can filter with
`doc_type=news`.

News updates are **fully automatic**: a daily pg-boss sweep leases due
companies from `global_news_last_update`, enqueues one `news.company` job per
company, and the worker stamps the cursor. There is **no refresh button** in
the UI (decision 34); opening the site is enough because the status endpoint
lazily starts a sweep when companies are due.

## Source: Google News RSS

`packages/sources/news` fetches Google News' public RSS search feed:

```text
https://news.google.com/rss/search?q=<company>&hl=zh-CN|en-US&gl=CN|US&ceid=...
```

- **Link-only.** We store the headline, publisher, date and the short feed
  snippet, and always link to the original article URL. We do not fetch article
  bodies, bypass paywalls, or scrape publisher pages.
- **One request per company per sweep.** Concurrency defaults to 2
  (`OCC_NEWS_CONCURRENCY`), 10 items in steady state (20 on the cold start),
  30-day maximum window.
- Feed terms describe personal, non-commercial feed-reader use. Keep volume low
  and attribute the original publisher; do not redistribute the feed as a
  dataset.

## Automatic refresh

### State: `global_news_last_update`

One row per company, keyed by the worker's canonical target (`US:AAPL`,
`A:600519`, `HK:00700`, `NAME:<slug>`). It is **state, not a registry**: the
sweep selects `companies LEFT JOIN global_news_last_update`, so a company with
no row is due immediately and rows are created on the first claim. Fixtures and
`coverage_tier='stub'` placeholders never participate.

| Column | Meaning |
|---|---|
| `last_update_at` | Last successful check, including a valid empty feed |
| `newest_published_at` | Newest article date seen; window hint |
| `last_status` | `never` / `ok` / `empty` / `failed` / `paused` |
| `last_inserted` / `last_skipped` | Last result counts |
| `consecutive_failures` | Reset on success; paused after 5 |
| `last_enqueued_at` | Lease start |
| `next_due_at` | Lease while claimed, then `last_update_at + TTL` |

### Producer: `news.sweep`

- Queue `news.sweep` with the `short` policy (at most one queued job).
- pg-boss schedule `news-sweep`, cron `OCC_NEWS_SWEEP_CRON` (default
  `0 7 * * *`) in `OCC_NEWS_SWEEP_TZ` (default: the machine's timezone).
  `missed: "once"` sends one catch-up sweep after downtime.
- The handler takes `pg_try_advisory_lock(hashtext('occ:news:sweep'))`; a
  second producer is a no-op.
- It selects due companies (oldest first, `OCC_NEWS_SWEEP_BATCH` default 250),
  leases each row for `OCC_NEWS_CLAIM_TIMEOUT_MS` (30 min), creates a
  `backfill_runs` row (`kind='news'`, `options.source='auto'`) and enqueues one
  `news.company` job per company. It never fetches articles itself.
- **Lazy UI trigger**: `GET /v1/news/status` checks the due count and enqueues
  the producer when needed (skipped while a sweep is queued or the latest run
  is still progressing; the endpoint reports `triggered` so the dock can poll
  faster).
  This is server-side and automatic; the browser cannot start a fetch.
- The daily cron is a **backstop**: because the lazy trigger can start a sweep
  at any time, `next_due_at` may land after the next 07:00 cron. That cron then
  correctly finds 0 due; the next UI poll after expiry starts the sweep. This
  is expected — do not bypass `next_due_at` to force a fetch.

### Worker write-back

- Success (including an empty feed): `last_update_at = now()`,
  `newest_published_at = max(...)`, `next_due_at = now() + OCC_NEWS_TTL_MS`
  (default 23 h, deliberately shorter than the daily sweep), status `ok` or
  `empty`, `consecutive_failures = 0`.
- Failure: never advances `last_update_at`; increments
  `consecutive_failures`; backs off `min(15 min × 2^n, TTL)`; after
  `OCC_NEWS_PAUSE_AFTER` (5) sets `paused` and waits one TTL.
- The per-job result (`inserted`, `skipped`, `articles`, `newestPublishedAt`)
  is stored in `backfill_jobs.meta`, so the task dock can show per-company
  detail and per-run totals.
- Automatic runs never pass `force=true`; unchanged items make no embedding
  call.

### Incremental window

Google News RSS has no `since` cursor, so the window is a hint, never a filter:

- Cold start (no prior check): 30 days, 20 items.
- Steady state:
  `sinceDays = clamp(ceil((now − min(last_update_at, newest_published_at)) / 1d) + 1, 1, 30)`,
  10 items. Taking the older anchor widens the window when the feed lags.
- Article dedupe stays `title + snippet` sha256; an article older than the
  window is still accepted if it is new to the database.

### Retention and the task dock

- `backfill_runs` / `backfill_jobs` hold the last **3 days** of news history
  (`OCC_NEWS_HISTORY_MS`, default 259,200,000). The sweep prunes older runs.
- The top-nav task dock (`apps/web/src/components/TaskDock.tsx`) polls
  `/v1/news/status` and shows the active sweep plus completed sweeps from the
  last 3 days; an idle dock shows the last sweep and the next due time. It has
  no manual controls.
- **Shared-dock target (2026-11-03):** the dock will also show the automatic
  `财报更新` producer (`data.sweep`/`data.source.check`/`financials.company`),
  with `全部 / 更新新闻 / 财报更新` filters. The current production dock is
  news-only until the P1.5 follow-up ships; the manual refresh-news button
  stays cancelled. See [REFRESH.md](REFRESH.md) §14 and
  [UI.md](UI.md) §7.9.
- The company News tab shows `更新于 … · 自动更新` / `正在更新…` from
  `/v1/news/status?company=<ref>` and refetches the company card when the
  cursor advances.

### Operational requirement

Automatic updates progress only while a worker with the news queue is running:

```bash
# persistent local worker (recommended; no manual backfill)
scripts/dev-news-worker.sh start    # status | stop | restart | logs

# or a foreground/drain run
node apps/worker/dist/cli.js work --queues news
```

The API registers the schedule and triggers due sweeps, but it never fetches
news. With no worker, sweep jobs stay queued and the dock shows `排队中`.

## Manual operator backfill (still supported)

The explicit operator path is unchanged for one-off checks. It leases the same
cursor rows, so it cannot double-run with a sweep; `--force` overrides the
lease.

```bash
node apps/worker/dist/cli.js enqueue news --tickers AAPL
node apps/worker/dist/cli.js work --queues news --drain
```

Note: the UI intentionally does **not** call this path.

## Pipeline

```text
news.sweep (schedule / lazy status trigger)
  → select due companies from global_news_last_update
  → lease next_due_at; create a news run; enqueue one news.company job
  → pg-boss news.company
  → resolve companyId (payload first; ticker fallback)
  → fetchGoogleNews(displayName, { limit, sinceDays, locale })
  → ingestNews: sources + documents(news) + 1 chunk per article
  → Qdrant occ_documents points (doc_type=news, source_url, published_at)
  → stamp global_news_last_update + backfill_jobs.meta
```

Locale is `zh-CN` for A/HK and `en-US` for US companies. The company's display
name is the default query; override it with `--query`.

## Commands

```bash
# automatic sweep health (due backlog, cursor states, recent sweeps)
node apps/worker/dist/cli.js news status

# operator-forced sweep (advisory-locked; still leases the cursor)
node apps/worker/dist/cli.js news sweep --now

# operator backfill for explicit targets
node apps/worker/dist/cli.js enqueue news --tickers AAPL --max-items 10 --since-days 30
node apps/worker/dist/cli.js work --queues news --drain

# A/HK names
node apps/worker/dist/cli.js enqueue news --tickers 600519:A,00700:HK --max-items 10

# override the search query for the whole run
node apps/worker/dist/cli.js enqueue news --tickers AAPL --query 'Apple earnings'
```

The queue also appears in `occ-backfill status`; runs use `kind='news'` in
`backfill_runs`.

## Idempotency

`documents.sha256` is the hash of `title + "\n\n" + snippet`. An unchanged rerun
writes nothing and makes no embedding call:

```text
first run:  articles=5 inserted=5 updated=0 skipped=0 indexedChunks=5
rerun:      articles=5 inserted=0 updated=0 skipped=5 indexedChunks=0
```

A changed headline/snippet updates the document, replaces its chunk and
re-indexes that document only.

## Reading

```bash
node apps/cli/dist/occ.js company AAPL --include events --event-limit 10
node apps/cli/dist/occ.js documents "Apple earnings" --doc-type news
curl 'http://127.0.0.1:8787/v1/search/documents?q=Apple%20earnings&doc_type=news'
```

Company-card events carry `kind: "news"`, `date`, `title`, and a `source.url`
pointing at the original article.

## Live verification (2026-10-29)

- `enqueue news --tickers AAPL --max-items 5 --since-days 30` → 5 articles,
  5 chunks, 5 Qdrant points in ~2 s; rerun skipped all 5 with zero embeddings.
- `enqueue news --tickers 600519:A --max-items 3` used the `zh-CN` feed and
  stored 3 Chinese headlines (`千元A股，只剩茅台`, ...) in ~4 s.
- `GET /v1/companies/AAPL?include=events` returns the news items as
  `kind="news"` with Google News source URLs.
- `GET /v1/search/documents?q=Apple%20earnings&doc_type=news` returns the news
  chunk first, with `companyDisplayName="Apple Inc."`.

## Live verification (2026-11-01)

- Migration `0008_global_news_last_update.sql` applied; `backfill_jobs.meta`
  added.
- Opening `http://127.0.0.1:5173` with a news worker running triggered sweep
  `b892648d-…`: 236 due companies claimed and enqueued, **completed 236/236 in
  8m59s, 0 failed**; 232 `ok` / 4 `empty`, **3,237 new articles**, 38 skipped,
  0 LLM tokens.
- `GET /v1/news/status?company=AAPL` returned `lastStatus='ok'`,
  `lastInserted=19`, `nextDueAt` ≈ +23 h; the News tab showed
  `更新于 1 分钟前 · 自动更新` and 30 events.
- The task dock rendered the active sweep (`更新中 27/236 · 11%`) with
  per-company rows (`19 条`, `20 条`, `查看`), and mobile (390 px) had no
  horizontal scroll.
- Killing the worker mid-sweep and restarting it resumed the queued jobs from
  pg-boss; `global_news_last_update` kept the completed companies.

## Limits / next

- Requires the company to exist in `companies`; the sweep derives the key from
  the primary listing, so no research profile is strictly required, but a
  company with no security uses `NAME:<slug>`.
- Google News links are redirect URLs (`news.google.com/rss/articles/...`). The
  original publisher is in the title suffix/source tag, but the stored URL is
  the feed's canonical article link.
- Dedupe is per article URL. The same story from two outlets is two documents.
- No full-text article body, sentiment, or entity linking yet. A future news
  adapter (company IR RSS, GDELT) can write the same `documents` shape.
- The feed's own rate limits/terms apply; retries are pg-boss's 2 attempts with
  backoff, then the dead-letter queue. The cursor backs off and pauses after 5
  consecutive failures; it never hammers the feed.
- The UI has no refresh control by design. If a sweep stays `排队中`, the
  news worker is not running.

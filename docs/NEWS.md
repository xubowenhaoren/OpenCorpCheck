# News ingestion

> Status: P3 · 2026-10-29
> Related: [Data sources](DATA_SOURCES.md) · [Company facts](EXTRACT.md) · [Search](SEARCH.md)

News articles are stored as first-class `documents` (`doc_type='news'`), chunked
and indexed in Qdrant. The company card's `events` block reads them alongside
profile timeline events, and `search_documents` can filter with
`doc_type=news`.

## Source: Google News RSS

`packages/sources/news` fetches Google News' public RSS search feed:

```text
https://news.google.com/rss/search?q=<company>&hl=zh-CN|en-US&gl=CN|US&ceid=...
```

- **Link-only.** We store the headline, publisher, date and the short feed
  snippet, and always link to the original article URL. We do not fetch article
  bodies, bypass paywalls, or scrape publisher pages.
- **One request per company.** Concurrency defaults to 2 (`OCC_NEWS_CONCURRENCY`),
  10 items per company, 30-day window.
- Feed terms describe personal, non-commercial feed-reader use. Keep volume low
  and attribute the original publisher; do not redistribute the feed as a
  dataset.

## Pipeline

```text
enqueue news --tickers AAPL
  → pg-boss news.company (one job per company)
  → resolve company by ticker (must already have a research profile)
  → fetchGoogleNews(displayName, { limit, sinceDays, locale })
  → ingestNews: sources + documents(news) + 1 chunk per article
  → Qdrant occ_documents points (doc_type=news, source_url, published_at)
```

Locale is `zh-CN` for A/HK and `en-US` for US companies. The company's display
name is the default query; override it with `--query`.

## Commands

```bash
# enqueue + run
node apps/worker/dist/cli.js enqueue news --tickers AAPL --max-items 10 --since-days 30
node apps/worker/dist/cli.js work --queues news --drain

# A/HK names
node apps/worker/dist/cli.js enqueue news --tickers 600519:A,00700:HK --max-items 10
node apps/worker/dist/cli.js work --queues news --drain

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

## Limits / next

- Requires the company to exist in `companies` (ingest a research profile first);
  otherwise the job fails with `company not found`.
- Google News links are redirect URLs (`news.google.com/rss/articles/...`). The
  original publisher is in the title suffix/source tag, but the stored URL is
  the feed's canonical article link.
- Dedupe is per article URL. The same story from two outlets is two documents.
- No full-text article body, sentiment, or entity linking yet. A future news
  adapter (company IR RSS, GDELT) can write the same `documents` shape.
- The feed's own rate limits/terms apply; retries are pg-boss's 2 attempts with
  backoff, and a run stops after the dead-letter queue.

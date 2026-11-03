# Official filing adapters (P1.4)

> Status: implemented 2026-11-02 · Related: [DATA_SOURCES](DATA_SOURCES.md),
> [OWNERSHIP](OWNERSHIP.md), [REFRESH](REFRESH.md) (P1.5 daily sweep),
> [CONTEXT_TRANSFER](../CONTEXT_TRANSFER.md) §10

## 1. Goal

Add filing-level events from official disclosure channels, on top of the
profile, F10 and news layers:

- **US**: SEC EDGAR `submissions` filing index (8-K, 10-K/10-Q, 20-F/40-F,
  6-K, proxy, SC 13D/G, registration/offerings; routine Form 3/4/5, 144,
  13F and N-PORT are excluded because ownership is handled by P1.3).
- **A-share**: CNINFO (巨潮资讯) announcement history. CNINFO is the
  CSRC-designated disclosure platform for both SSE and SZSE, so one adapter
  covers both boards; the PDFs it links are the exchange-published files.
- **HK**: HKEXnews listed-company announcement title search, driven through
  the Playwright sidecar (`POST /v1/hkexnews/search`).
- **Company IR RSS/Atom** and **GDELT** as optional, link-only supplements.
- **HKEX DION** ownership already shipped in P1.3 and is unchanged.

Everything is deterministic and uses **0 LLM tokens**. Discovery, PDF/HTML
following, text/table extraction, chunking and Qdrant indexing are pure code.

## 2. Source adapters

Package: [`packages/sources/filings`](../packages/sources/filings).

| Source | Discovery | Filing link | Notes |
|---|---|---|---|
| SEC EDGAR | `data.sec.gov/submissions/CIK*.json` (24 h cache under `$OCC_EDGAR_DIR/<cik>/submissions.json`) | primary document URL, or the filing directory | announcement-form filter; recent filings window |
| CNINFO | `topSearch/query` resolves the company's `orgId`, then `hisAnnouncement/query` | `https://static.cninfo.com.cn/<adjunctUrl>` | SSE + SZSE; `orgId` is not always derivable from the ticker (e.g. 601318 → `9900002221`) |
| HKEXnews | sidecar drives the official title-search form (stock id + date range) | result-table PDF link | requires `occ-f10 serve`; one page load per company |
| IR RSS/Atom | configured feed URL | item link | link-only; no article bodies |
| GDELT DOC API | `api.gdeltproject.org/api/v2/doc/doc` | article URL | media tier, link-only, opt-in |

Identifiers used: EDGAR CIK (`company_ids.id_type='cik'`); A-share /
HK tickers from `securities`; CNINFO `orgId` resolved at request time; IR
feeds keyed by ticker in [`config/ir-feeds.yaml`](../config/ir-feeds.yaml).

Dedupe identity is `(companyId, source, externalId, canonicalUrl)`, where
`externalId` is the accession number (EDGAR), announcement id (CNINFO),
PDF URL (HKEXnews) or article URL (RSS/GDELT). Tracking parameters are
removed before hashing. Including `companyId` keeps one shared article/feed
item separate for each company that mentions it.

## 3. PDF / HTML extraction

- **PDF** (CNINFO, HKEXnews): TypeScript fetches and caches raw bytes under
  `.occ/filings/<source>/<key>.pdf`; the Python sidecar
  (`POST /v1/pdf/extract`, `pdfplumber`) returns per-page text and tables.
  `pdfplumber` decodes embedded CJK fonts. Caps: 30 MB download, 80 pages per
  filing (request max 200), 20k chars/page, 20 tables/page, 200 rows/table.
  Extracted JSON is cached beside the PDF; a rerun reuses it unless
  `--refresh`.
- **EDGAR HTML**: link-only by default. `--full-text` fetches the primary
  HTML document, strips tags and stores a single page capped at 300k chars.
- Tables are flattened into the page text as `header | value` rows and keep
  the page number in `chunks.page` and the section label `文件第 N 页`.
- No OCR: a scanned/image-only PDF yields no text and becomes a link-only
  document with a warning.

## 4. Data model

No migration. A filing is a normal `documents` row:

- `doc_type='filing'`
- `source_id` → an official `sources` row (`trust_tier='official'`, or
  `company_ir` / `media` for RSS/GDELT); `license` states link-only and no
  bulk redistribution.
- `title`, `published_at`, `page_count`, `sha256` (raw PDF/HTML hash),
  `extractor_version` = `filing-<source>-v1`.
- `metadata`: `source` (adapter), `sourceName`, `market`, `externalId`,
  `canonicalUrl`, `form`, `category`, `pdfUrl`, `linkOnly`,
  `contentAttempted`, `contentError`, `indexed`, `pages`, `truncated`,
  `warnings`, `textSha256`, plus source-specific fields.
- `chunks`: one or more per page (target 600 tokens / max 800, ~90 overlap),
  with `page`, `section='文件第 N 页'`, and Qdrant points
  (`doc_type='filing'`). Link-only documents get one `公告` chunk containing
  the title, form and source URL.

Filings are **not** facts and do not enter the review queue. A human can still
mark a derived fact/relation later; the filing itself is the evidence.

## 5. Events and UI

- `listFilingEvents` returns filings separately from news. The company card
  exposes `filings` when `include=filings`; `filing_limit` defaults to 30.
- The company page got a **公告文件 / Filings** tab between News and Sources.
  Each row shows the date, title, form/category and a **来源** button that
  opens the original PDF/disclosure page. The News tab remains news-only, so
  a busy news day cannot bury announcements.
- The Sources tab includes filing sources; the Search API can filter
  `doc_type=filing` through the existing document search.

## 6. Commands

```bash
# Dry run (default): discovery only, no PDF fetch and no writes.
node apps/cli/dist/occ.js filings sync --market US --company AAPL --days 90 --max-items 5
node apps/cli/dist/occ.js filings sync --company 600519 --days 180
node apps/cli/dist/occ.js filings sync --market HK --company 00700 --days 180

# Apply: follow PDFs, extract, write documents/chunks and index.
node apps/cli/dist/occ.js filings sync --market all --limit 5 --max-items 5 --apply

# Options
#   --sources official|all|edgar,cninfo,hkexnews,ir-rss,gdelt
#   --include-stubs  also poll A500/SPX placeholder rows (default: no)
#   --skip-pdf       link-only (no PDF fetch/extraction)
#   --full-text      extract EDGAR HTML primary documents
#   --max-pages N    PDF page cap (default 80)
#   --refresh        ignore EDGAR/PDF/extraction caches and re-ingest
#   --skip-index     write Postgres only
#   --delay-ms N     pause between companies (default 400)
#   --ir-feeds PATH  IR feed registry (default config/ir-feeds.yaml)

node apps/cli/dist/occ.js filings coverage [--json]
```

The HK run needs the sidecar:

```bash
cd services/finance-analyst && uv run occ-f10 serve --port 8090
```

Env:

| Env | Default |
|---|---|
| `OCC_FILINGS_DIR` | `.occ/filings` (raw PDFs + extraction JSON) |
| `OCC_IR_FEEDS` | `config/ir-feeds.yaml` |
| `OCC_EDGAR_DIR` / `OCC_EDGAR_USER_AGENT` | shared with financials/ownership |
| `OCC_FINANCE_ANALYST_URL` | `http://127.0.0.1:8090` |
| `OCC_HKEXNEWS_TIMEOUT_MS` | `60000` |
| `OCC_HKEXNEWS_SETTLE_MS` | `1500` |
| `OCC_HKEXNEWS_RATE_PER_SEC` | `1.0` |

## 7. Results (2026-11-02 acceptance sample)

Applied on a fresh sample (`--max-items 2`, `--days 90/180`):

| Company | Source | Documents | Chunks | Notes |
|---|---|---|---|---|
| AAPL | SEC EDGAR | 2 | 4 | both 8-K/8-K-A primary HTML extracted (`--full-text`) |
| 600519 贵州茅台 | CNINFO | 2 | 3 | PDFs extracted; 1-page 经营数据 + 2-page 业绩说明会 |
| 00700 腾讯 | HKEXnews | 2 | 116 | 80-page offering circular (page-capped) + 3-page notice |

Verified:

- Rerunning the same commands inserts 0 and skips existing documents.
- `documents '茅台 第三季度 经营数据'` returns the filing chunk as the top hit;
  the source opens the CNINFO PDF.
- Company card `include=filings` returns Tencent's two filings even though the
  news list is much newer; the UI has a 公告文件 tab with a working 来源 button.
- PDF extraction preserves Chinese text and tables; the Moutai sample returns
  `11,292,545.23` from the 经营数据 table.
- Coverage groups by the adapter (`edgar`, `cninfo`, `hkexnews`, `ir-rss`,
  `gdelt`) and market: **6 documents / 123 chunks** in this sample
  (`edgar` 2/4, `cninfo` 2/3, `hkexnews` 2/116). `metadata.sourceName` keeps
  the human source label (`sec-edgar-submissions`, `cninfo-announcement`,
  `hkexnews-title-search`). No link-only documents remain after the
  `--full-text` pass.
- Screenshots: [Tencent desktop](screenshots/p1.4/tencent-filings-desktop.png),
  [Tencent mobile](screenshots/p1.4/tencent-filings-mobile.png),
  [Moutai desktop](screenshots/p1.4/moutai-filings-desktop.png).

## 8. Known limits

- **EDGAR recent window only**: `submissions.filings.recent` covers the latest
  filings; older paginated `filings.files` are not followed yet. A later
  follow-up can add them if a company's recent window is too short. The P1.5
  daily window is at most 30 days, so this is sufficient for incremental checks.
- **EDGAR HTML is link-only by default** to keep ingestion volume bounded;
  use `--full-text` for a chosen sample/company. A later `--full-text` run
  backfills the existing link-only documents without `--refresh`.
- **CNINFO `orgId` is resolved per run.** 601318/601398-type codes are not
  derivable from the ticker; the top-search endpoint is the source of truth.
  A follow-up can persist `cninfo_org` in `company_ids` to avoid the extra
  request; the P1.5 daily check currently resolves it per check.
- **CNINFO is one adapter for SSE + SZSE.** Direct SSE/SZSE endpoints were not
  added: CNINFO is the designated disclosure platform and already links the
  exchange PDFs. Add an official SSE/SZSE adapter only if CNINFO coverage
  proves insufficient.
- **HKEXnews requires the sidecar** and one Playwright page load per company.
  The title search returns the first page (up to 100 rows); `--max-items`
  caps what is ingested. Pagination/load-more is not followed yet.
- **PDFs are capped** (30 MB / 80 pages / 20k chars per page). A huge annual
  report is truncated with `metadata.truncated=true` and a warning.
- **No OCR**: scanned PDFs stay link-only.
- **GDELT is rate-limited** (one request per 5 seconds; a burst gets HTTP 429).
  The adapter paces and retries, and reports a clear error if the quota is
  still exhausted. It is opt-in and link-only, so the default official run is
  never blocked by it.
- **GDELT/IR RSS are link-only secondary sources**; they are opt-in
  (`--sources all`) so the default run stays official-first.
- **Daily refresh is P1.5**: `company_filing_state` + `filings` detection and
  the automatic `data.sweep` live in [REFRESH.md](REFRESH.md). This operator
  command remains the path for a historical batch or a manual re-ingest.
  The auto path shares the same content loader and PDF cache.
- **No review queue**: filings are evidence documents, not proposed facts.
- **Index retry**: a document is marked `metadata.indexed=true` only after a
  successful Qdrant write. `--skip-index` or an embedding/Qdrant failure
  leaves it `false`, and the next normal run re-ingests and re-indexes it. A
  failed `--refresh` never replaces an existing full-text document with a
  link-only one.
- **Robots/licensing**: the default adapters use official public endpoints
  (SEC/CNINFO/HKEXnews) with polite pacing and link-only news. `robots.txt` is
  not parsed programmatically; the operator must review terms before adding a
  new IR feed or enabling GDELT for a large batch.

## 9. Tests

- `packages/sources/filings`: 18 tests covering EDGAR form filtering/URLs,
  CNINFO orgId + announcement parsing, HKEXnews rows, RSS/Atom, GDELT,
  canonical URLs, dates and PDF page text.
- `packages/ingest`: `filingDocumentId` idempotency.
- `services/finance-analyst`: 30 tests including a generated PDF extraction
  and HKEXnews helpers.
- Run:
  ```bash
  corepack pnpm --filter @occ/sources-filings test
  corepack pnpm --filter @occ/ingest test
  cd services/finance-analyst && uv run pytest
  ```

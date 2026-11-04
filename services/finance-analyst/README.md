# finance-analyst sidecar

Internal Python service that turns Eastmoney F10 pages into structured JSON for
the OpenCorpCheck ingestion layer. It replaces the ad-hoc
`aif10_scraper.py` from the private `finance_analyst` repository
(Apache-2.0), keeping its navigation approach and fixing the limits that made it
unusable as a data source.

**Scope:** A, HK and US F10 pages, plus two P1.4 filing helpers: HKEXnews
announcement search and deterministic PDF text/table extraction. F10 is still a
coverage layer; use CNINFO / HKEXnews / SEC EDGAR for citation-grade documents.
Eastmoney data is proprietary — internal research with attribution only, never
bulk redistribution.

## What changed vs. the original scraper

| Original | This sidecar |
|---|---|
| `document.body.innerText`, flattened | text **and** `{caption, headers, rows}` tables |
| truncates every page at 8,000 chars | 2 MB safety cap; `truncated` is reported |
| 1-hour silent disk cache | no disk cache; optional in-process TTL (`F10_CACHE_TTL_SECONDS`) |
| markdown on stdout | JSON with status, URL, hash, timings, warnings |
| no retries, no pacing | 2 retries + jitter, per-domain pacing, bounded concurrency |
| unbounded page concurrency | one Chromium, page semaphore (default 2) |
| no XHR access | captures JSON XHR/fetch responses from `*.eastmoney.com` |

## Setup

```bash
cd services/finance-analyst
uv sync                                   # creates .venv with Python 3.12
uv run playwright install chromium        # one-time browser download
```

Local toolchain: `uv` (installed via `brew install uv`). No Docker required for
development; container packaging lands with P5.

## Run

```bash
# HTTP sidecar
uv run occ-f10 serve --host 127.0.0.1 --port 8090
curl -s localhost:8090/health
curl -s localhost:8090/v1/f10/pages/A

curl -s -X POST localhost:8090/v1/f10/scrape \
  -H 'content-type: application/json' \
  -d '{"market":"A","code":"600519","pages":["cwfx","gsgk"]}' | jq '.pages[] | {page, http_status, text_chars, table_count}'

# one-off CLI
uv run occ-f10 scrape AAPL US --pages cwfx,gsgk --out /tmp/aapl.json
uv run occ-f10 scrape 600519 A --preset default --out /tmp/moutai.json
```

Presets (`default` / `minimal`) are defined by the sidecar. Run
`GET /v1/f10/pages/{market}` to see the valid page hashes.

## API

`POST /v1/f10/scrape`

```json
{
  "market": "US",
  "code": "AAPL",
  "pages": ["cwfx", "gsgk"],
  "preset": null,
  "force": false,
  "capture_xhr": true,
  "timeout_ms": 30000
}
```

Response is a `ScrapeResponse`: `meta` (normalized code, timing, concurrency),
`pages[]` (label, hash, URL, HTTP status, text, tables, `html_sha256`,
`storage_key`, `xhr`, warnings, attempts) and `errors[]`. A per-page failure
never fails the whole request; it appears as a page with `error` set.

`GET /health`, `GET /v1/f10/pages/{market}`.

### HKEX DION (P1.3)

The public Disclosure of Interests site is behind a JavaScript bot-defense
layer, so plain HTTP gets “temporarily unavailable”. This sidecar drives the
normal search form with Playwright at **1 request/second**:

```bash
uv run occ-f10 dion 02318 --days 365 --max-pages 10
curl -s -X POST localhost:8090/v1/dion/notices \
  -H 'content-type: application/json' \
  -d '{"code":"02318","days":365,"max_pages":10}' | jq '.total_records, .notices[0]'
```

Response: `code`, `name`, `from_date`, `to_date`, `total_records`, `pages`,
`truncated`, `notices[]` (serial, shareholder, reason, shares, avg_price,
holdings, percent, event_date, detail URL) and `errors[]`. The TypeScript
`@occ/sources-ownership` planner uses only the `(L)` long-position line.
`OCC_DION_TIMEOUT_MS`, `OCC_DION_SETTLE_MS`, `OCC_DION_MAX_PAGES` and
`OCC_DION_RATE_PER_SEC` tune it.

### HKEXnews (P1.4)

The public title-search page is a JSF form; the old plain-HTTP servlet now
returns an empty result set. This sidecar drives the normal search form with
Playwright and reads the server-rendered result table:

```bash
uv run occ-f10 hkexnews 00700 --days 365 --max-items 30
curl -s -X POST localhost:8090/v1/hkexnews/search \
  -H 'content-type: application/json' \
  -d '{"code":"00700","days":365,"max_items":30}' | jq '.total_records, .items[0]'
```

Response: `code`, `name`, `from_date`, `to_date`, `total_records`, `returned`,
`truncated`, `items[]` (`date`, `stock_code`, `stock_name`, `category`,
`title`, PDF `url`, `size`) and `errors[]`. Tune with
`OCC_HKEXNEWS_TIMEOUT_MS`, `OCC_HKEXNEWS_SETTLE_MS` and
`OCC_HKEXNEWS_RATE_PER_SEC` (default 1 req/s).

### PDF extraction (P1.4)

`pdfplumber` extracts page text and tables from filing PDFs. The TypeScript
adapter posts base64 bytes; no LLM is involved.

```bash
uv run occ-f10 pdf /tmp/announcement.pdf --max-pages 80
curl -s -X POST localhost:8090/v1/pdf/extract \
  -H 'content-type: application/json' \
  -d "{\"base64\":\"$(base64 < /tmp/announcement.pdf | tr -d '\\n')\",\"max_pages\":80}" \
  | jq '.page_count, .pages[0].text'
```

Caps: 30 MB input, 80 pages by default (hard max 200), 20k chars/page,
20 tables/page, 200 rows/table. `truncated` and `warnings[]` are explicit. A
scanned/image-only PDF yields empty text; the TS layer stores it link-only.

`storage_key` is `f10/{market}/{code}/{page}/{sha256}.html`, ready for MinIO in
P2. Set `F10_SNAPSHOT_DIR` to also write HTML/text snapshots locally (gitignored).

## Configuration

| Env | Default | Notes |
|---|---|---|
| `F10_HEADLESS` | `true` | set `false` to watch the browser |
| `F10_MAX_CONCURRENCY` | `2` | global page semaphore across requests |
| `F10_RATE_PER_SEC` | `5` | per-domain spacing (no burst) |
| `F10_TIMEOUT_MS` | `30000` | navigation timeout |
| `F10_SETTLE_MS` | `1200` | wait after DOMContentLoaded before scrolling |
| `F10_RETRIES` | `2` | retries on network errors and 429/5xx |
| `F10_CACHE_TTL_SECONDS` | `0` | in-process result cache; `0` disables |
| `F10_SNAPSHOT_DIR` | unset | write HTML/text snapshots here |

## Test and acceptance

```bash
uv run pytest                       # unit + API validation, no network
uv run python scripts/acceptance.py # live: AAPL, 600519, 00700
```

Acceptance requires network access to `emweb.eastmoney.com` and writes
`out/{market}-{code}.json`.

## Use from dsh (MCP)

The TypeScript adapter and MCP server live in
[`packages/sources/eastmoney-f10`](../../packages/sources/eastmoney-f10) and
[`apps/cli`](../../apps/cli). dsh attaches the server through
[`phase0/f10-mcp.patch.yml`](../../phase0/f10-mcp.patch.yml); tools appear as
`mcp__occ__f10_scrape` and `mcp__occ__f10_pages`.

```bash
# terminal 1
cd services/finance-analyst && uv run occ-f10 serve --port 8090

# terminal 2 (repo root): build the MCP server once
corepack pnpm -r build

# run Phase 0 research with F10 attached
cd phase0 && npm run research -- --only AAPL --f10
```

Without an API-key run, verify the wire directly:

```bash
cd phase0
npx @deepseek-ai/dsh@0.2.1-rc.3 --profile headless \
  --patch "$PWD/dsh.patch.yml" --patch "$PWD/f10-mcp.patch.yml" --dump-config \
  | grep -A12 mcp-finance-analyst
```

## Next (Phase 1)

- MinIO snapshot upload + `documents` rows, driven by pg-boss workers.
- pg-boss queue + worker pool for parallel, resumable backfill.
- `packages/sources/eastmoney-f10` is wired into `apps/cli`; move it behind the
  worker/API once those exist.
- Container image (`mcr.microsoft.com/playwright/python`) in P5.

# @occ/cli — CLI and MCP stdio server

Two jobs:

- `occ` — migrate, seed, ingest research sections, search, company cards, extraction,
  review proposals.
- `occ-f10-mcp` — bridge the Python [finance-analyst sidecar](../../services/finance-analyst/README.md)
  and the company API to any MCP client, primarily dsh.

## Ingest

`occ ingest` turns research section markdown into `companies` / `documents` / `chunks`
rows, then indexes them into Qdrant:

```bash
# existing A/HK sections
node apps/cli/dist/occ.js ingest \
  --sections phase0/out/sections --tickers 600519:A,00700:HK

# NDX sections (ticker names, exchange and index membership come from the snapshot)
node apps/cli/dist/occ.js ingest --sections phase0/out/sections --index NDX --concurrency 4
```

| Flag | Effect |
|---|---|
| `--sections <dir>` | Section directory (default `phase0/out/sections`) |
| `--index NDX` | Snapshot metadata for tickers; default `NDX`, `none` disables |
| `--tickers A,B:C` | Only these sections |
| `--market A\|HK\|US` | Default market for bare filenames (default US) |
| `--concurrency N` | Parallel companies (default 4) |
| `--force` | Rewrite unchanged sections and re-index |
| `--skip-index` | Postgres only; no Qdrant writes |
| `--json` | Machine-readable summary |

Ingestion is idempotent by section SHA-256: an unchanged rerun writes nothing and
makes no embedding call. Entity resolution matches an existing `securities`
(ticker + exchange) or company slug first, so NDX/A/HK profiles attach to the
seeded companies instead of creating duplicates.

When the snapshot store is configured (`OCC_S3_*`), ingest also uploads the
section markdown to `sections/<slug>/<sha256>.md` and records the `s3://` URI in
`documents.storage_key`. Upload failure is logged and does not fail ingest.

## Aliases and snapshots

```bash
# curated Chinese names → aliases + company-point reindex
node apps/cli/dist/occ.js aliases sync
node apps/cli/dist/occ.js aliases sync --dry-run --json

# section markdown → S3/MinIO (content-addressed), reconcile documents.storage_key
scripts/dev-minio.sh start
export OCC_S3_ENDPOINT=http://127.0.0.1:9000 OCC_S3_BUCKET=opencorpcheck \
       OCC_S3_ACCESS_KEY=minioadmin OCC_S3_SECRET_KEY=minioadmin
node apps/cli/dist/occ.js snapshots upload
node apps/cli/dist/occ.js snapshots check      # report without writing
node apps/cli/dist/occ.js snapshots list --prefix sections/
```

`aliases sync` reads [`config/aliases/zh.yaml`](../../config/aliases/zh.yaml)
and is idempotent. `snapshots upload` refuses a section whose file hash no
longer matches `documents.sha256`; re-ingest first. See
[docs/SEARCH.md](../../docs/SEARCH.md#known-limits--next).

## Company cards, extraction and review

```bash
# one cited company card (ticker, slug or ULID)
node apps/cli/dist/occ.js company AAPL --include financials,facts,relations,events

# deterministic facts/financials + deepseek-flash relations from section markdown
node apps/cli/dist/occ.js extract --all --relations llm --concurrency 2
node apps/cli/dist/occ.js extract --all --dry-run --json

# agent proposals go to the review queue, never straight into facts/relations
node apps/cli/dist/occ.js propose relation --src AAPL --dst GOOGL --type buys_from \
  --quote "Google 是模型供应商" --source-url https://example.com/source

node apps/cli/dist/occ.js review list --status pending
node apps/cli/dist/occ.js review approve --kind relation --company AAPL --limit 20 --dry-run
node apps/cli/dist/occ.js review approve --ids rvw_1,rvw_2 --reviewer bowen
node apps/cli/dist/occ.js review reject --all --yes --limit 50
```

Accepted extracted relations become `verified`; accepted fact proposals insert a
`facts` row with an `agent_proposal` source. Batch decisions require a filter
(`--ids`, `--kind`, `--company`, or `--all --yes`). The API also serves a local
console at `http://127.0.0.1:8787/v1/review/ui`.

`occ extract --relations llm` needs `DEEPSEEK_API_KEY` or
`DEEPSEEK_API_KEY_FILE`; the model defaults to `deepseek-flash`. See
[docs/EXTRACT.md](../../docs/EXTRACT.md) for the extraction rules and confidence
semantics.

## MCP tools

| Tool | Purpose |
|---|---|
| `f10_scrape` | Scrape one company's F10 pages; returns meta + text + tables + XHR metadata |
| `f10_pages` | List valid page hashes and presets for a market |
| `search_companies` | Search the internal company DB by name/ticker/alias/pinyin |
| `get_company` | One company card (profile, financials, facts, relations, events); `include` trims |
| `search_documents` | Search internal research chunks, optionally for one company |
| `propose_fact` | Queue a fact proposal for human review (never writes directly) |
| `propose_relation` | Queue a company-relation proposal for human review |

Data tools call the HTTP API (`OCC_API_URL`, default `http://127.0.0.1:8787`).
If the API is down they return an error instead of empty data. Relations returned
with `status: "inferred"` are unreviewed machine extraction; cite their evidence
quote and source URL and never present them as audited.

`f10_scrape` defaults to `detail: "summary"` (20k chars/page, 60 rows/table);
pass `detail: "full"` only when a number is missing from the summary.

## Run

```bash
# 1. sidecar (F10 tools)
cd ../../services/finance-analyst && uv run occ-f10 serve --port 8090

# 2. company API (get_company / search_* / propose_* tools)
node apps/api/dist/server.js

# 3. build (repo root)
corepack pnpm -r build

# 4. MCP server (stdio)
OCC_FINANCE_ANALYST_URL=http://127.0.0.1:8090 \
OCC_API_URL=http://127.0.0.1:8787 \
  node apps/cli/dist/mcp.js
```

`OCC_FINANCE_ANALYST_URL` defaults to `http://127.0.0.1:8090`;
`OCC_API_URL` defaults to `http://127.0.0.1:8787`.

## Attach to dsh

Use the overlay [`phase0/f10-mcp.patch.yml`](../../phase0/f10-mcp.patch.yml)
(`serverName: occ`, so tools are `mcp__occ__f10_scrape`, `mcp__occ__get_company`,
`mcp__occ__search_companies`, ...). Phase 0 accepts `--f10`:

```bash
cd phase0
npm run research -- --only AAPL --f10
```

The matching skill is
[`.dsh/skills/f10-financials/SKILL.md`](../../.dsh/skills/f10-financials/SKILL.md),
which sets source hierarchy and citation rules.

## Test

```bash
corepack pnpm --filter @occ/cli test
```

The integration test spawns the built server over stdio and drives it with the
MCP client against a fake sidecar; no network or API key required.

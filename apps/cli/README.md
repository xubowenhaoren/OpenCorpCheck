# @occ/cli — CLI and MCP stdio server

Two jobs:

- `occ` — migrate, seed, ingest research sections, search, company lookup.
- `occ-f10-mcp` — bridge the Python [finance-analyst sidecar](../../services/finance-analyst/README.md)
  to any MCP client, primarily dsh.

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

## MCP tools

| Tool | Purpose |
|---|---|
| `f10_scrape` | Scrape one company's F10 pages; returns meta + text + tables + XHR metadata |
| `f10_pages` | List valid page hashes and presets for a market |

`f10_scrape` defaults to `detail: "summary"` (20k chars/page, 60 rows/table);
pass `detail: "full"` only when a number is missing from the summary.

## Run

```bash
# 1. sidecar
cd ../../services/finance-analyst && uv run occ-f10 serve --port 8090

# 2. build (repo root)
corepack pnpm -r build

# 3. MCP server (stdio)
OCC_FINANCE_ANALYST_URL=http://127.0.0.1:8090 node apps/cli/dist/mcp.js
```

`OCC_FINANCE_ANALYST_URL` defaults to `http://127.0.0.1:8090`.

## Attach to dsh

Use the overlay [`phase0/f10-mcp.patch.yml`](../../phase0/f10-mcp.patch.yml)
(`serverName: occ`, so tools are `mcp__occ__f10_scrape` / `mcp__occ__f10_pages`).
Phase 0 accepts `--f10`:

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

# @occ/cli — MCP stdio server

Exposes the Python [finance-analyst sidecar](../../services/finance-analyst/README.md)
to any MCP client, primarily dsh. It is a thin bridge: argument validation,
response projection for an agent context, and JSON text results.

## Tools

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

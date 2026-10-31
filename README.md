# OpenCorpCheck

**Open, agentic company intelligence for STAR 50 · ChiNext 50 · Hang Seng Index · NASDAQ-100.**

> Status: P3 complete + P3.5 web UI — agent research (`deep_research` → pg-boss),
> a DeepSeek Harness ACP sidebar with the `occ` MCP tools attached, live tool-call
> trajectory + GFM Markdown, Google News RSS documents across the 102-company corpus,
> and a React/Vite UI with search, company pages (financials / relationship graph /
> news / sources), NDX-100 browse and the live assistant sidebar · 2026-10-29

OpenCorpCheck is an open-source, AI-native alternative to commercial company-intelligence
products (the "企查查" category). It builds a cited, queryable profile for every company in
four indices — STAR 50 (科创50), ChiNext 50 (创业板50), Hang Seng Index and NASDAQ-100 —
plus private companies discovered on demand, and exposes it through a web/desktop UI, a
CLI, an MCP server, and a DeepSeek Harness agent sidebar. (The S&P 500 backfill was
cancelled in the 2026-10-29 scope change; NASDAQ-100 is already backfilled.)

Phase 0 is a narrow spike: a minimal DeepSeek Harness headless run + a distilled BFS/DFS
skill that produces cited company profiles. No UI, no database. See
[phase0/README.md](phase0/README.md).

The web UI is implemented in [`apps/web`](apps/web/README.md): search, company pages with
financials / relationship graph / news / sources, NASDAQ-100 browse, and the live ACP
assistant sidebar. Tool-use trajectory (live activity panel + grouped static trace) and
GFM Markdown are built; the sidebar replays dsh's persisted session log into the same
trajectory cards after a reload and lists past sessions in a history popover. A
first-class sub-agent card is still reserved.

## Why

- Company data is fragmented across SEC EDGAR, HKEX, CNINFO, GLEIF, company IR sites, news,
  and product pages.
- Commercial company-intelligence products are closed, region-locked, and optimized for
  registry/risk data rather than products, strategy, and relationships.
- General deep-research agents (DeepSeek Harness, DeerFlow) are powerful but have no durable
  company model, no provenance-first database, and no hybrid search over a curated universe.

## What

- **Universe**: ~280 index members (STAR 50, ChiNext 50, Hang Seng, NASDAQ-100),
  deduplicated across markets, plus a curated AI watchlist (OpenAI, Anthropic, DeepSeek,
  Kimi/Moonshot, ...) and on-demand private companies. NASDAQ-100 is backfilled; HSI
  (85 constituents) is the next backfill target. S&P 500 was removed from the v1 plan.
- **Dual-mode providers**: the interactive sidebar uses the official DeepSeek API; the
  headless backfill worker uses NVIDIA NIM + Parallel Search MCP (free tiers), with a
  local retry gateway. `OCC_LLM_PROVIDER=deepseek` rolls the worker back.
- **BFS coverage**: discover and refresh company basics, products, IR hubs, and news.
- **DFS diligence**: follow annual reports, filings, earnings calls, and product docs to
  extract cited financials and relationships.
- **Hybrid search**: keyword + dense + sparse, fused with RRF/DBSF and reranked; an explain
  view shows exactly why a result ranked where it did.
- **Agent sidebar**: DeepSeek Harness over ACP, with OpenCorpCheck tools exposed via MCP.
  Web search uses dsh's built-in `web_search`; company facts come from the OpenCorpCheck
  database and the `finance_analyst` Eastmoney F10 scraper.
- **Interfaces**: web UI, Electron desktop (Windows/macOS), `occ` CLI, MCP server, REST/OpenAPI.
  The web UI/API also run natively on macOS and WSL2/Linux; cross-platform support is a v1
  requirement even where Docker packaging is deferred.
- **Deploy**: Docker Compose + GHCR images; thin Electron shell; backend local or remote.

## Docs

- [Phase 0 — minimal headless research harness](phase0/README.md)
- [Phase 0 output — Magnificent Seven profiles](phase0/out/magnificent-seven.md)
- [finance-analyst sidecar — Eastmoney F10](services/finance-analyst/README.md)
- [MCP server — F10 tools](apps/cli/README.md)
- [Parallel backfill worker](apps/worker/README.md)
- [Data layer + hybrid search (P2)](docs/SEARCH.md)
- [Company facts, financials and relations (P3)](docs/EXTRACT.md)
- [Agent sidebar over dsh ACP](docs/AGENT.md)
- [News ingestion (Google News RSS)](docs/NEWS.md)
- [Search evaluation](docs/EVAL.md)
- [UI design — 企查查-style company page, financials, relationship graph](docs/UI.md)
- [Web app — React/Vite UI, pages and commands](apps/web/README.md)
- [NASDAQ-100 constituent snapshot](config/indices/ndx.yaml)
- [Architecture](docs/ARCHITECTURE.md)
- [Prior art & competitive scan](docs/PRIOR_ART.md)
- [Data sources & the finance_analyst reuse plan](docs/DATA_SOURCES.md)

## Non-goals (v1)

- All 200M+ legal entities worldwide. We start with four indices + the AI watchlist and grow
  on demand.
- Bypassing paywalls, logins, CAPTCHAs, or robots.txt.
- Investment advice or trading signals.
- Moomoo/OpenD integration; it needs a local daemon and is post-v1.
- Redistributing bulk data that is not licensed for redistribution.

## License

Code: Apache-2.0 (proposed). Data: each source keeps its own license; see
`docs/DATA_SOURCES.md` (planned). "企查查" is a trademark of its owner; OpenCorpCheck is not
affiliated with it.

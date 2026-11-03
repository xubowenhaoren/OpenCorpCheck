# OpenCorpCheck

**Open, agentic company intelligence for NASDAQ-100 · S&P 500 · CSI A500 · Hang Seng Index · ChiNext 50.**

> Status: 2026-11-02 — search, company pages (profile / financials / relationship
> graph / news / sources), automatic news refresh + task dock, all five index
> pages (NDX/SPX/A500/HSI/CYB50), `occ` CLI, MCP server, and the DeepSeek
> Harness ACP sidebar. **P1.1 A500/SPX placeholder pages, P1.2 sector + entity
> resolution and P1.3 US 13F + HKEX DION ownership are shipped** (850 searchable
> stubs; 235/236 researched companies have a canonical sector; 13,009 US 13F +
> 90 HKEX DION ownership edges). The active roadmap (official filing adapters,
> daily refresh) is in [`CONTEXT_TRANSFER.md`](CONTEXT_TRANSFER.md) §10.

OpenCorpCheck is an open-source, AI-native alternative to commercial company-intelligence
products (the "企查查" category). It builds a cited, queryable profile for every company in
five indices — NASDAQ-100, S&P 500, CSI A500, Hang Seng Index and ChiNext 50 — plus a
curated AI watchlist, and exposes it through a web UI, a CLI, an MCP server, and a DeepSeek
Harness agent sidebar. CSI A500 and S&P 500 are **searchable placeholder pages**
(ticker/name/market/index only), not bulk research targets.

Phase 0 is a narrow spike: a minimal DeepSeek Harness headless run + a distilled BFS/DFS
skill that produces cited company profiles. No UI, no database. See
[phase0/README.md](phase0/README.md).

The web UI is implemented in [`apps/web`](apps/web/README.md): search, company pages with
financials / relationship graph / news / sources, NDX/SPX/A500/HSI/CYB50 index pages, an
automatic news task dock, and the live ACP assistant sidebar. Tool-use trajectory (live
activity panel + grouped static trace) and GFM Markdown are built; the sidebar replays
dsh's persisted session log and resumes the same session after a restart. A first-class
sub-agent card is **permanently deferred**.

## Why

- Company data is fragmented across SEC EDGAR, HKEX, CNINFO, GLEIF, company IR sites, news,
  and product pages.
- Commercial company-intelligence products are closed, region-locked, and optimized for
  registry/risk data rather than products, strategy, and relationships.
- General deep-research agents (DeepSeek Harness, DeerFlow) are powerful but have no durable
  company model, no provenance-first database, and no hybrid search over a curated universe.

## What

- **Universe**: 1,086 non-fixture companies — 236 researched (NASDAQ-100 100,
  Hang Seng Index 85, ChiNext 50 50, plus the discovered set) and 850 A500/SPX
  searchable stubs — plus a curated AI watchlist (OpenAI, Anthropic, DeepSeek,
  Kimi/Moonshot, ...). A500 (500) and S&P 500 (500 companies / 503 securities)
  are placeholder pages with `未收录` badges, not bulk research targets. STAR 50
  is deferred backfill and is not in the current plan.
- **Entity spine (P1.2)**: 11 canonical sectors (235/236 researched companies),
  ticker/CIK/domain/ISIN/USCC/EIN/LEI/Wikidata identifiers, audited A/HK
  dual-listing merges, and GLEIF parent edges with source + review queue. See
  [docs/ENTITY.md](docs/ENTITY.md).
- **Ownership graph (P1.3)**: US SEC Form 13F-HR institutional holdings and
  HKEX DION substantial-shareholder notices become additive `invests_in` edges
  with source + quote + a pending review item. Deterministic, 0 LLM tokens; no
  counterparty is created outside `companies`. See
  [docs/OWNERSHIP.md](docs/OWNERSHIP.md).
- **Providers**: official **DeepSeek** is the default for headless research, the
  reviewer, and the ACP sidebar. NVIDIA NIM + Parallel Search is opt-in with
  `OCC_LLM_PROVIDER=nvidia` (after per-model 429s it is not the default).
- **BFS coverage**: discover and refresh company basics, products, IR hubs, and
  news; automatic news sweeps are RSS-only and cost 0 LLM tokens.
- **DFS diligence**: follow annual reports, filings, earnings calls, and product docs to
  extract cited financials and relationships.
- **Hybrid search**: keyword + dense + sparse, fused with RRF/DBSF and reranked; an explain
  view shows exactly why a result ranked where it did.
- **Agent sidebar**: DeepSeek Harness over ACP, with OpenCorpCheck tools exposed via MCP.
  Web search uses dsh's built-in `web_search`; company facts come from the OpenCorpCheck
  database and the `finance_analyst` Eastmoney F10 / SEC EDGAR adapters.
- **Interfaces**: web UI, `occ` CLI, MCP server, REST/OpenAPI. Desktop/Docker
  packaging is P2 and deferred by the current machine; the web app and API run
  natively on macOS and WSL2/Linux.

## Docs

- [Context transfer + active P1/P2 roadmap](CONTEXT_TRANSFER.md)
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

- All 200M+ legal entities worldwide. We start with NDX + S&P 500 + CSI A500 +
  HSI + ChiNext 50 (the last two indices as placeholders), the AI watchlist, and
  on-demand private companies.
- Bypassing paywalls, logins, CAPTCHAs, or robots.txt.
- Investment advice or trading signals.
- Moomoo/OpenD integration; it needs a local daemon and is post-v1.
- Redistributing bulk data that is not licensed for redistribution.

## License

Code: Apache-2.0 (proposed). Data: each source keeps its own license; see
`docs/DATA_SOURCES.md` (planned). "企查查" is a trademark of its owner; OpenCorpCheck is not
affiliated with it.

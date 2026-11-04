# OpenCorpCheck

> [中文（默认）](README.md) · **English**

**AI-native company intelligence for NASDAQ-100 · S&P 500 · CSI A500 · Hang Seng Index · ChiNext 50 · STAR 50.**

> **Two AI-native innovations:** **(1)** agentic web search that pairs a **BFS** breadth pass
> (fundamentals, segments, competitors, events) with a **DFS** depth pass (open the primary
> filing and verify each key number), so coverage and accuracy are solved together;
> **(2)** a **headless agent worker pool plus an independent review loop** that turns
> single-agent mistakes and hallucinations into typed, routed, bounded fixes instead of
> silently polluting the database.

> Status: 2026-11-03 — search, company pages (profile / financials / relationship
> graph / news / filings / sources), automatic news refresh + **shared task dock
> (news + financials)**, six index
> pages (NDX/SPX/A500/HSI/CYB50/STAR50), `occ` CLI, MCP server, and the DeepSeek
> Harness ACP sidebar. **P1.1 A500/SPX placeholder pages, P1.2 sector + entity
> resolution, P1.3 US 13F + HKEX DION ownership, the P1.3 dense-graph UI
> follow-up, P1.4 official filing adapters, P1.5 daily company-data /
> financial-report refresh, both P1.5 follow-ups, and P4 review-loop routing +
> the STAR 50 pilot are shipped** (820 searchable stubs; 284/286 researched
> companies have a canonical sector; 13,009 US 13F + 90 HKEX DION ownership
> edges; SEC EDGAR + CNINFO + HKEXnews filing discovery with PDF text/tables
> and a separate 公告文件 tab; 301 daily filing checks over 286 companies, with
> new periodic reports automatically updating structured financials at 0 LLM
> tokens, and a verified expected period with bounded A/HK F10 retry). P2 is
> deferred. The roadmap is in
> [`docs/ROADMAP.md`](docs/ROADMAP.md).

OpenCorpCheck is an open-source, AI-native alternative to commercial company-intelligence
products (the "企查查" category). It builds a cited, queryable profile for every company in
six indices — NASDAQ-100, S&P 500, CSI A500, Hang Seng Index, ChiNext 50 and STAR 50 — plus
a curated AI watchlist, and exposes it through a web UI, a CLI, an MCP server, and a
DeepSeek Harness agent sidebar. CSI A500 and S&P 500 are **searchable placeholder pages**
(ticker/name/market/index only), not bulk research targets.

## Two AI-native innovations

**1. BFS + DFS agentic web search.** A single search pass is either too shallow or too
narrow. The research agent first runs a breadth pass — F10 fundamentals (A/HK), four
`web_search` query groups (annual report, segment revenue, strategy/new products,
competitors/share), and 2–5 opened URLs — to build the full 13-section skeleton. It then
runs a convergence check on the three most important claims, and a depth pass that opens
the primary filing or release to verify numbers, dates and definitions, looking for both
supporting evidence and counter-evidence. BFS guarantees coverage; DFS guarantees the key
numbers are not taken from search snippets or model memory.

**2. Headless agent worker pool + review loop.** Each company is researched by a headless
dsh process in a pg-boss worker pool. A second, read-only agent then reviews the finished
profile — not the research conversation — and checks section completeness, citation
coverage, whether cited URLs actually open, currency/unit/period consistency, unsourced
claims, fabricated URLs and honest data gaps. Each issue carries a `kind`
(reviewer-supplied, with a deterministic keyword fallback) and is routed: a scoped profile
rewrite, a deterministic `financials.company` / filing-index re-run, or an operator
command. Revisions are capped at 2; a profile that still fails becomes `needs_review` with
structured issues and `last_error`, never a silent pass. Deterministic data paths (news,
filings, structured financials) use 0 LLM tokens.

In the STAR 50 pilot (50 companies): 38 `ready`, 12 `needs_review` at the cap, 0 reviewer
parse failures, 50/50 structured F10 financials; 57 review turns routed `financials` and
8 `filings`. The reviewer caught, among others, an in-text revenue-share calculation that
did not add up (48.64% vs 49.53%), a Capex narrative whose direction contradicted the
table (+30%, not a decline), and a ROE figure with no citation.

Phase 0 is a narrow spike: a minimal DeepSeek Harness headless run + a distilled BFS/DFS
skill that produces cited company profiles. No UI, no database. See
[phase0/README.md](phase0/README.md).

The web UI is implemented in [`apps/web`](apps/web/README.md): search, company pages with
financials / relationship graph / news / sources, NDX/SPX/A500/HSI/CYB50/STAR50 index pages, a
shared automatic news + financials task dock, and the live ACP assistant sidebar. Tool-use trajectory (live
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

- **Universe**: 1,106 non-fixture companies — 286 researched (NASDAQ-100 100,
  Hang Seng Index 85, ChiNext 50 50, STAR 50 50, plus the discovered set) and
  820 A500/SPX searchable stubs, plus a curated AI watchlist (OpenAI,
  Anthropic, DeepSeek, Kimi/Moonshot, ...). A500 (500) and S&P 500 (500
  companies / 503 securities) are placeholder pages with `未收录` badges, not
  bulk research targets. The STAR 50 (科创50) 50-company backfill shipped
  2026-11-03.
- **Entity spine (P1.2)**: 11 canonical sectors (284/286 researched companies),
  ticker/CIK/domain/ISIN/USCC/EIN/LEI/Wikidata identifiers, audited A/HK
  dual-listing merges, and GLEIF parent edges with source + review queue. See
  [docs/ENTITY.md](docs/ENTITY.md).
- **Ownership graph (P1.3)**: US SEC Form 13F-HR institutional holdings and
  HKEX DION substantial-shareholder notices become additive `invests_in` edges
  with source + quote + a pending review item. Deterministic, 0 LLM tokens; no
  counterparty is created outside `companies`. See
  [docs/OWNERSHIP.md](docs/OWNERSHIP.md).
- **Daily refresh (P1.5 + follow-ups)**: `data.sweep` checks every researched
  company's EDGAR/CNINFO/HKEXnews filing index once a day; new announcements
  become P1.4 documents and a new periodic report re-runs the deterministic
  financials pipeline. The expected period is verified against structured
  facts; while A/HK F10 lags it stays pending and retries 1h/6h/1d (max 7
  days). The shared task dock shows `更新新闻` + `财报更新`. The first check is
  a baseline, not a backfill. 0 LLM tokens. See
  [docs/REFRESH.md](docs/REFRESH.md).
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

- [Roadmap + shipped work](docs/ROADMAP.md)
- [Review loop — issue routing, state machine, metrics](docs/REVIEW_LOOP.md)
- [Phase 0 — minimal headless research harness](phase0/README.md)
- [Phase 0 output — Magnificent Seven profiles](phase0/out/magnificent-seven.md)
- [finance-analyst sidecar — Eastmoney F10](services/finance-analyst/README.md)
- [MCP server — F10 tools](apps/cli/README.md)
- [Parallel backfill worker](apps/worker/README.md)
- [Data layer + hybrid search (P2)](docs/SEARCH.md)
- [Company facts, financials and relations (P3)](docs/EXTRACT.md)
- [Agent sidebar over dsh ACP](docs/AGENT.md)
- [News ingestion (Google News RSS)](docs/NEWS.md)
- [Daily company-data / filing refresh (P1.5)](docs/REFRESH.md)
- [Search evaluation](docs/EVAL.md)
- [UI design — 企查查-style company page, financials, relationship graph](docs/UI.md)
- [Web app — React/Vite UI, pages and commands](apps/web/README.md)
- [Index snapshot format and fetch notes](docs/DATA_SOURCES.md) — snapshots are not shipped in the public repo
- [Architecture](docs/ARCHITECTURE.md)
- [Prior art & competitive scan](docs/PRIOR_ART.md)
- [Data sources & the finance_analyst reuse plan](docs/DATA_SOURCES.md)

## Non-goals (v1)

- All 200M+ legal entities worldwide. We start with NDX + S&P 500 + CSI A500 +
  HSI + ChiNext 50 + STAR 50 (A500/SPX as searchable placeholders), the AI watchlist, and
  on-demand private companies.
- Bypassing paywalls, logins, CAPTCHAs, or robots.txt.
- Investment advice or trading signals.
- Moomoo/OpenD integration; it needs a local daemon and is post-v1.
- Redistributing bulk data that is not licensed for redistribution.

## License

Code: [Apache-2.0](LICENSE). Data: each source keeps its own license; see
[docs/DATA_SOURCES.md](docs/DATA_SOURCES.md). "企查查" is a trademark of its owner; OpenCorpCheck is not
affiliated with it.

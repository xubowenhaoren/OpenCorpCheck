# Prior Art & Competitive Scan

> Research date: 2026-10-27. Star counts from the GitHub REST API on the same day; they move.
> This is a directional scan, not an exhaustive market study.

## Question

Is there already a high-star GitHub project for a **global, open-source, AI-native
"企查查"** — i.e. an index-scale company database with agentic BFS/DFS research, hybrid
search, and an agent sidebar built on a 2026 stack?

## Short answer

**No exact match.** The high-star projects in the neighbourhood are infrastructure (agent
harness, crawler, vector DB) or AI-finance/trading. The closest company-intelligence
projects are small (single-digit to ~1.5k stars) and are either one-company research toys or
MCP wrappers around free APIs. Chinese "企查查/天眼查 crawler" repos top out in the tens of
stars.

That is good news for a tech demo: the **intersection is open**. The bad news: generic
"deep research" is crowded — the differentiation has to be the company data model,
provenance, search quality, and UX, not the prompt.

## Landscape

### 1. Agent harness / deep research / crawling (infrastructure)

| Repo | Stars | What it is | Why it is not OpenCorpCheck |
|---|---:|---|---|
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | 263.6k | Plugin-first agent harness; web UI, ACP, MCP, Python SDK; MIT | Runtime only — no company universe, data model, or search |
| [bytedance/deer-flow](https://github.com/bytedance/deer-flow) | 84.5k | LangGraph-based "super agent" / deep-research framework | Generic research reports; no durable company DB or index scope |
| [unclecode/crawl4ai](https://github.com/unclecode/crawl4ai) | 86.4k | LLM-friendly crawler with BFS/DFS/BestFirst deep crawl | Crawling primitive; no entity model, storage, or UI |
| [apify/crawlee](https://github.com/apify/crawlee) | 26.3k | Production crawler framework (Playwright/Cheerio, queues, sessions) | Infrastructure; excellent building block |
| [qdrant/qdrant](https://github.com/qdrant/qdrant) | 35.3k | Vector DB with native sparse+dense hybrid, RRF/DBSF | Search engine only |

### 2. Company intelligence (closest product category)

| Repo / project | Stars | What it does | Gap vs. OpenCorpCheck |
|---|---:|---|---|
| [exa-labs/company-researcher](https://github.com/exa-labs/company-researcher) | 1.5k | Enter a company URL; gather funding, people, competitors, news via Exa + Anthropic | One company at a time; no curated universe, DB, hybrid search, or CLI |
| [Stewyboy1990/companyscope-mcp](https://github.com/Stewyboy1990/companyscope-mcp) | 4 | MCP server that assembles a profile from 10 free sources (Wikipedia, GitHub, SEC, OpenCorporates, RDAP, patents) | Conceptually closest; tiny, no UI, no index universe, no durable store |
| [mayooear/ai-company-researcher](https://github.com/mayooear/ai-company-researcher) | 217 | LangGraph + Firecrawl company research agent | Unmaintained; single-company research |
| AG2 + TinyFish due-diligence demo | small | Multi-agent pipeline: seed crawler + specialists + validator | Demo, not a product; no database/search |
| CompanyScope / ICP Scout / GitDealFlow | small | MCP/lead-gen wrappers around public sources | Narrow use cases; no global index or financial depth |

### 3. AI finance / investing (adjacent, huge audiences)

| Repo | Stars | What it is | Why it is adjacent, not the same |
|---|---:|---|---|
| [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) | 117.3k | Multi-agent LLM trading framework | Produces trading views; no company database/search |
| [virattt/ai-hedge-fund](https://github.com/virattt/ai-hedge-fund) | 64.3k | AI hedge-fund agents | Portfolio/trading simulation; not company intelligence |
| [AI4Finance-Foundation/FinGPT](https://github.com/AI4Finance-Foundation/FinGPT) | 21.5k | Open financial LLMs/data | Models, not an end-to-end product |
| [AI4Finance-Foundation/FinRobot](https://github.com/AI4Finance-Foundation/FinRobot) | 8.3k | AI agent platform for financial analysis | Generic agent platform; no curated company graph |
| [OpenBB-finance/OpenBB](https://github.com/OpenBB-finance/OpenBB) | 74.8k | Open data platform for analysts, quants, and AI agents | Broad market/financial data; not a global registry + products/relations "企查查" UX |

### 4. Chinese "企查查 / 天眼查" scrapers

GitHub search for `qichacha` / `tianyancha` returns mostly small scrapers:

- `qichacha` repos: top result ~43 stars (`CooperMin/qichacha`), others 11–17.
- `tianyancha` repos: top result ~92 stars (`acpyin/tianyancha`), others 38–56.
- Official/adjacent wrappers exist (QCC CLI, QCC MCP, DeepSeek Harness QCC plugin), but they
  depend on a QCC account/token/credits and are not open data platforms.

These are legally fragile, maintenance-heavy, and have no AI-native data model. They are a
signal that demand exists, not a substitute.

### 5. Open company data (the raw material)

There is no single comprehensive open global company database. The practical picture is a
"spine and satellites":

| Source | Coverage | License / access | What it gives |
|---|---|---|---|
| [GLEIF](https://www.gleif.org/) | ~2.9M legal entities | CC0, bulk download | LEI, legal form, addresses, **Level 2 parent/ownership** |
| [SEC EDGAR](https://www.sec.gov/edgar) | US registrants | Public domain, ~10 req/s, User-Agent required | Filings, XBRL financials, ownership, risk factors |
| [Companies House](https://www.gov.uk/government/organisations/companies-house) | UK | OGL | Registry + accounts |
| [Wikidata](https://www.wikidata.org/) | Large caps | CC0 | Employees, industry, basic facts |
| [OpenCorporates](https://opencorporates.com/) | 200M+ entities, 140+ jurisdictions | API no longer meaningfully open | Registry data (BYO token) |
| [CNINFO](http://www.cninfo.com.cn/) / SSE / SZSE | A-shares | Public announcements | Annual/interim reports, announcements |
| [HKEXnews](https://www.hkexnews.hk/) | HK-listed | Public | Annual/interim reports, announcements |

The "spine and satellites" framing comes from a useful 2026 write-up,
[Open Company Data Master List](https://github.com/bamr87/bashconsultants/blob/main/pages/2026-09-10-open-company-data-master-list.md).

## What this means for OpenCorpCheck

1. **Do not build a 200M-entity registry.** Scope to four indices (~1,000 companies after
   dedupe) + on-demand private companies. That is enough for a compelling global demo and
   keeps crawl/storage/eval costs sane.
2. **The moat is the data layer + provenance + search quality.** DeerFlow/dsh can already
   generate a research report. They cannot answer "which A500 companies supply Apple, and
   what changed in the last 12 months?" with cited, queryable facts.
3. **Build on the ecosystem, don't rebuild it.** Crawlee for fetching, DeepSeek Harness for
   the agent runtime, Qdrant for hybrid retrieval, GLEIF/SEC/CNINFO/HKEX for facts.
4. **Distribution through DeepSeek Harness is a real advantage.** dsh has 263k+ stars and a
   plugin/MCP/ACP ecosystem. A thin, high-quality company-intelligence plugin can reach users
   that a standalone demo cannot — but the product must work standalone too, because dsh is a
   developer preview.
5. **Name check.** A web search for "OpenCorpCheck" returned no GitHub repos or pages. That is
   not trademark clearance; check GitHub org / npm / domain before going public.

## Sources

- [DeepSeek Harness repo](https://github.com/deepseek-ai/deepseek-harness)
- [DeepSeek Harness docs](https://deepseek-harness.github.io/deepseek-harness/en/)
- [DeepSeek Harness sidebar-right reference](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/sidebar-right.md)
- [DeepSeek Harness ACP package](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/acp)
- [DeepSeek Harness Python SDK](https://deepseek-harness.github.io/deepseek-harness/en/guide/python-sdk)
- [DeepSeek Harness MCP guide](https://dshbase.com/blog/dsh-mcp/)
- [DeerFlow](https://github.com/bytedance/deer-flow)
- [Crawl4AI](https://github.com/unclecode/crawl4ai)
- [Crawlee](https://github.com/apify/crawlee)
- [Qdrant hybrid queries](https://qdrant.tech/documentation/search/hybrid-queries/)
- [exa-labs/company-researcher](https://github.com/exa-labs/company-researcher)
- [CompanyScope MCP](https://github.com/Stewyboy1990/companyscope-mcp)
- [OpenBB](https://github.com/OpenBB-finance/OpenBB)
- [TradingAgents](https://github.com/TauricResearch/TradingAgents)
- [ai-hedge-fund](https://github.com/virattt/ai-hedge-fund)
- [Open Company Data Master List](https://github.com/bamr87/bashconsultants/blob/main/pages/2026-09-10-open-company-data-master-list.md)
- [GLEIF](https://www.gleif.org/)
- [SEC EDGAR](https://www.sec.gov/edgar)
- [OpenCorporates](https://opencorporates.com/)

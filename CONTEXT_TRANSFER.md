# OpenCorpCheck — Context Transfer

> Handoff: **2026-11-01**. Current state: foundations through the web UI are
> complete; automatic news refresh, US EDGAR-only structured financials, the
> Financials tab, HSI, ChiNext 50, **P1.1 A500/SPX placeholders** and **P1.2
> sector + entity resolution** are shipped. **The only active TODO list is §10
> (P1.3–P1.5); P2 is deferred.** Backfill is out of scope for the current plan.
>
> The old 1,394-line document is preserved verbatim in
> [`context_transfer_history.md`](context_transfer_history.md).
>
> **Current P1:** US 13F/HKEX DION ownership, official filing adapters, and
> daily financial-report refresh. See §10.
>
> **Machine constraint:** macOS VM, no Docker. P2 delivery/packaging
> (Docker/Electron/hosted demo/CI/observability) is deferred. Development uses
> native Postgres 17, Qdrant 1.18, uv sidecars and Node 24. Cross-platform
> macOS + WSL2/Linux remains a v1 requirement.
>
> **Scope:** placeholders for CSI A500 + S&P 500; no bulk research for them.
> STAR 50 and remaining HSI/CYB50 coverage are backfill and out of the current
> plan. Synthetic seed fixtures still carry legacy A500/SPX memberships
> (`apps/cli/src/seed-data.ts`); they are E2E fixtures, not the plan.

---

## 0. LIVE STATE — 2026-11-01 (read first)

> **Current state:** foundations through the web UI are complete. Automatic
> news refresh, structured financials (US EDGAR-only), the Financials tab,
> HSI, ChiNext 50, the **A500/SPX placeholder layer** and **P1.2 sector +
> entity resolution** are shipped. **The only active TODO list is §10.**
> Backfill and delivery/engineering quality are out of scope for the current P1
> plan.
>
> **Corpus:** 1,086 non-fixture companies — 236 researched (NDX 100, HSI
> 85, CYB50 50, plus the discovered set) and **850 A500/SPX searchable
> stubs** (435 A500 + 415 SPX; 0 fixture stubs). NDX profiles predate the
> reviewer; HSI/CYB50 `company_research_state` is 104 `ready` / 31
> `needs_review` (all revision cap, not parse failures; `needs_review` is the
> quality gate working). 10 AI-watchlist fixtures (plus SMIC) remain hidden.
> **P1.2:** 235/236 researched companies have a canonical sector (the only gap
> is `HK:00823` 领展房地产投资信托基金, F10 `EmptyRender`); 12 dual-listed
> A/HK stubs were merged into their researched HK company with an audited
> merge log.
>
> | Index | Constituents | Memberships | Structured financials | Status |
> |---|---|---|---|---|
> | NDX | 100 | 100 | **100 `xbrl`, 0 `f10`** | done |
> | HSI | 85 | 85 | **84 `f10`** | done; `HK:00823` F10 EmptyRender |
> | CYB50 | 50 | 50 | **50 `f10`** | done; 45 ready / 5 needs_review |
> | A500 | 500 | 500 (`as_of 2026-10-30`) | **0 (stubs)** | **P1.1 done** |
> | SPX | 500 companies / 503 securities | 500 (`as_of 2026-10-29`) | **0 (stubs)** | **P1.1 done** |
> | STAR50 | — | — | — | deferred backfill, not in the current plan |
>
> **Data:** `financial_facts` 46,880 (29,683 `xbrl`, 15,767 `f10`, 1,430
> profile); financials cache 234 ok / 1 failed; 3,245 news documents (last
> sweep: 232 `ok` / 4 `empty` companies); relations 87 (22 `reported` F10 +
> 64 `inferred` + 1 GLEIF `parent_of`); 1,097 companies (1,086 non-fixture +
> 11 fixtures), 1,257 index memberships, 1,109 securities, 4,888 aliases,
> 2,491 identifiers (incl 183 LEI, 186 ISIN, 64 USCC, 98 Wikidata QID).
> **Known content gaps:** 1 researched company has `sector = null`
> (`HK:00823` 领展, F10 `EmptyRender`); no US ownership edges; no
> CNINFO/HKEXnews/13F/DION adapters; **no daily filing/earnings refresh yet** —
> P1.3–P1.5 (§10). P1.2 GLEIF parent coverage is sparse (see §5). Stubs
> intentionally have no profile, documents, financials, chunks or embeddings.
>
> **Running (2026-11-01, rebuilt for P1.1):**
> - API `node apps/api/dist/server.js` on `:8787`
> - Vite `corepack pnpm --filter @occ/web dev` on `:5173`
> - persistent news worker: `scripts/dev-news-worker.sh start` (pid in
>   `.occ/news-worker.pid`, log `.occ/news-worker.log`)
> - F10 sidecar `:8090`, Postgres `:5432`, Qdrant `:6333`, embeddings `:8080`
> - no research/financials worker, no NIM gateway (official DeepSeek default)
>
> **Last news run** `b892648d-4537-4b73-8916-aaeca32bfedc`: completed 236/236,
> 0 failed, 8m59s; 232 `ok` / 4 `empty`; 3,237 new articles; 0 LLM tokens;
> history kept 3 days; next due ≈ +23 h.
>
> **Tests/build:** all green — API 33, web 33, worker 40, extract 42, ingest
> 46, agent 17, CLI 7, retrieval 10, db 9, storage 5, sources 18 (F10 9 +
> news 9), **entity 29** (289 total). Web bundle 425.39 KB (gzip 130.72 KB).
> Run tests serially:
> `corepack pnpm -r --workspace-concurrency=1 test`.
>
> **Recent commits:** `e6217ab` P1.2 sector + entity resolution; `8f795d5`
> P1.1 A500/SPX placeholder layer; `0eec66f` automatic news refresh +
> TaskDock; `75864fb` US EDGAR-only + Financials tab; `771490c` news sweep
> daily. Migrations `0008_global_news_last_update.sql` and
> `0009_entity_merge_log.sql` are applied; run
> `node apps/cli/dist/occ.js migrate` after pulling schema changes.

### 0.1 Monitor commands

```bash
node apps/worker/dist/cli.js status
node apps/worker/dist/cli.js states --limit 100
node apps/worker/dist/cli.js news status
scripts/dev-news-worker.sh status
tail -n 20 .occ/news-worker.log
curl -s 'http://127.0.0.1:8787/v1/news/status?company=AAPL'

psql postgres://occ@127.0.0.1:5432/occdb -c \
  "select count(*) filter (where next_due_at <= now()) due, count(*) total
     from global_news_last_update;"
psql postgres://occ@127.0.0.1:5432/occdb -c \
  "select key,last_status,last_update_at,next_due_at,consecutive_failures
     from global_news_last_update order by last_update_at nulls first limit 20;"
psql postgres://occ@127.0.0.1:5432/occdb -c \
  "select method,count(*) from financial_facts group by 1;"
psql postgres://occ@127.0.0.1:5432/occdb -c \
  "select coverage_tier,count(*) from companies group by 1 order by 1;"
psql postgres://occ@127.0.0.1:5432/occdb -c \
  "select index_code,as_of,count(*) from index_memberships
     where index_code in ('A500','SPX') group by 1,2 order by 1,2;"
psql postgres://occ@127.0.0.1:5432/occdb -c \
  "select status,count(*) from company_research_state group by 1;"
```

### 0.2 What “normal” looks like

- **Official DeepSeek is the default** for headless research and the reviewer;
  NIM + Parallel is opt-in (`OCC_LLM_PROVIDER=nvidia`) and was retired as the
  default after per-model 429s. Do not switch back without checking quota.
- **`needs_review` is success of the gate**, not a bug. Do not flip it to
  `ready` or raise `OCC_REVIEW_MAX_CYCLES` in production.
- **Structured financials are deterministic and LLM-free.** US = SEC EDGAR
  XBRL only; A/HK = F10. Derived cells (`计算：`) are marked `推导` and must
  not be rendered as reported lines.
- **News is automatic and LLM-free.** A daily sweep + the lazy
  `/v1/news/status` trigger keep the corpus fresh; the UI has no refresh
  control. If the dock shows `排队中`, the news worker is not running. The
  first cold sweep is 20 items/company (~9 min for 236); steady state is 10.
- **No Docker on this machine.** Native Postgres/Qdrant/uv sidecars/Node 24;
  keep scripts working on macOS and WSL2/Linux.
- **No secret is tracked.** `DEEPSEEK_API_KEY.txt` / `NVIDIA_API_KEY.txt` and
  `.env` stay gitignored; the coding session key is outside the repo.

## 1. What this is

OpenCorpCheck is an open, agentic, provenance-first company intelligence store.
Every number/relation should link back to a source; the agent can propose facts
but cannot write verified data directly.

**v1 universe** (1,086 non-fixture companies today: 236 researched + 850
A500/SPX stubs; plus the AI watchlist):

| Index | Code | Market | Status |
|---|---|---|---|
| CSI A500 / 中证A500 | `000510` | A | **done 2026-11-01**: 500 constituents, 435 stubs (65 already covered, incl 12 merged dual-listed HK companies) |
| S&P 500 | `SPX` | US | **done 2026-11-01**: 500 companies / 503 securities, 415 stubs (85 already covered) |
| STAR 50 / 科创50 | `000688` | A (SSE) | **deferred backfill**, not in the current P1/P2 plan |
| ChiNext 50 / 创业板50 | `399673` | A (SZSE) | **done 2026-10-31**: 50 constituents, 45 ready / 5 needs_review |
| Hang Seng Index | `HSI` | HK | **done 2026-10-31**: 85 constituents, 85/85 memberships |
| NASDAQ-100 | `NDX` | US | **done**: 100 companies backfilled |

- **A500 and S&P 500 are placeholders, not research.** `occ indices sync`
  loads `config/indices/a500.yaml` and `sp500.yaml` (generated by
  [`scripts/snapshot-indices.py`](scripts/snapshot-indices.py)) and creates
  `coverage_tier='stub'` rows with ticker + names + market + index/weight
  only. They are **searchable** with a `未收录` badge and open a read-only
  placeholder page with no tabs/CTA. A constituent that already resolves to a
  real company (e.g. AAPL, 茅台) only gains the membership; its profile is
  never modified. An operator may later fill a company through an explicit,
  capped local batch; there is no in-app research.
- **Sources:** A500 = official CSI constituent/weight workbooks; SPX = SPDR
  S&P 500 ETF (SPY) daily holdings (documented fallback, same precedent as
  HSI) plus the SEC ticker→exchange/CIK file. A500 weights are `as_of
  2026-09-30`; the membership snapshot is `2026-10-30`. SPX share-class
  weights are summed to one company-level membership weight.
- Placeholder rows are intentionally minimal: no profile, documents,
  financials, chunks or embeddings until an operator-run batch fills them.
- AI watchlist (~24 names: OpenAI, Anthropic, DeepSeek, Moonshot/Kimi, Zhipu,
  MiniMax, ByteDance, Huawei, …) lives in [`config/universe.yaml`](config/universe.yaml).
- The product is exposed through a web UI, CLI, MCP server and a DeepSeek
  Harness (dsh) ACP sidebar. Phase 0 validated the headless dsh research path.

---

## 2. Current stack (2026-11-01)

- **LLM/search providers — official DeepSeek by default (revised 2026-10-31
  14:16)**:
  - **Interactive ACP sidebar** = paid **DeepSeek API** (`deepseek-flash`) +
    `deepseek-official` search/fetch. Unchanged; the user's key stays.
  - **Local headless backfill / worker pool** = **official DeepSeek API**
    (`deepseek-flash`) + official `web_search` / `web_fetch`, with
    `reasoningEffort: low`. The NIM route
    (`deepseek-ai/deepseek-v4.1-flash` + Parallel Search MCP) remains opt-in
    with `OCC_LLM_PROVIDER=nvidia`; it hit sustained per-model 429s during the
    HSI batch.
  - `DEEPSEEK_API_KEY.txt` is required for research, ingest/extraction and the
    reviewer. `NVIDIA_API_KEY.txt` is only needed for the opt-in NIM route. The
    assistant's coding session key is outside the repo and must not be touched.
    Measured NIM behaviour:
    [`docs/NVIDIA_NIM_MIGRATION.md`](docs/NVIDIA_NIM_MIGRATION.md).
- **Phase 0**: 7 MAG7 profiles generated by dsh headless with
  **`deepseek-flash`** (not Pro). Validation PASS; deliverables under
  [`phase0/out/`](phase0/out/). Historical detail in the archive.
- **P1.2 (2026-11-01)**: deterministic sector taxonomy + entity spine.
  `packages/sources/entity` maps Eastmoney F10 industry labels (A/HK/US) and SEC
  SIC to 11 canonical sectors; `occ entities enrich` records ISIN/USCC/domain/
  CIK/EIN/ticker identifiers; `occ entities gleif` resolves LEI + parent edges;
  `occ entities wikidata` resolves QIDs; `occ entities resolve` merges
  dual-listed A/HK stubs through the structured `H股代码`. Migration
  `0009_entity_merge_log.sql` records every merge. See
  [docs/ENTITY.md](docs/ENTITY.md).
- **P1**: F10 sidecar (`services/finance-analyst`, uv + Python 3.12 +
  Playwright), worker with pg-boss, parallel backfill, A/HK/US verified
  (AAPL / 600519 / 00700). Details in the archive §6 P1.
- **P2**: Postgres 17 as the truth store, Qdrant 1.18 hybrid search, BGE-M3
  dense + in-house BM25 sparse, RRF/DBSF fusion, optional rerank. 102 real
  company profiles are visible; synthetic fixtures are hidden by default.
- **P2.5**: NDX-100 backfill (100/100 research + ingest, ~42 min, 1,428
  profile chunks). Eval: hybrid top-1 100% for ticker / English name / typo /
  pinyin / Chinese name; natural-language 81.3% (recall@5 96.9%); documents
  80% (recall@5 100%). Results in [`docs/EVAL.md`](docs/EVAL.md).
- **P3.1/P3.2**: deterministic extraction of financials/facts/relations;
  inferred relations go to a review queue; company-card API, CLI and 5 MCP
  company tools. See [`docs/EXTRACT.md`](docs/EXTRACT.md).
- **P3.3**: `deep_research` MCP enqueue (API → pg-boss → worker), dsh ACP
  sidebar, Google News RSS ingestion (link-only). See
  [`docs/AGENT.md`](docs/AGENT.md), [`docs/NEWS.md`](docs/NEWS.md).
- **P3.4**: tool-use trajectory + GFM Markdown in the sidebar; turn budget
  fixed (80 calls + repetition detection + forced-answer follow-up); Grok-like
  live activity panel; **UX v3** static work trace with expandable
  search/fetch rows (query, result count, domains, URLs, duration, cited).
  **Session replay** (2026-10-30): dsh's persisted log is folded back into the
  same tool cards on reload. **Session resume** (2026-10-30): after an API
  restart or idle dispose the next prompt resumes the persisted dsh session
  (same id, log and model memory); a failed resume falls back to a new session
  behind a yellow notice. See §6 below.
- **P3.5**: React 19 + Vite 8 web UI (home / search / company 5 tabs / graph /
  NDX index / AI sidebar). See §5.
- **P0 headless cutover (2026-10-31, reversed 14:16)**: worker research now
  defaults to official **DeepSeek `deepseek-flash` + official
  `web_search`/`web_fetch`**. The NIM route
  (`deepseek-ai/deepseek-v4.1-flash` via `apps/worker/src/nim-gateway.ts` +
  Parallel Search MCP) is opt-in with `OCC_LLM_PROVIDER=nvidia`. ACP sidebar
  unchanged.
- **HSI (2026-10-31)**: `config/indices/hsi.yaml` + worker `--universe hsi`;
  A/HK research attaches F10 by default. Full batch done: **59 ready / 26
  needs_review**, 85/85 memberships.
- **ChiNext 50 (2026-10-31)**: `config/indices/cyb50.yaml` + worker
  `--universe cyb50` (`CYB50`, SZSE). Full batch finished **45 ready /
  5 needs_review**; `scripts/backfill-cyb50.sh` runs it. STAR 50 is deferred
  backfill, out of the current plan.
- **Reviewer (2026-10-31)**: `review.company` queue + `company_research_state`;
  official DeepSeek with reasoning on, structured JSON, max 2 revisions, then
  `needs_review`. `occ-backfill states` exposes operator status.
- **Structured F10 relations (2026-10-31)**: A `gdyj` / HK
  `MajorShareholder` / US `gbgd` shareholder rows become `reported`-status
  `owns`/`invests_in` edges when the shareholder is in the company universe;
  page JSON cached under `.occ/f10/`.
- **Structured financial statements (2026-11-01)**: new
  `financials.company` queue + `occ-backfill enqueue financials`. **US is
  EDGAR-only** (`method='xbrl'`, `trust_tier='filing'`); A/HK use F10 `cwfx` /
  `NewFinancialAnalysis` (`method='f10'`, `secondary`); profile facts remain
  the fallback for periods the structured sources do not cover. Pure parsers
  in `packages/extract/src/financials/`; raw caches under `.occ/f10/` and
  `.occ/edgar/`. The Financials-tab UI is shipped (see §5).

Verified numbers worth keeping:

- Visible corpus: **236 researched profiles** (NDX 100, HSI 85 + 4
  discovered, CYB50 50, A500 overlaps); 11 fixture companies / 31 fixture
  documents remain in the DB but hidden. Search also returns **850 A500/SPX
  stubs** with a `未收录` badge.
- Agent regression question (“goog 今天股价大跌，是什么原因？”): **57 s /
  15 tool calls / 7 sources** with a cited Markdown answer after the budget
  fix. The old failure was 32 distinct calls in 95 s with no repeats.
- Graph: AAPL 3 edges, ARM 8, NVDA 14; 2-hop NVDA 26 nodes.
- Search p95 (no rerank): companies 218–300 ms, documents 366–473 ms.
- Build: web main JS 425.39 KB (gzip 130.72 KB), lazy Markdown chunk 162.66 KB
  (gzip 49.05 KB), CSS 53.37 KB (gzip 10.52 KB).

Verified 2026-11-01:

- **P1.1:** `/v1/indices/A500` 500 members (435 stubs now; 447 at P1.1,
  `as_of 2026-10-30`); `/v1/indices/SPX` 500 members (415 stubs, `as_of
  2026-10-29`); exact search
  for `000001` / `平安银行` / `BRK.B` returns the stub with `未收录`; stub
  cards expose `indexMemberships` incl. weight (平安银行 0.398%, AAPL SPX
  7.653269%); all 247 pre-existing company rows are byte-identical after sync;
  rerunning `occ indices sync` inserts 0 rows. Headless Chrome verified the
  search row, both index pages and the placeholder page.
- News sweep `b892648d-…` completed 236/236; AAPL 20/19; 600519 News tab 28
  items; TaskDock active/completed states verified on desktop/mobile/dark.
- Structured financials: AAPL FY2025 416.161B USD (10-K); CCEP FY2025 EUR
  20.901B (20-F); GOOGL gross profit 240.301B (derived); 600519/00700 from F10.
- Graph: 22 reported edges (15 `invests_in`, 7 `owns`) incl. the CK group and
  恒基兆业→香港中华煤气; 64 inferred.
- Search p95 (no rerank): companies 218–300 ms, documents 366–473 ms.

Tests (serial, because parallel vitest workers collide on
`node_modules/.vitest-cache`): `corepack pnpm -r --workspace-concurrency=1 test`.
Current counts: API 33, agent 17, web 33, ingest 46, extract 42, worker 40,
CLI 7, retrieval 10, db 9, storage 5, sources 18 (F10 9 + news 9). All green.

---

## 3. Repo layout

```text
OpenCorpCheck/
  CONTEXT_TRANSFER.md              # this file (active handoff)
  context_transfer_history.md      # verbatim archive of the old long doc
  README.md
  config/
    universe.yaml                  # indices + AI watchlist
    indices/ndx.yaml               # NDX snapshot (official Nasdaq, as_of/license)
    aliases/zh.yaml                # curated Chinese aliases
  docs/
    ARCHITECTURE.md  SEARCH.md  EVAL.md  DATA_SOURCES.md  PRIOR_ART.md
    UI.md  EXTRACT.md  AGENT.md  NEWS.md  ENTITY.md
  apps/
    web/                           # React 19 + Vite 8 consumer UI
    api/                           # Hono + Zod API, SSE agent, OpenAPI
    cli/                           # occ CLI + MCP stdio server
    worker/                        # pg-boss parallel backfill
  packages/
    agent/                         # dsh ACP runtime, event normalization, limits
    core/                          # Zod contracts, types, ULID
    db/                            # Drizzle schema + migrations
    ingest/                        # section/news → documents/chunks → Qdrant
    extract/                       # financials/facts/relations + review queue
    jobs/                          # shared pg-boss queues + run store
    retrieval/                     # tokenizer/BM25/BGE-M3/Qdrant/RRF-DBSF
    storage/                       # S3/MinIO snapshots
    sources/eastmoney-f10/         # F10 adapter
    sources/entity/                # sector taxonomy, F10/EDGAR profiles, GLEIF, Wikidata
    sources/news/                  # Google News RSS adapter
  services/
    finance-analyst/               # Python sidecar: A/HK/US F10 (uv + Playwright)
    embeddings/                    # local BGE-M3 / reranker sidecar
  scripts/
    dev-db.sh dev-qdrant.sh dev-embeddings.sh dev-minio.sh e2e-search.sh
    snapshot-indices.py             # generate A500/SPX YAML from official sources
  phase0/                          # historical proof-of-concept harness + outputs
```

---

## 4. Run it

```bash
# infra (native, no Docker)
scripts/dev-db.sh start
scripts/dev-qdrant.sh start
scripts/dev-embeddings.sh start
scripts/dev-minio.sh start          # optional; S3 snapshots

# build everything, then API + web
corepack pnpm -r build
node apps/api/dist/server.js        # http://127.0.0.1:8787
corepack pnpm dev:web               # http://127.0.0.1:5173 (proxy /v1 → 8787)

# persistent automatic-news worker (separate process)
scripts/dev-news-worker.sh start    # status | stop | restart | logs

# refresh index snapshots, then create/update A500/SPX stubs + memberships
uv run scripts/snapshot-indices.py
node apps/cli/dist/occ.js indices sync [--index A500|SPX|all] [--dry-run] [--json]

# P1.2 sector + identifier enrichment (uses cached F10/EDGAR; reindexes sectors)
node apps/cli/dist/occ.js entities enrich [--dry-run] [--force] [--skip-index]
node apps/cli/dist/occ.js entities coverage [--json]
node apps/cli/dist/occ.js entities resolve [--apply]      # dual-listed A/HK stubs
node apps/cli/dist/occ.js entities gleif [--apply]        # LEI + parent edges
node apps/cli/dist/occ.js entities wikidata [--apply]     # QIDs

# optional F10 sidecar
cd services/finance-analyst && uv run occ-f10 serve --port 8090

# tests (serial!)
corepack pnpm -r --workspace-concurrency=1 test
```

Key env:

| Env | Default |
|---|---|
| `DATABASE_URL` | `postgres://occ@127.0.0.1:5432/occdb` |
| `OCC_QDRANT_URL` | `http://127.0.0.1:6333` |
| `OCC_EMBEDDING_URL` | `http://127.0.0.1:8080` |
| `OCC_FINANCE_ANALYST_URL` | `http://127.0.0.1:8090` |
| `OCC_AGENT_DSH_HOME` | `.occ/dsh-acp-home` (must differ from `phase0/.dsh-home`) |
| `OCC_AGENT_TURN_TIMEOUT_MS` | `180000` |
| `OCC_AGENT_MAX_TOOL_CALLS` | `80` |
| `OCC_AGENT_MAX_REPEATED_TOOL_CALLS` | `4` (`0` disables) |
| `OCC_AGENT_IDLE_TIMEOUT_MS` | `600000` (`0` disables) |
| `DEEPSEEK_API_KEY` / `_FILE` | required by the **headless research worker**, the ACP sidebar, ingest/extraction and the **reviewer** |
| `NVIDIA_API_KEY` / `_FILE` | only for the opt-in NIM route (`OCC_LLM_PROVIDER=nvidia`); `NVIDIA_API_KEY.txt` is gitignored |
| `OCC_LLM_PROVIDER` | `deepseek` (default: official DeepSeek + official search/fetch); `nvidia` opts into NIM + Parallel |
| `OCC_NIM_GATEWAY_PORT` / `OCC_NIM_RPM` | `4010` / `20` |
| `OCC_REVIEW_MAX_CYCLES` | `2` (then `needs_review`) |
| `OCC_F10_RELATIONS` | `on`; `none` disables structured shareholder extraction |
| `OCC_FINANCIALS` | `on`; `none` stops ingest from enqueuing structured statements |
| `OCC_FINANCIALS_CONCURRENCY` | `2` (the F10 sidecar also caps browser concurrency at 2) |
| `OCC_EDGAR_DIR` | `.occ/edgar` (ticker map, companyfacts, submissions) |
| `OCC_EDGAR_CACHE_TTL_MS` | `86400000` (24 h) |
| `OCC_EDGAR_USER_AGENT` | `OpenCorpCheck/0.1 (Bowen Xu; xubowenhaoren@gmail.com)`; SEC requires a contact and ≤10 req/s |
| `OCC_GLEIF_BASE_URL` | `https://api.gleif.org/api/v1` (P1.2) |
| `OCC_WIKIDATA_API_URL` | `https://www.wikidata.org/w/api.php` (P1.2) |
| `OCC_NEWS_SWEEP` | on; `none` disables the automatic sweep (no public refresh control) |
| `OCC_NEWS_SWEEP_CRON` / `_TZ` | `0 7 * * *` / machine timezone |
| `OCC_NEWS_TTL_MS` | `82800000` (23 h; keep shorter than the sweep period) |
| `OCC_NEWS_CLAIM_TIMEOUT_MS` | `1800000` (30 min lease) |
| `OCC_NEWS_SWEEP_BATCH` | `250` |
| `OCC_NEWS_HISTORY_MS` | `259200000` (3 days of sweep history) |
| `OCC_NEWS_PAUSE_AFTER` | `5` consecutive failures → `paused` for one TTL |

`OCC_AGENT_DSH_PATCH` defaults to `.dsh/acp.patch.yml`; pass `none` to disable
the ACP overlay. The overlay sets `reasoningEffort: low` on `llm-deepseek` (ACP
does not read `agent-default-model`; the adapter has no `medium`). `dsh --patch`
replaces an entry's `config` wholesale.

---

## 5. Web UI (P3.5)

React 19 + Vite 8 + TypeScript + React Router 7 + TanStack Query 5. Styles use
the prototype CSS tokens; **no Tailwind/shadcn**. Vite dev binds
`127.0.0.1:5173`, proxies `/v1` to `127.0.0.1:8787`. Production static hosting
is P2 (deferred).

Pages:

- `/` — hero search, hot companies (static list), market shortcuts, NDX entry,
  recent views (`localStorage`).
- `/search?q=` — company hybrid search with market/index/sector filters. Rows
  show name, ticker, country, sector, indices and a two-line description; no
  score/matchType. **A500/SPX stubs are searchable with a `未收录` badge**
  and open the placeholder page (no graph action). Short Chinese queries with
  no exact/alias/fuzzy hit and a low dense score show “没找到 + 问助手” instead
  of unrelated vector neighbours.
- `/c/:ref` — ticker, slug, Chinese alias or ULID. Five tabs:
  基本资料 / 财务数据 / 关系图谱 / 新闻动态 / 资料来源. A `stub` company
  returns a **dedicated read-only placeholder page** (no tabs, no follow/agent
  CTA): names, ticker/exchange, market, index membership + weight, and a
  neutral “尚未收录 / 数据由运营侧批量补充” note.
  - Overview: one-line summary, segment bars, key numbers, recent events, and
    right-column shareholders/investments/related companies.
  - Financials: metric cards (derived values carry a `推导` marker), a
    coverage line (来源 + latest period + fiscal-year end), annual / quarter /
    half / TTM modes, and per-statement tabs (利润表 / 资产负债表 / 现金流量表)
    once a company has more than 12 rows. Each period column carries its source
    badge (`SEC 10-K` / `SEC 10-Q` / `SEC 20-F` / `东方财富 F10` / `研究资料`);
    a cell that differs from the column, or that was calculated, gets its own
    badge, and A/HK 三季报 columns show `累计`. Every value can open its source;
    values stay in native currency.
  - Graph: 1/2 hops, type filter, verified-only, graph/list toggle, zoom/drag,
    node/edge inspector with evidence quote + source, empty state.
  - News: timeline with source popovers.
  - Sources: grouped by trust tier, deduped, copy-all-citations.
- **Top-nav TaskDock** (2026-11-01): last control after `EN` / 深色. Collapsed
  34 px ring with the active sweep's progress and a count badge; expanded card
  shows the active sweep, per-company subtasks (`19 条` / `抓取中` / `队列中`,
  link to `/c/:ticker`) and completed sweeps within the last 3 days. Idle shows
  the last sweep and next due time. **No manual controls**; polling
  `/v1/news/status` is also what lazily starts a due sweep. The News tab adds
  `更新于 … · 自动更新` / `正在更新…` and refetches the card when the cursor
  advances.
- `/graph?company=` — global ego network with company picker.
- `/indices/NDX` / `/indices/SPX` / `/indices/A500` / `/indices/HSI` /
  `/indices/CYB50` — loaded constituent pages. Search index chips are
  `["A500", "SPX", "NDX", "HSI", "CYB50"]`; the index-page switcher is
  `["NDX", "SPX", "A500", "HSI", "CYB50"]`. Stub rows show a `未收录` badge.
  STAR50 has no snapshot (deferred backfill).
- AI sidebar — 35% of page width on desktop (hardcoded `35vw`; was 420 px),
  full-screen on mobile; real
  `POST /v1/agent/sessions` + SSE prompt/cancel; company context; suggestions;
  source chips; GFM Markdown; one live→static trajectory card above the answer.
  The session id is stored in `localStorage` (`occ.agent.sessionId`) and the
  conversation is replayed from dsh's log on reload; “新对话” clears it.
  Prompts after an API restart / idle dispose **resume** the persisted dsh
  session, so the model keeps its memory; if resume fails, a yellow highlighted
  notice sits between the question and the answer.

Themes: light/dark via `data-theme` + `localStorage`; zh/en toggle for UI chrome
and number formatting (company data stays in its source language).

Backend endpoints added with the UI:

- `GET /v1/graph?company=&depth=1|2&status=&types=&limit=` — ego network
  (`center`, `nodes`, `edges`, `truncated`); depth 2 expands up to 40 neighbours.
- `GET /v1/indices/:code` — constituents (NDX/SPX/A500/HSI/CYB50 loaded),
  with ticker/sector/markets/as_of and `coverageTier`.
- `GET /v1/sectors` — industry filter values (fixtures hidden).
- `GET /v1/search/companies` — `sector` filter (and `industry` as an alias).
- `GET /v1/agent/sessions` — persisted dsh sessions for the history menu
  (title, prompt count, updated time; subagent children excluded).
- `GET /v1/agent/sessions/:id/replay` — persisted turns + tool calls from
  dsh's `session.v4.jsonl.zstd`; 404 when no log exists.
- `GET /v1/news/status[?company=<ref>]` (2026-11-01) — active/last/recent news
  sweeps, `dueCount`, `triggered`, `pendingSweep`, next due, TTL/cron, and
  per-company cursor + latest job. Read-only; no `POST /v1/news/refresh`, no
  client-triggered fetch.
- `GET /v1/runs/:id` now includes job `payload` and `meta` (news per-company
  counts) for the task dock.
- `@occ/db` — `listIndexCompanyIds`, `listSectors`, and the news state helpers
  (`listDueNewsCompanies`, `leaseNewsCompany`, `markNewsSuccess`,
  `markNewsFailure`, `getNewsCompanyKey`, `getNewsDueSummary`).
- `@occ/core` — `CompanyGraphQuerySchema`, `CompanyGraphView`,
  `IndexMemberView`, `IndexView`, `CompanyProfileView.indexMemberships`;
  `SearchCompaniesQuery.sector`; `ResearchJobView.payload/meta`.

Known limitations:

- **Ownership coverage is thin:** 22 `reported` edges (15 `invests_in`, 7
  `owns`) + 64 `inferred`. A/HK edges come from F10 shareholder tables; **US has
  no ownership edges**. P1.3 adds US 13F and HKEX DION. P1.2's GLEIF pass adds
  LEI identifiers but found no in-universe parent edges (see below). Do not fake
  edges in the UI.
- **Sector coverage is complete except one HK REIT:** 235/236 researched
  companies have a canonical 11-sector value (`信息技术` … `房地产`); the only
  gap is `HK:00823` 领展房地产投资信托基金 (F10 `EmptyRender`, same documented
  gap as its financials). Stubs intentionally stay `sector = null`.
- **Entity resolution is exact-only:** ticker/CIK/LEI/USCC/ISIN/Wikidata and
  the F10 `H股代码` are deterministic keys; there is no fuzzy merge. 12
  dual-listed A/HK stubs were merged into their researched HK company (e.g.
  中国平安 601318 → 02318, 中国移动 600941 → 00941) and `entity_merge_log`
  records each one. A stub that cannot be confirmed by an exact identifier stays
  separate; do not merge it in the UI by hand.
- **GLEIF parent coverage is sparse for this universe:** 182/236 researched
  companies have an LEI; one real parent edge was written: **Las Vegas Sands
  (SPX stub) → 金沙中国**, with the GLEIF source URL, evidence quote and a
  pending review item. Four other issuers report parents outside the corpus
  (Arm→SoftBank, T-Mobile US→Deutsche Telekom, 中国人寿→中国人寿保险（集团）,
  联想集团→联想控股). The command reports out-of-universe parents instead of
  inventing edges; 13F/DION ownership is P1.3.
- English mode translates UI chrome only; company descriptions stay as sourced.
- Hot companies are a static front-end list; there is no admin backend.
- **News updates are automatic** (2026-11-01): daily `news.sweep` schedule +
  lazy status trigger, `global_news_last_update` cursor, 3-day run history.
  There is still **no refresh button and no POST route** by design. Updates
  progress only while the news worker runs (`scripts/dev-news-worker.sh`).
  The source is Google News RSS, not agentic search, so a refresh costs 0 LLM
  tokens. See [docs/NEWS.md](docs/NEWS.md).
- No Playwright web suite, agent eval or CI yet; acceptance is manual
  (P2 delivery quality).
- Production static hosting (API/nginx same-origin) is still TODO (P2).

More design detail: [`docs/UI.md`](docs/UI.md).

---

## 6. Agent sidebar (dsh ACP)

```text
Browser sidebar (/v1/agent/ui or apps/web)
   │ POST /v1/agent/sessions/:id/prompt (SSE)
   ▼
apps/api AgentService
   │ spawn: dsh --profile acp (stdio, NDJSON JSON-RPC)
   ▼
DshAcpRuntime (packages/agent)
   │ session/new  mcpServers: [{ name: "occ", command: node, args: [apps/cli/dist/mcp.js] }]
   ▼
occ MCP server → OpenCorpCheck API / finance-analyst sidecar
```

API:

```text
POST /v1/agent/sessions                 201 { data: { sessionId } }
POST /v1/agent/sessions/{id}/prompt     text/event-stream
POST /v1/agent/sessions/{id}/cancel
GET  /v1/agent/ui                       dependency-free debug console
```

Normalized events: `run.started`, `assistant.delta`, `thought.delta`,
`tool.called`, `tool.updated`, `plan`, `usage`, `notice` (optional `code`),
`permission.requested`, `session.update`, `run.completed`, `run.failed`
(optional `code`). Raw ACP payloads never reach the browser; tool input/output
is capped at 4 KB / 16 KB before SSE (shape-preserving, `…[truncated]`).
`thought.delta` is deliberately not rendered.

dsh sends tool results as ACP `content` blocks
(`[{type:"content",content:{type:"text",text}}]`) and leaves `rawOutput`
unset. The runtime forwards `content` when `rawOutput` is absent; without that
bridge `tool.updated.output` is empty and every trajectory row loses its
result count, domains and links (found 2026-10-29 while building UX v3).

### Turn budget and limits

- `OCC_AGENT_TURN_TIMEOUT_MS` — wall clock.
- `OCC_AGENT_MAX_TOOL_CALLS` — **80** unique `callId`s (not event counts).
- `OCC_AGENT_MAX_REPEATED_TOOL_CALLS` — **4**; signature is
  `(name, kind, canonicalized rawInput)`. This catches real loops without
  punishing a broad research sweep. The original 30-call cap was a false
  positive: 32 distinct calls, no repeats.
- On a limit: `session/cancel` → wait up to 5 s for `stop` → localized
  `notice` → a second prompt with `maxToolCalls=0` and a 45 s timeout asking
  the model to answer only from gathered evidence. Only if dsh never confirms
  the cancel (or the follow-up still calls a tool) does the turn fail with
  `agent.limit.failed`.
- Idle: `AgentService` disposes the dsh process after
  `OCC_AGENT_IDLE_TIMEOUT_MS`; the UI keeps its session id and the next prompt
  **resumes** the persisted dsh session (same id/log/memory). Only a
  missing/corrupt log starts a fresh session, behind the yellow notice.
- Cancel: Stop button aborts SSE + calls `/cancel`; closing the page sends a
  `pagehide` beacon; **closing the sidebar panel alone does not cancel**.

### Session memory (verified 2026-10-29)

- One browser sidebar holds one session id (`sessionRef`); sending another
  question reuses it. The API keeps the same dsh ACP session, so follow-ups
  share full conversation context.
- Evidence from session `3ae5f035-3e19-48b4-8ed4-c0f765d10c20`: the same
  `session.v4.jsonl.zstd` contains **2 `turn/start` records**; turn 2’s user
  message is the follow-up (“那么，你对谷歌未来有信心吗？”), and its reasoning
  explicitly says “We already have lots” and reuses turn-1 numbers. Turn 1 made
  ~17 tool calls; turn 2 only added 6.
- Memory is **in-memory in dsh**, but the session itself is persistent.
  Idle disposal (10 min default), an API restart or a new browser session now
  **resumes** dsh's persisted session via ACP `session/resume`; only a missing
  or unreadable log starts a fresh dsh session. **Replay ≠ memory** still holds:
  replay is the read-only projection of the log, resume is what restores the
  model context.
- Verified 2026-10-30 (before resume): after an API restart, posting to the
  stored id `9ece6cfe…` then asking “请原样复述我上一条问题” answered
  **“不知道。这是我们对话中的第一条消息”**. That was the old
  `createSession()`-on-miss behaviour and is the regression this task fixed.

### Session resume (2026-10-30)

- Capability probe: pinned `dsh@0.2.1-rc.3` returns
  `agentCapabilities.sessionCapabilities.resume = {}` from `initialize`
  (`list` and `close` too). No dsh bump needed.
- `DshAcpRuntime.resumeSession(sessionId)` sends `session/resume` with the same
  `cwd` + `occ` MCP spec as `session/new`, then attaches the response to the
  SDK's update router. The stable SDK's `attachSession` is private, so one
  narrow cast is confined to that method; the response has **no `sessionId`**,
  so the requested id is injected. A session already live in-process returns
  without a second resume.
- `AgentService.prompt` on a `resolveSession` miss calls
  `findSessionLog(dshHome, sessionId)`: log → resume; no log → create. Resume
  failure → create + `notice` `code: agent.resume.failed` **emitted before
  `run.started`**; the prompt never fails because of it.
- Web: localized notice rendered as a **yellow warning box** between the
  question and the answer (`.msg.system.notice-warn`), light + dark.
- Verified live: one turn → API restart → “请原样复述我上一条问题” returned the
  original question; replay **2 turns**, history **1 row**. Repeated with
  `OCC_AGENT_IDLE_TIMEOUT_MS=1000` (idle dispose). A deliberately corrupt log
  produced `notice(agent.resume.failed)` then a normal answer.

### Does the agent read our DB before answering?

Not enforced, but the system context tells it to prefer `occ` tools, and the
measured run did call them first:

```text
turn 1: search_companies(Alphabet GOOGL) → get_company(GOOGL, events+facts, ~9 KB)
        → search_documents(Q3 2026 earnings/FCF/capex, 8 profile chunks)
turn 2: get_company(GOOGL, financials, 40 rows, ~28 KB)
        → search_documents(Cloud backlog/Gemini/TPU/2027 outlook, profile chunks)
```

`get_company` returns the structured company card (financials/facts/relations/
events); long profile text comes via `search_documents` hits such as
`doc_profile_alphabet_c7`. If DB-first must be guaranteed, add deterministic
orchestration (pre-inject the company card) instead of relying on the prompt.

### Markdown and trajectory UX

- Markdown: `react-markdown@10` + `remark-gfm@4`, lazy-loaded; raw HTML is
  escaped, images become alt text, only http(s) links are allowed, tables
  scroll horizontally. Streaming text is flushed every ~90 ms.
- **One work-trajectory card** (`apps/web/src/components/AgentTrajectory.tsx`)
  sits at the top of every assistant bubble, above the answer, and is the same
  element in both states — it never moves or duplicates below the answer.
  - Live (researching, no answer text yet): rotating orb, “正在研究”, ticking
    steps/elapsed/consulted sources; the group holding the active call opens
    itself, finished groups fold, repeated calls merge by kind
    (“搜索了 3 次网页”, “打开了 9 个网页”, “查找公司 2 次”).
  - Static (answer streaming or finished): same card in place, no spinner;
    header “工作轨迹 · 13 步 · 58s · 5 个来源”, merged group lines closed by
    default, so 20+ calls never become 20+ cards. Opening a group lists its
    calls; each search/fetch row opens to query, status, result count, top
    domains, hit links (new tab) and duration, plus a **已引用** badge when the
    answer cites that URL. “计划与来源” holds the plan, the source ledger
    (已引用 / 仅查阅) and token usage. Pure helpers live in
    `apps/web/src/lib/agent-trace.ts` (`groupToolCalls`, `describeTool`,
    `toolCallLinks`, `isCallCited`, `callDurationMs`).
- Verified end-to-end 2026-10-29 (Playwright + live dsh): live header at 2 步 ·
  8.6s with one auto-open group; finished header 12 步 · 58s · 5 个来源 with the
  card above the answer; search group 3 calls (2 已引用), row body 8 results /
  8 domains / links; no console errors.
- No raw JSON, token stream or `thought.delta`; animations respect
  `prefers-reduced-motion`.
- `deep_research` stays a tool card. A first-class sub-agent card with
  `get_run` polling and nested trajectory is **deferred (2026-10-30): not
  needed for this project**, so there is nothing pending there.

### Session persistence and replay (2026-10-30)

dsh already persists every session; we do not add a database table.

- **Official store**: append-only `SessionEvent` log at
  `<OCC_AGENT_DSH_HOME>/sessions/<project>/<session-id>/session.v4.jsonl.zstd`,
  one checksummed zstd frame per append batch; `SessionHeader` sits beside the
  log (`version`, `cwd`, `parentSession`, `delegationDepth`).
- **Official ACP surface**: upstream `@deepseek-ai/dsh-acp` supports
  `session/list` (paginated, `cwd` filter) and `session/resume` (restores the
  log, **does not replay updates**). It explicitly does **not** implement
  `session/load`, delete, fork or transcript replay. Third-party plugins add
  load+replay, but we stay on the official profile.
- **Our wrapper**: [`packages/agent/src/session-log.ts`](packages/agent/src/session-log.ts)
  locates the log, decodes the **concatenated zstd frames** (Node's
  `zstdDecompressSync` stops after the first frame; we decode each frame and
  concatenate), then folds `user/message` + `assistant/message` + `tool/call` +
  `tool/result` + `turn/end` into turns. Inputs/outputs are capped 4 KB / 16 KB,
  same as live SSE. Read-only.
- **API**: `GET /v1/agent/sessions` lists persisted sessions (title from the
  first question, prompt count, mtime; subagent children excluded). `GET
  /v1/agent/sessions/:id/replay` → `{ turns: [{ prompt, answer, status,
  startedAt, endedAt, calls[] }] }`; 404 if the log is missing.
- **Web**: the dsh session id is stored in `localStorage`
  (`occ.agent.sessionId`); on mount the sidebar replays it into the same
  `AgentTrajectory` + Markdown components. The header’s clock button opens a
  Claude-Code-style history popover (search, title, relative age, prompt
  count, current highlight); picking a row loads that session. “新对话”
  cancels the session, clears the id and returns to the greeting; a 404 clears
  a stale id.
- **Verified 2026-10-30**: replayed the 22-call NVDA/AMD probe (header
  “22 步 · 1m 59s · 6 个来源”; search row 6.9 s / 8 results / 8 domains);
  multi-turn session `3ae5f035…` replayed both turns (17 + 6 calls); live
  “只回复 OK” → reload restored the bubble; history menu listed 31 parent
  sessions, filtered by “茅台”, opened a row and highlighted it.
  `@occ/agent` 14 tests, web 22.
- **Known limits**: replay and resume are per dsh session. After an API
  restart/idle dispose the next prompt resumes the same id and log, so replay
  and the history menu stay on one continuous conversation. A missing or
  corrupt log falls back to a fresh session behind the yellow
  `agent.resume.failed` notice. Child subagent sessions
  (`delegationDepth=1`) are not replayed.

More detail: [`docs/AGENT.md`](docs/AGENT.md).

---

## 7. Data, search and extraction

- **Postgres 17 = truth store + pg-boss queue**, not a search engine.
  Drizzle migrations `0001`–`0005`.
- **Qdrant 1.18** hybrid: dense BGE-M3 + sparse FNV-1a BM25 (`idf` modifier),
  server-side RRF/DBSF, optional `bge-reranker-v2-m3`. Explain mode returns
  BM25/dense branch ranks.
- **Search quality**: ticker / English name / typo / pinyin / Chinese name top-1
  100%; natural language 81.3% (recall@5 96.9%); documents 80% (recall@5 100%).
- **Fixture isolation**: `companies.is_fixture` / `documents.is_fixture` and
  Qdrant payload flags. Search excludes fixtures unless `include_fixtures=true`.
  `occ sync-fixtures` is idempotent and also backfills pinyin aliases.
- **Stubs are not fixtures**: `coverage_tier='stub'` rows (A500/SPX) are
  included in search with a `未收录` badge; they have no embeddings/documents,
  so semantic search never returns them. Exact identifier/alias/fuzzy matches
  do (ticker, Chinese/English name, pinyin).
- **Chinese aliases** are curated in `config/aliases/zh.yaml`; run
  `occ aliases sync` (inserts aliases + pinyin forms and reindexes company
  points). Do not hardcode names.
- **Extraction** (`packages/extract`): deterministic financials/facts/relations;
  relation type whitelist + quote/source validation; inferred relations carry
  evidence and review-queue rows. `OCC_EXTRACT_RELATIONS=llm` enables the LLM
  relation pass (default `none`). **F10 structured relations** run after every
  ingest by default (`OCC_F10_RELATIONS=none` disables): A `gdyj`, HK
  `MajorShareholder`, US `gbgd`; shareholder must already exist in the
  universe; `owns` at ≥50%, else `invests_in`; status `reported` + evidence +
  review queue. Page JSON is cached under `.occ/f10/` and never removes LLM or
  human-reviewed edges.
- **Snapshots** (`packages/storage`): optional S3/MinIO. Without `OCC_S3_*`
  nothing changes. Section markdown and F10 JSON upload as
  `sections/<slug>/<sha>.md` / `f10/<market>/<code>/<page>/<sha>.json`;
  upload failures warn but do not block ingestion.
- **News** (`packages/sources/news`): Google News RSS, link-only, 10 items in
  steady state / 20 cold start, 30-day maximum window, `doc_type='news'`. No
  full-text fetch or redistribution. Ingestion is deterministic and LLM-free.
  **Automatic refresh is implemented** (2026-11-01): `news.sweep` schedule +
  lazy `/v1/news/status` trigger, `global_news_last_update` cursor/lease,
  worker write-back, 3-day history. See [docs/NEWS.md](docs/NEWS.md).
- **F10** (`services/finance-analyst` + `packages/sources/eastmoney-f10`):
  A/HK structured pages (US pages remain technically available but are not
  used for structured financials), per-domain rate limits, table/XHR
  extraction, 2 MB cap, retries + jitter. Eastmoney data is for internal demo
  + attribution.
- **Entity resolution (P1.2, 2026-11-01)**:
  `packages/sources/entity/src/sectors.ts` is the deterministic sector
  taxonomy; `f10-profile.ts` / `edgar-profile.ts` parse identifiers; `gleif.ts`
  and `wikidata.ts` are polite public-API clients with exact-match rules.
  `occ entities enrich` writes sectors + local identifiers; `resolve` merges
  dual-listed A/HK stubs through the F10 `H股代码`; `gleif` / `wikidata` are
  separate, explicit commands. `entity_merge_log` audits every merge. See
  [docs/ENTITY.md](docs/ENTITY.md).
- **Structured financial statements** (`apps/worker/src/financials/` +
  `packages/extract/src/financials/`): `financials.company` fetches F10
  `cwfx` (HK `NewFinancialAnalysis`) for **A/HK only** and SEC EDGAR
  `companyfacts` + `submissions` for **US only** (decision 42). EDGAR parses
  `us-gaap` and `ifrs-full` and picks one reporting currency per company. Pure
  parsers return canonical facts; the worker upserts `financial_facts` with
  method precedence (`xbrl` > `f10` > profile), passing the incoming method's
  own rank so a lower-precedence pass cannot clobber a dual-listed company's
  filing rows. Missing subtotals (`gross_profit`, `total_liabilities`) are
  derived and marked with a `计算：` quote. Values stay in native units; profile
  rows within ±7 days of a structured period are removed so 52/53-week filings
  do not duplicate columns. EDGAR needs `OCC_EDGAR_USER_AGENT` with a contact
  and uses a global 110 ms limiter.

---

## 8. Key decisions (active)

1. **TypeScript everywhere**, except the Python + Playwright F10/EDGAR/HKEX
   sidecar.
2. **Qdrant** for hybrid retrieval; pgvector/ParadeDB are fallbacks. Do not turn
   Postgres into the search engine.
3. **dsh headless** for company research (operator-invoked; a batch is explicit
   and capped, never a full-index sweep); **ACP** for the interactive sidebar.
4. **Official DeepSeek everywhere by default (revised 2026-10-31 14:16)**.
   Interactive ACP sidebar = official **DeepSeek API + `deepseek-official`
   search/fetch**. Local **headless backfill/worker pool** = official
   **DeepSeek API + official `web_search`/`web_fetch`**. NIM
   (`deepseek-ai/deepseek-v4.1-flash` + Parallel Search MCP) is opt-in via
   `OCC_LLM_PROVIDER=nvidia`; it hit sustained per-model 429s during the HSI
   batch and is not the default. Never write `deepseek-v4-pro` back into
   config. The DeepSeek key stays in the repo; the coding session keeps its
   own copy.
5. **No Docker on this machine**; use native services. Cross-platform support
   (macOS + WSL2/Linux) is still required; Docker/Electron are **P2**.
6. **Universe scope**: ChiNext 50 + HSI + NDX are done; **A500 + S&P 500 are
   searchable placeholder pages (done 2026-11-01)** with no bulk research;
   STAR 50 and remaining HSI/CYB50 coverage are **backfill, out of the current
   plan**. NDX is done; A/HK profiles are done.
7. **F10 reuse** (Apache-2.0 attribution); do not bulk redistribute Eastmoney.
8. No full port of `opportunity-radar`; keep the distilled BFS/DFS + citation
   discipline.
9. **Read-only by default**: the agent may `propose_fact` / `propose_relation`
   into the review queue only.
10. **Backfill is parallel + resumable**: pg-boss + worker pool + per-domain
    limits + checkpoints. Never serialize the whole universe.
11. **Commit directly on `main`** (user preference); temporary branches only
    for isolated experiments, deleted after merge.
12. **Fixtures are isolated, not deleted**: keep them for E2E/mock pipelines,
    hide them from default search.
13. **Curated Chinese aliases** via YAML + `occ aliases sync`; don’t rely on the
    model guessing 奈飞/好市多.
14. **S3 snapshots are optional**; configure `OCC_S3_*` to enable, failures
    must not block ingestion.
15. **API and worker share `@occ/jobs`**; add new queues/run kinds there first.
16. **ACP and headless use different `DSH_HOME`s** (zstd ACP vs plaintext
    Phase 0); sharing causes `session/new` backend errors.
17. **News is a link-only coverage layer**; don’t treat RSS summaries as
    audited facts or redistribute full text.
18. **Trajectory is one card above the answer, progressive disclosure, not a
    debug panel**: the same element goes live → static in place (never a second
    block below the answer, never 20 cards); no raw JSON/token/CoT. Sub-agents
    should reuse the `deep_research` pg-boss job rather than inventing a sync
    protocol.
19. **Tool output crosses the ACP boundary as `content`**: dsh's generic tool
    calls set `content`, not `rawOutput`; the runtime must forward either or
    the sidebar cards are empty. Keep the bridge in `mapUpdate`, not the UI.
20. **Web UI keeps prototype CSS tokens**; no Tailwind/shadcn without an
    explicit migration that preserves tokens. Web-first, no OS branches.
21. **Search relevance guard lives in the UI**: short Chinese queries with no
    exact/alias/fuzzy hit and dense < 0.35 show “没找到 + 问助手”; API/CLI
    results stay raw for eval.
22. **Graph layout adapts to node count**: ≤6 nodes 800×640 (magnified), >6
    nodes 960×720; direct neighbours on an equal-angle ring, colour by relation
    family.
23. **Agent budget is budget + repetition, not a flat call count**:
    `OCC_AGENT_MAX_TOOL_CALLS=80`, `OCC_AGENT_MAX_REPEATED_TOOL_CALLS=4`,
    forced-answer follow-up, `reasoningEffort=low`, idle dispose. Closing the
    sidebar does not cancel; closing the page does.
24. **Synthetic seed fixtures remain on A500/SPX** for E2E compatibility even
    though the v1 backfill scope changed. Do not reseed the real corpus with
    `occ seed` just to rename fixture memberships.
25. **Session persistence belongs to dsh; replay is a read-only projection,
    resume is the official memory path**. Read `session.v4.jsonl.zstd` and fold
    it into the existing tool-card model instead of adding an `agent_sessions`
    event table. Resume with ACP `session/resume` whenever a log exists; never
    silently substitute a fresh session. Upstream `dsh-acp` has `session/list`
    + `session/resume` but no `session/load`/replay. Keep the wrapper in
    `packages/agent`, not the web. Child subagent sessions are out of scope.
26. **Resume failure is visible, never silent**: fall back to a new dsh session
    and emit `agent.resume.failed` before `run.started`; the web renders it as
    a yellow box between the question and the answer. Do not claim the previous
    context survived.
27. **No first-class sub-agent card** (decision 2026-10-30): this project does
    not need it; `deep_research` remains a normal tool card. Treat it as
    deferred permanently for v1, not as missing work. This does not affect
    child-session replay/resume, which is separately out of scope.
28. **News refresh is RSS-only and LLM-free** (decision 2026-10-30): the
    refresh path reuses the Google News RSS adapter and local embeddings, so it
    costs **0 LLM tokens**. No summarization/review agent in this path;
    add AI summaries as a separate, explicitly opt-in feature later.
29. **News refresh is automatic, idempotent and server-deduped** (revised
    2026-11-01): a **daily** pg-boss schedule (`OCC_NEWS_SWEEP_CRON`, default
    `0 7 * * *`) runs a sweep that selects due companies from
    `global_news_last_update` (per-company key `US:AAPL` / `A:600519` /
    `HK:00700` / `NAME:<slug>`, `last_update_at` + `next_due_at` lease) and
    enqueues one `news.company` job per company. An advisory lock makes
    concurrent sweeps a no-op; the lease (claim timeout) recovers jobs lost
    with a worker crash. The public UI has **no refresh control** and there is
    no client-triggered sweep. Article-level dedupe stays title+snippet hash
    (unchanged items skip embedding). TTL is 23 h (deliberately shorter than
    the 24 h period) so every company is due each day; cron, TTL and batch are
    configurable as a set.
30. **Placeholders are first-class, searchable rows** (revised 2026-11-01):
    `coverage_tier='stub'` (the schema has **no `is_placeholder` column**; do
    not add one), only ticker + Chinese/English names + market + index
    membership. They **must appear in search** with a `未收录` badge — exact
    ticker/name matches always; semantic results may include them but rank
    below real profiles. Opening a result shows the read-only placeholder page.
    Never fabricate profile data and never overwrite a real profile. The
    earlier “exclude from default search” rule is cancelled.
31. **Batch research uses our own durable queue, not a DSH batch plugin**
    (decision 2026-10-30): pg-boss is the queue/retry/progress store and a
    worker pool runs one `dsh --profile headless` process per company. The DSH
    ecosystem has no production-grade batch pipeline; do not add one.
32. **Reviewer is a second agent with a bounded loop** (decision 2026-10-31:
    **official DeepSeek, reasoning on**): a hidden headless review checks
    evidence and completeness; `revise` re-runs research at most twice, then
    `needs_review`. It runs on the paid official API because (a) its whole
    value is judgment, (b) NIM only returns reliable structured output with
    `thinking:false`, which is the opposite of what a reviewer needs, and
    (c) volume is 1–3 runs per company. A failed reviewer would block `ready`,
    so reliability matters more than the marginal cost. Never show reviewer
    internals or fake success in the UI.
33. **One shared task dock, news-only** (decision 2026-10-31, revised
    2026-11-01): the **top-nav** control (last item after `EN` / `深色`) has
    exactly one producer, the automatic news sweep (badge “更新新闻”). No
    `company_research` rows, no filter tabs, and **no retry/review buttons**
    (failures retry automatically). The production dock shows the active sweep,
    the last completed one, and completed sweeps from the **last 3 days**; it
    drops all manual controls. The prototype (commit `dd465fc`) is the visual
    reference only.
34. **No in-app on-demand stock research** (decision 2026-10-31): the
    placeholder CTA and `POST /v1/companies/:ref/research` are cancelled.
    Research is operator-initiated through the local worker pool (explicit,
    capped batches). On-demand **news refresh is cancelled** (2026-11-01):
    news is fully automatic ([docs/NEWS.md](docs/NEWS.md)), so no public
    control can trigger a fetch. The operator CLI stays.
35. **Step-level retry belongs to the NIM client, not the job queue**
    (decision 2026-10-31): NIM throws episodic 500s and sometimes returns an
    empty `content`; retry 3× with backoff and normalise
    `reasoning_content → content` in one place (gateway or client). pg-boss
    retries are the outer net only — a whole-run retry re-burns tokens.
36. **LLM relation extraction stays on official DeepSeek with reasoning on**
    (decision 2026-10-31): quality over cost for the fact/relation layer;
    volume is low and it already works. Do not move it to NIM in this
    migration.
37. **Headless NIM retry lives in one local gateway** (decision 2026-10-31):
    `apps/worker/src/nim-gateway.ts` is an OpenAI-compatible proxy that
    retries 500/502/503/504 and empty-`content`, normalises
    `reasoning_content → content`, and enforces `OCC_NIM_RPM`. `work
    --queues research` starts it; no other process may need NIM details.
38. **Reviewer is a hidden second headless run, not a UI feature** (decision
    2026-10-31): official DeepSeek with reasoning on, structured JSON, max
    `OCC_REVIEW_MAX_CYCLES` revisions then `needs_review`. It gets
    `DEEPSEEK_API_KEY` only; research gets `NVIDIA_API_KEY` only. Operator
    visibility is `occ-backfill states`, not the public UI.
39. **F10 shareholder edges are additive and universe-bounded** (decision
    2026-10-31): only shareholders already in `companies` become relations;
    out-of-universe names are counted, never fabricated as companies. Status is
    `reported` (not `inferred`) because the row is a direct table, but a human
    decision is still the only path to `verified`.
40. **Structured financials use one canonical row with source precedence**
    (decision 2026-11-01): SEC EDGAR XBRL (`xbrl`, `trust_tier='filing'`) beats
    F10 (`f10`, `secondary`) beats the research profile. The existing
    `financial_facts_uq` stays `(company, statement, item, period_end,
    period_kind)`; do not add a source discriminator until a conflict view is
    actually scheduled. The structured run passes the incoming method's own
    rank (`xbrl` 30, `f10` 20), so a profile re-run or an A/HK F10 pass cannot
    clobber filing data — including for dual-listed companies where a US EDGAR
    row and an HK F10 row share a period. Values are native units; the
    EDGAR-vs-F10 comparison is retired with the US F10 leg (decision 42) and
    now always records zeros.
41. **Dead-letter updates are queue-scoped** (decision 2026-11-01): the
    `financials.company` job reuses the company key (`US:AAPL`), so
    `markJobDeadByKey` filters by the originating queue. Without that, a dead
    financials job could mark the research/ingest job row dead. Enrichment
    dead queues (`financials`, `f10`, `news`) never touch
    `company_research_state`; only research/ingest/review do.
42. **US structured financials are EDGAR-only** (decision 2026-11-01,
    **executed 2026-11-01**): remove US F10 fetching/writing and delete existing
    US `f10` rows. F10 remains the A/HK structured layer. EDGAR covers
    `ifrs-full` and derives `total_liabilities = assets - equity` and
    `gross_profit = revenue - cost_of_revenue` where the taxonomy omits the
    subtotal. Rationale: SEC filings are the primary source; F10 US is a
    secondary repackaging with cumulative quarters and mapping differences
    (7.0% of 5,835 comparable cells differ >1%, concentrated in SG&A, capex,
    gross profit, liabilities and near-zero net income), and it adds no
    independent information. Keep the generic F10 parser for A/HK.
    Executed as: `run.ts` never calls `loadF10` for US; **2,053** US-page
    `f10` rows deleted by `sources.url LIKE '%PC_USF10%'` (the 160 HK-sourced
    rows for dual-listed 阿里巴巴 were kept); `ifrs-full` merged in
    `edgar-xbrl.ts` with a single reporting currency per filing; NDX is
    100/100 `xbrl` after rerun `7dacfac0-ce2c-4d61-983a-f180a1f1c23b`.
43. **Derived financial cells are marked by their quote** (decision
    2026-11-01): a calculated cell (`gross_profit`, `gross_margin`,
    `total_liabilities`, `free_cash_flow`) always starts its `quote` with
    `计算：` and has confidence < 1. No `derived` column is added; the Financials
    tab detects the marker (`isDerivedFact`) and shows a `推导` badge. Never
    render a derived cell as a reported line, and never derive without both
    inputs for the same period. `total_equity` prefers the NCI-inclusive
    concept so `assets - equity` is an exact liabilities figure.
44. **News refresh state lives in `global_news_last_update`** (decision
    2026-11-01): one row per company keyed by the worker's canonical target
    string (`US:AAPL`, `A:600519`, `HK:00700`, `NAME:<slug>`) with
    `last_update_at` (last successful check, including an empty one),
    `newest_published_at` (incremental hint), `last_status`,
    `consecutive_failures`, `last_enqueued_at` and `next_due_at` (lease + next
    schedule). The sweep source is `companies` LEFT JOIN this table, so rows are
    created lazily and no registry/backfill is needed; fixtures and stubs never
    get a row. Do **not** add `companies.news_updated_at`. Manual refresh is
    cancelled (decision 34).
45. **The UI observes, the server triggers** (decision 2026-11-01): the dock
    polls `GET /v1/news/status`; that request may lazily enqueue the
    `news.sweep` producer when `dueCount > 0` (skipped while a sweep is queued
    or the latest run is still progressing; `triggered` makes the dock poll
    every 5 s until the run appears). There is still no public refresh control
    and no POST route. This is how “open the site and news is already refreshing” works
    without a button. Sweeps progress only while a news worker runs; the
    persistent local pool is `scripts/dev-news-worker.sh`.
46. **News history is kept for 3 days** (decision 2026-11-01): news
    `backfill_runs`/`backfill_jobs` are pruned at `OCC_NEWS_HISTORY_MS`
    (259,200,000) so the dock can show completed sweeps after an absence
    without growing forever. The cursor table itself is not pruned; it is the
    scheduling truth. Per-job `inserted`/`skipped` live in
    `backfill_jobs.meta`.
47. **Index snapshots are generated, not hand-edited** (decision 2026-11-01):
    `scripts/snapshot-indices.py` downloads official CSI A500 constituent +
    weight workbooks and, for SPX, SPDR S&P 500 ETF (SPY) daily holdings plus
    the SEC ticker→exchange/CIK file. The committed YAML records `as_of`,
    source URLs and license; refresh by rerunning the script. `occ indices
    sync` resolves a constituent by ticker+exchange → CIK → ticker id → exact
    name/alias, and **never updates an existing company row**. Fuzzy entity
    resolution is P1.2, not the sync command. SPX share-class weights are
    summed into one company-level membership weight.
48. **One coarse sector taxonomy, vendor labels as provenance** (decision
    2026-11-01): `companies.sector` holds one of 11 GICS-like Chinese sectors
    (`gics-like-11@1`). The vendor's granular label and the deterministic rule
    live in `companies.profile.industry` / `sectorSource`. A/HK use Eastmoney
    F10 `所属东财行业` / `所属行业`; US uses F10 `所属行业` then SEC SIC.
    Unknown labels stay null and are reported; stubs stay sector-null. Do not
    add a second competing taxonomy without a migration plan.
49. **Identifiers are exact entity keys, never fuzzy** (decision 2026-11-01):
    `company_ids` uses `(id_type, id_value)` as a global key. P1.2 adds
    ISIN/USCC/LEI/EIN/Wikidata + normalized domains; an identifier owned by
    another company is a conflict, not an overwrite. A merge requires a
    structured proof (F10 `H股代码` pointing at a researched HK security) and
    writes `entity_merge_log`; name similarity is only a candidate filter.
50. **GLEIF edges are additive and universe-bounded** (decision 2026-11-01):
    resolve LEI by exact legal/other name (active, general category only),
    follow `direct-parent` then `ultimate-parent`, and create `parent_of` only
    when the parent already exists in `companies`. Every edge is `reported`
    with a GLEIF source URL + quote and a review-queue item; out-of-universe
    parents are counted and listed, never fabricated. GLEIF parent data is
    sparse, so zero in-universe edges is a valid outcome.
51. **Wikidata is a conservative QID enrichment** (decision 2026-11-01):
    accept a QID only for an exact normalized label whose description is
    company-like; ambiguity is reported, not guessed. It is a separate
    `occ entities wikidata` command so deterministic daily paths never depend
    on it.

---

## 9. Known pitfalls

| Pitfall | Handling |
|---|---|
| dsh is a developer preview; interfaces change | Pin `0.2.1-rc.3`; spawn/parse only in `lib/dsh.mjs` / `packages/agent`. Try rc.4 when broken. |
| ACP `session/new` fails with an `Internal error` / zstd vs jsonl mismatch | ACP must use its own `OCC_AGENT_DSH_HOME` (`.occ/dsh-acp-home`); never point it at `phase0/.dsh-home`. |
| Sidebar hangs / no answer | `reasoningEffort: low` + timeout + 80-call budget + repetition guard + forced-answer follow-up. The live trajectory card shows steps/sources. |
| Trajectory rows have no result count/domains/links | dsh sends results as ACP `content`, not `rawOutput`; `mapUpdate` forwards `content` when `rawOutput` is absent. Restart the API after changing `packages/agent` (the API loads its `dist`). |
| Legitimate research stopped by the tool cap | Do not lower 30 back. The 2026-10-29 failure was 32 distinct calls. Use the repetition guard for loops. |
| npm `~/.npm/_cacache` not writable | Use `OCC_NPM_CACHE` / `$TMPDIR/occ-npm-cache`; don’t inherit `npm_config_cache`. |
| Python 3.9 vs F10’s 3.10+ | `uv` + Python 3.12 in `services/finance-analyst`; container image is TODO. |
| Docker unavailable on this VM | Native scripts only (`dev-db`, `dev-qdrant`, `dev-embeddings`, `dev-minio`). |
| WSL2 repo under `/mnt/c` is slow / file watching fails | Put the repo on the WSL2 Linux filesystem; use localhost forwarding from Windows. |
| Scripts assume macOS | New scripts must work on Darwin and Linux; `dev-qdrant.sh` picks the binary by `uname`; `dev-db.sh` uses `PGBIN` or PATH. |
| `scripts/e2e-search.sh` runs `occ seed --reset` (wipes target DB + Qdrant) | Never run against the real corpus; use `scripts/e2e-search.mjs` or disposable resources. |
| Fixture-only companies (OpenAI/CATL/Cambricon) missing from search | By design; use `include_fixtures=true`. They become visible after real research. |
| Chinese common names not found | Add to `config/aliases/zh.yaml`, then run `occ aliases sync` (reindexes company points). |
| MinIO `dl.min.io` returns 410 | `brew install minio` or set `MINIO_BIN`. |
| Snapshot hash mismatch | Re-run `occ ingest --force` before `occ snapshots upload`; don’t upload different content. |
| Review accept/reject semantics | Only `pending` moves; accept relation → verified, accept fact → `facts` row + proposal source, reject relation → rejected. Batch needs `--ids/--kind/--company/--all --yes`. |
| `deep_research` returns 400 for private companies | It requires a recognized exchange listing. Private companies go through CLI/backfill; P1.2 identifier resolution covers listed entities, not private ones. |
| `deep_research` is async | Poll `get_run`; research completion automatically enqueues `ingest.company`. |
| News ingestion says `company not found` | Ingest the company profile first. |
| Google News RSS is link-only, ~10/company | Don’t fetch/redistribute full text; add a separate adapter for bodies. |
| News rerun shows `skipped=5` | Idempotent title+summary sha256; not a failure. |
| Automatic news sweep finished but the UI is stale | The News tab invalidates the company query when `lastUpdateAt` advances; the dock refetches `/v1/news/status`. If a cached response still looks old, wait one poll (≤60 s) or reload. Do not pass `force=true` for unchanged items. |
| Concurrent sweeps duplicate jobs | The advisory lock makes a second producer a no-op, `next_due_at` is leased before enqueue, and the API skips enqueueing while a sweep is queued or the latest run is still progressing. |
| Placeholders and search | Stubs are **searchable** with a `未收录` badge (decision 30); rank them below real profiles and never render fake metrics. Exact ticker/name must always find them; opening the row shows the read-only placeholder page. |
| Reviewer/research loop never ends | Cap at 2 revise cycles, then `needs_review`; every attempt is logged. Never retry unbounded. |
| Reviewer keeps rejecting a stable profile | `needs_review` is the honest outcome; fix the section manually (or improve the research prompt) and re-review. Do not silently flip it to `ready` or raise the cap in production. |
| NIM request hangs | The gateway aborts at `OCC_NIM_REQUEST_TIMEOUT_MS` (default 600 s) and retries. The old no-timeout gateway could sit on one call for 10+ min; keep the timeout. |
| Two workers share the gateway, then one exits | The owner closes the port. Run `node apps/worker/dist/nim-gateway-server.js` for a standalone gateway, or rely on the reusing worker's health re-check to start its own after the port frees. |
| Reviewer has no filesystem/shell | `phase0/reviewer.patch.yml` disables tool-bash/fs/jobs/subagent/skill on purpose; it should only read the supplied profile and cited URLs. |
| Tempted to add a DSH batch plugin | Don’t. pg-boss + worker already provide durability, retries, concurrency and progress; DSH is only the per-company executor. |
| `pnpm -r test` hits `ENOTEMPTY` on `.vitest-cache` | Run with `--workspace-concurrency=1`. |
| API holds a pg-boss connection | Stop with SIGTERM; `kill -9` can leave jobs active until expiry. |
| Same chat session after idle | Memory lives in dsh; idle dispose/restart resumes the persisted session, so context survives. If resume fails, expect the yellow `agent.resume.failed` notice. |
| Agent may answer from web without DB | Prompt says DB-first but does not enforce it. Add orchestration if determinism is required. |
| Replay returns only the session header / one record | dsh writes concatenated zstd frames and Node's `zstdDecompressSync` stops at the first frame. Use `decompressSessionLog` (decodes every frame, ignoring false magic bytes). Verified against `zstd -dc` on 30 logs. |
| Replay after API restart misses the newest turn | Fixed 2026-10-30: the next prompt resumes the same dsh session, so replay keeps both turns. If you see a split, the log was missing/unreadable and the yellow notice explains it. |
| Model says “这是第一条消息/不知道” after a restart or 10 min idle | Should not happen after resume; if it does, check that `OCC_AGENT_DSH_HOME` still points at the home containing the log and that dsh advertises `sessionCapabilities.resume`. The UI shows the yellow notice when resume fails. |
| Resume fails (`agent.resume.failed`, yellow box) | Expected fallback: started a fresh dsh session; old transcript remains visible but is no longer in model context. Check the log exists and is a valid zstd session log. |
| Replay 404 after changing `OCC_AGENT_DSH_HOME` | The UI drops `occ.agent.sessionId` on 404 and starts a fresh conversation. |
| Replayed question shows the injected context/company line | `session-log` strips at 「用户问题：」; `apps/web/src/lib/agent-replay.ts` strips the company prefix. Keep both in sync if the prompt format changes. |

---

## 10. Next tasks — active plan (2026-11-01)

> **Scope rule:** P1 is the only active list. **Backfill is out of scope**
> (STAR 50, any remaining HSI/CYB50 gaps, A500/SPX bulk research). Delivery/
> engineering quality is P2 and explicitly deferred. Do not start P2 before P1
> is accepted.
>
> **Cancelled / permanently deferred** (do not re-propose): manual news
> refresh, on-demand research, page-entry nudge, first-class sub-agent card,
> AI news summaries/full-text fetch, account system, K-line/portfolio, graph
> editing, financial trend charts, Docker/Electron (P2).

### P1.1 — A500 + S&P 500 placeholder layer ✅ done 2026-11-01

Shipped end-to-end; no migration:

- `config/indices/a500.yaml` — 500 CSI A500 constituents (official CSI
  constituent + weight workbooks, `as_of 2026-10-30`, weights `2026-09-30`;
  Chinese + English names, SSE/SZSE, weight).
- `config/indices/sp500.yaml` — 503 securities / 500 companies (`as_of
  2026-10-29`; SPY daily holdings fallback + SEC ticker→exchange/CIK; the 3
  dual-class issuers are one company with `primary: false` on the lighter
  class; share-class weights summed per company).
- Both files are generated by
  [`scripts/snapshot-indices.py`](scripts/snapshot-indices.py) (`uv run …`);
  the script records source URLs and license notes.
- `occ indices sync [--index A500|SPX|all] [--file path] [--dry-run]
  [--json]` creates `coverage_tier='stub'` rows for unresolved primaries
  (447 A500 + 415 SPX), inserts ticker/CIK identifiers, names + pinyin
  aliases, securities and index memberships/weights; an existing company
  only gains a missing security and the membership. Idempotent (second run
  inserts 0); all 247 pre-existing company rows verified byte-identical.
- UI: search/index filter codes include A500/SPX; results and index rows show
  `未收录`; `/c/:ref` returns a dedicated read-only placeholder page (names,
  ticker, market, index + weight, neutral note; no tabs/CTA/graph link).
- Verified: `/v1/indices/A500|SPX` 500 members; `000001`/`平安银行`/`BRK.B`
  exact search returns the stub; 平安银行 weight 0.398%; headless Chrome
  checked search, both index pages and the placeholder page; tests green.
- Known follow-up: stub entity resolution is exact-only; P1.2 identifiers
  resolved cross-listed duplicates (e.g. 中国平安 A-share vs HK profile) — see
  below.

### P1.2 — Industry classification + entity resolution ✅ done 2026-11-01

Shipped end-to-end; migration `0009_entity_merge_log.sql`:

- New `packages/sources/entity`: `gics-like-11@1` sector taxonomy, Eastmoney
  F10 A/HK/US industry mapping + SEC SIC fallback, F10 profile parser
  (ISIN/USCC/`H股代码`/domain), EDGAR submissions parser (SIC/LEI/EIN),
  GLEIF LEI client + exact-name matcher, Wikidata exact-label matcher, and
  text/identifier normalization. 29 unit tests.
- `occ entities enrich`: **235/236 researched companies** now have a canonical
  sector (99.6%). The only gap is `HK:00823` 领展房地产投资信托基金 (F10
  `EmptyRender`). Vendor label, rule, URL and timestamp are stored in
  `companies.profile.sectorSource`; 235 Qdrant company points were reindexed;
  240 F10 profile pages are cached under `.occ/f10/`.
- Identifiers inserted with 0 conflicts: ticker 236/236, CIK 100 (US only),
  domain 229, ISIN 184, USCC 64 (A-share; two red-chip A listings have no USCC
  by source), EIN 91. A-share F10 pages do not expose ISIN, so 52 ISINs are
  absent by source. See `occ entities coverage`.
- `occ entities resolve --apply`: 46 candidate stubs, **12 confirmed merges**
  through the structured `H股代码`: 中国人寿, 招商银行, 中国移动, 中国石化,
  中国神华, 海尔智家, 工商银行, 美的集团, 中国石油, 中国平安, 药明康德,
  紫金矿业. Survivors keep both listings + index memberships (e.g. 中国平安
  HKEX:02318 + SSE:601318, HSI + A500); 850 stubs remain; `entity_merge_log`
  has 12 audited rows. Exact A-share tickers now resolve to the real profile.
- `occ entities gleif --apply`: **182/236 researched LEIs** (54 unmatched, 0
  ambiguous) plus 1 stub parent LEI. **1 in-universe `parent_of` edge written:
  Las Vegas Sands (SPX stub) → 金沙中国**, with the GLEIF source URL, evidence
  quote and a pending review-queue item. Four other issuers report parents
  outside the corpus (SoftBank, Deutsche Telekom, 中国人寿保险（集团）,
  联想控股); those are reported, never fabricated.
- `occ entities wikidata --apply`: **98/236 QIDs** resolved (138 unmatched,
  0 ambiguous, 0 request errors) with conservative exact-label matching after
  corporate suffixes; ambiguity is reported, never guessed. The client retries
  429/5xx with backoff.
- UI/API: `GET /v1/sectors` now returns the 11 canonical values;
  `search?sector=` (with `industry` as an alias) filters sensibly; company
  pages show the sector. `/c/601318` resolves to 中国平安 with both tickers and
  HSI + A500.
- Stubs stay sector-null; no stub was researched or given fake metrics.

### P1.3 — Investment/ownership graph depth

**Goal:** the investment graph stops being a stub.

- US 13F institutional holdings and HKEX DION substantial-shareholder notices
  become `owns` / `invests_in` / `parent_of` edges when the holder is already
  in the universe (same additive, universe-bounded rule as F10 relations —
  never fabricate companies). Broaden A/HK ownership beyond F10 top-10 where a
  public source exists.
- Every edge keeps `reported` status, evidence quote, source URL and the review
  queue path; human review is still the only route to `verified`.
- Acceptance: per-market coverage report (matched vs out-of-universe holder
  counts); new edges visible in the graph with evidence; no duplicate edges;
  no fabricated holders.

### P1.4 — Official filing adapters

**Goal:** announcements and filing-level events, not just F10/research/news.

- CNINFO / SSE / SZSE announcements, HKEXnews (title + PDF link, follow PDF),
  HKEX DION, company IR RSS, GDELT.
- Ingest into the existing `documents`/`sources`/`events` model; link-only /
  official-first; dedupe by canonical URL + content hash; no paywall bypass or
  bulk redistribution.
- PDF extraction for announcements/annual reports: text + tables with page
  provenance; no LLM required for ingest; deterministic extraction is fine.
- Acceptance: sample companies in A/HK/US show official announcement events;
  every event opens the filing; re-ingest is idempotent; licenses/robots
  respected.

### P1.5 — Daily company-data / financial-report refresh (automatic, pure code)

**Goal:** every company is checked daily for new filings; when a new periodic
report appears, the deterministic financials pipeline re-runs and the company
page reflects it. Reuse the news sweep architecture (cursor + lease + run +
worker + status). **This item is pure code and 0 LLM tokens.** Agent fallback
is a separate P2 item and is not required for P1.5.

**Detection is code, not judgment:**

- **US**: SEC EDGAR `submissions` filing index (`form`, `filingDate`,
  `accessionNumber`, `primaryDocument`). A new 10-K/10-Q/20-F/40-F triggers
  `financials.company` for that period; a new 8-K becomes announcement
  metadata (P1.4).
- **A-share**: CNINFO announcement query (年报/半年报/季报) plus SSE/SZSE
  announcement lists; PDF URL.
- **HK**: HKEXnews title search (annual/interim/quarterly results); PDF URL.
- **Fallback**: F10 `cwfx` page hash for companies without a usable official
  feed.
- Detection is a set diff on accession/announcement ID or content hash — a new
  ID means “check”, not “ask an LLM”.

**Cadence:** the daily loop covers filing indexes (the part that actually
changes). Basic profile/description/sector refresh runs on a slower cadence
(weekly/monthly) and only re-extracts when the source hash changes; it is not
part of the daily filing poll.

**Data model:**

- `company_filing_state` (one row per company + source): `cursor` (last
  accession or content hash), `last_checked_at`, `last_changed_at`,
  `next_due_at`, `consecutive_failures`, `last_status`.
- `filings`: `company_id`, `source`, `accession`, `form`, `filed_at`,
  `period_end`, `url`, `content_hash`, `status`
  (`detected|fetched|parsed|applied|failed`); unique `(source, accession)`.

**Jobs:**

- `data.sweep` (daily, singleton + advisory lock) selects due
  company/source rows and enqueues `data.source.check`.
- `data.source.check` fetches the index, diffs `filings`, inserts new rows and
  enqueues `financials.company` (periodic report) or `ingest.filing` (P1.4
  announcement), then stamps the cursor. It never re-fetches unchanged filings.
- Existing `financials.company` stays deterministic and LLM-free.

**Concurrency:** `data.sweep` is a singleton producer (advisory lock), not the
work. Actual checks run as concurrent `data.source.check` jobs
(`OCC_DATA_CONCURRENCY`, default 4) and the existing `financials.company`
queue (`OCC_FINANCIALS_CONCURRENCY=2`; the F10 sidecar caps browser
concurrency at 2, and EDGAR has a per-process 110 ms global limiter). Multiple
worker processes are allowed, but keep the aggregate financials request rate
polite — one financials process per host is safest because the EDGAR limiter
is per process.

**UI:**

- Company page shows the latest filing line (“财报更新于 … / 最新报告
  2026-09-30 (10-Q)”) from `filings`; no fake data.
- The top-nav TaskDock stays **news-only** for the first cut (decision 33).
  If the product wants a “财报更新” group, that is an explicit decision-33
  change with a second producer.
- CLI: `occ-refresh status`, `occ-refresh sweep --now` (operator, still
  advisory-locked).

**Acceptance:**

- 236 companies checked daily; **0 LLM tokens, on unchanged and changed days**.
- A new EDGAR/CNINFO/HKEXnews filing is detected, its financials parsed, and
  the company page shows the new period without a manual backfill.
- Re-running is idempotent; unchanged filings are not re-fetched or re-parsed.
- Failures back off and pause; the UI says 排队中/重试中, never fake success.

### P2 — delivery / engineering quality (deferred; do not start now)

- Production hosting: same-origin static build + reverse proxy, one-command
  local demo; Docker/Electron remain deferred by the current machine.
- Automated quality: Playwright web smoke suite, agent eval (golden questions
  + evidence shape + citation precision), CI gate.
- Observability: pino JSON, request IDs end-to-end, Prometheus `/metrics`,
  OTel spans, LLM call audit, in-app debug drawer (`Ctrl/Cmd+Shift+D`).
- API productionization: remote auth/API keys, idempotency keys, response
  cache, Scalar `/docs`, `/v1/entities/resolve`.
- **Optional agent fallback for data refresh (not committed; do not build
  unless P1.5 leaves a real gap).** Only for: (a) no filing source/IR URL is
  known, (b) the deterministic parser fails on a *changed* filing, (c)
  cross-source conflicts need an explanation, (d) on-demand narrative
  summaries. Guards if it is ever built: change-gated (0 LLM tokens on
  unchanged days), one call per company per changed filing, hard daily cap
  (e.g. 20 calls / 200k tokens), cheap model + low reasoning + structured
  JSON, send only the changed table/rows, content-hash cache, results go to
  the **review queue**. It must never become the daily polling loop.
- Small follow-ups: “continue research” after a budget stop; verify AI
  watchlist entries (Zhipu `02513.HK`, MiniMax listing status).
- STAR 50 backfill and any remaining HSI/CYB50 coverage: **backfill, out of
  scope for this plan**; revisit only if the universe plan changes.

### Done index (details live in the linked docs)

- 2026-11-01 — P1.2 sector + entity resolution (235/236 sectors, 12 A/HK
  stub merges, 183 LEIs, 1 GLEIF parent edge, 98 QIDs) →
  [docs/ENTITY.md](docs/ENTITY.md).
- 2026-11-01 — P1.1 A500/SPX placeholder layer (500 + 500 members, 862 stubs
  at P1.1; 850 after the 12 P1.2 merges, `occ indices sync`, searchable
  `未收录` pages).
- 2026-11-01 — automatic news refresh + TaskDock → [docs/NEWS.md](docs/NEWS.md),
  [docs/UI.md](docs/UI.md) §7.5/§7.9.
- 2026-11-01 — US EDGAR-only + Financials tab → [docs/EXTRACT.md](docs/EXTRACT.md).
- 2026-10-31 — HSI, ChiNext 50, F10 relations, reviewer, structured financials.
- 2026-10-30 — ACP resume, session replay, UX v3.

## 11. Handoff checklist

Current invariants (verify before a demo):

- [x] NDX 100/100 `xbrl`, HSI 84/85 `f10`, CYB50 50/50 `f10`; `HK:00823` is
  the only documented structured-financials gap.
- [x] HSI 85/85 and CYB50 50/50 memberships; `/v1/indices/HSI|CYB50` returns
  the members.
- [x] A500/SPX: 500/500 memberships (`as_of 2026-10-30` / `2026-10-29`),
  850 stubs after P1.2 (435 A500 + 415 SPX); `/v1/indices/A500|SPX` returns
  500; stub search + placeholder page verified; rerunning `occ indices sync`
  inserts 0 rows (merged A-share lines now belong to their HK company).
- [x] P1.2: 235/236 researched companies have a canonical sector (only
  `HK:00823` lacks one); 12 A/HK stub merges are audited in
  `entity_merge_log`; `company_ids` has 0 duplicates; 183 LEI / 64 USCC /
  184 ISIN / 98 QID; 1 GLEIF `parent_of` edge with source + review item;
  `search?sector=` returns the 11 canonical values.
- [x] `company_research_state`: 104 `ready` / 31 `needs_review`; review is
  operator work, not a bug.
- [x] Automatic news refresh: `global_news_last_update` is the only cursor;
  daily schedule + lazy `/v1/news/status` trigger; 3-day history; no manual
  refresh control; 0 LLM tokens.
- [x] TaskDock in the top nav and News-tab status line; tests and builds green.
- [x] No key/token/`.env` tracked; no NIM gateway on the default path.
- [x] `corepack pnpm -r --workspace-concurrency=1 test` green; web build green.

P1 (active; see §10):

- [x] P1.1 A500 + SPX placeholders: 500 + 500 memberships, 862 stubs at
  P1.1, `occ indices sync` idempotent, searchable `未收录` pages; existing
  company rows untouched; no migration.
- [x] P1.2 sector + entity resolution: 235/236 sectors; 12 A/HK stub merges
  audited; 183 LEI / 64 USCC / 184 ISIN / 98 QID; 1 GLEIF `parent_of` edge
  with source + review item; `occ entities coverage` reports every missing
  company. Migration `0009_entity_merge_log.sql`.
- [ ] P1.3 US 13F + HKEX DION ownership graph.
- [ ] P1.4 CNINFO/SSE/SZSE/HKEXnews/IR RSS/GDELT adapters + PDF.
- [ ] P1.5 daily company-data/financial-report refresh (`data.sweep`,
  `company_filing_state`, `filings`, deterministic detection, 0 LLM tokens).

P2 (deferred; do not start):

- [ ] production hosting/one-command demo, Docker/Electron.
- [ ] Playwright E2E + agent eval + CI.
- [ ] observability/debug drawer/metrics/LLM audit.
- [ ] API productionization, continue-research, AI watchlist verification.
- [ ] **optional** agent fallback for data refresh (discovery / unmapped /
  conflict / on-demand summaries); not required, change-gated + capped if built.
- [ ] STAR 50 / remaining backfill (backfill; out of current plan).

---

## 12. References and archive map

Active docs:

- [`README.md`](README.md)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/UI.md`](docs/UI.md)
- [`docs/AGENT.md`](docs/AGENT.md)
- [`docs/SEARCH.md`](docs/SEARCH.md)
- [`docs/EVAL.md`](docs/EVAL.md)
- [`docs/EXTRACT.md`](docs/EXTRACT.md)
- [`docs/NEWS.md`](docs/NEWS.md)
- [`docs/ENTITY.md`](docs/ENTITY.md)
- [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md)
- [`docs/PRIOR_ART.md`](docs/PRIOR_ART.md)
- [`docs/NVIDIA_NIM_MIGRATION.md`](docs/NVIDIA_NIM_MIGRATION.md) — P0
  **headless-only** cutover: NIM inference + Parallel search/fetch for the
  worker pool, measured comparison, touchpoints, cost, rollback
- [`config/universe.yaml`](config/universe.yaml)
- [`config/indices/ndx.yaml`](config/indices/ndx.yaml)
- [`phase0/README.md`](phase0/README.md)

Historical archive: [`context_transfer_history.md`](context_transfer_history.md)

> **Cleaned 2026-11-01.** Detailed done specs for the news round, US EDGAR-only
> financials, HSI/CYB50, structured financials backend, ACP resume and UX v3
> were removed from this handoff to keep it short. The implementation docs
> below and git history keep the design detail. §10 is the only TODO list.

| Topic | Archive section |
|---|---|
| Phase 0 harness, MAG7 runs, model config, troubleshooting | history §2, §4, §5 |
| P1 F10 sidecar, worker, A/HK live acceptance | history §6 P1 |
| P2 data layer, retrieval, indexing, snapshots | history §6 P2, [`docs/SEARCH.md`](docs/SEARCH.md) |
| P2.5 NDX-100 backfill and eval | history §6 P2.5, [`docs/EVAL.md`](docs/EVAL.md) |
| P3.1/P3.2 extraction, review queue, company card | history §6 P3, [`docs/EXTRACT.md`](docs/EXTRACT.md) |
| P3.3 deep research, ACP sidebar, news | history §6 P3.3, [`docs/AGENT.md`](docs/AGENT.md), [`docs/NEWS.md`](docs/NEWS.md) |
| P3.4 earlier trajectory design and bug investigation | history §6 P3.4 |
| P3.5 UI design/acceptance | history §6 P3.5, [`docs/UI.md`](docs/UI.md) |
| Old decision rationale | history §7 |
| Full troubleshooting table | history §8 |
| Phase 0 plans / private repos | history §10 |

External references:

- `finance_analyst` (private): `https://github.com/xubowenhaoren/finance_analyst`
  — Apache-2.0; use `gh` to read; do not commit its snapshots.
- `opportunity-radar` (MIT): `https://github.com/xubowenhaoren/opportunity-radar`
  — methodology source only, not a full port.

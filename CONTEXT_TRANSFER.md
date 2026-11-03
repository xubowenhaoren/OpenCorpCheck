# OpenCorpCheck — Context Transfer

> Handoff: **2026-11-03**. Current state: foundations through the web UI are
> complete; automatic news refresh, US EDGAR-only structured financials, the
> Financials tab, HSI, ChiNext 50, **P1.1 A500/SPX placeholders**, **P1.2
> sector + entity resolution**, **P1.3 US 13F + HKEX DION ownership**, the
> **P1.3 dense-graph UI follow-up**, **P1.4 official filing adapters**, and
> **P1.5 daily company-data/financial-report refresh** are shipped, with two
> **P1.5 follow-ups pending: financials verification/retry (A/HK F10 lag) and
> the restored shared TaskDock (news + `财报更新`).** **P2 is deferred.**
> Backfill is out of scope for the current plan.
>
> The old 1,394-line document is preserved verbatim in
> [`context_transfer_history.md`](context_transfer_history.md).
>
> **Next agent:** do the two P1.5 follow-ups first (financials
> verification/retry, then the shared TaskDock). Do not start P2 (delivery /
> packaging) unless the user explicitly reopens it. The automatic refresh
> needs a running `scripts/dev-data-worker.sh` (queues `data,financials`) and
> the F10/PDF/HKEXnews sidecar for A/HK; see [docs/REFRESH.md](docs/REFRESH.md).
> The daily filing check is deterministic and 0 LLM tokens.
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

## 0. LIVE STATE — 2026-11-03 (read first)

> **Current state:** foundations through the web UI are complete. Automatic
> news refresh, structured financials (US EDGAR-only), the Financials tab,
> HSI, ChiNext 50, the **A500/SPX placeholder layer**, **P1.2 sector +
> entity resolution**, **P1.3 US 13F + HKEX DION ownership**, the **P1.3
> dense-graph UI follow-up**, **P1.4 official filing adapters**, and **P1.5
> daily company-data/financial-report refresh** are shipped. **Two P1.5
> follow-ups remain: financials verification/retry (A/HK F10 lag) and the
> restored shared TaskDock (news + `财报更新`). P2 is deferred.** Backfill and
> delivery/engineering quality are out of scope for the current plan.
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
> merge log. **P1.3:** 503 CUSIP identifiers, 13,009 US 13F edges, and 90
> HKEX DION edges. **P1.4:** 6 filing documents in the acceptance sample
> (AAPL 2, 600519 2, 00700 2), 123 chunks; the adapters are operator-run and
> full-universe ingestion is an explicit batch, not automatic. **P1.5:** the
> daily sweep plans **251 checks for the 236 researched companies** (100
> `edgar`, 66 `cninfo`, 85 `hkexnews`; stubs excluded), diffs official
> indexes against `filings` and re-runs financials for a new periodic report.
>
> | Index | Constituents | Memberships | Structured financials | Status |
> |---|---|---|---|---|
> | NDX | 100 | 100 | **100 `xbrl`, 0 `f10`** | done |
> | HSI | 85 | 85 | **84 `f10`** | done; `HK:00823` F10 EmptyRender |
> | CYB50 | 50 | 50 | **50 `f10`** | done; 45 ready / 5 needs_review |
> | A500 | 500 | 500 (`as_of 2026-10-30`) | **0 (stubs)** | **P1.1 done** |
> | SPX | 500 companies / 503 securities | 500 (`as_of 2026-10-30`) | **0 (stubs)** | **P1.1 done; snapshot refreshed for CUSIP** |
> | STAR50 | — | — | — | deferred backfill, not in the current plan |
>
> **Data:** `financial_facts` 46,880 (29,683 `xbrl`, 15,767 `f10`, 1,430
> profile; the P1.5 acceptance sample rewrote AAPL/MSFT EDGAR rows with the
> new 10-K/10-Q periods: 340 facts each; AAPL FY2026 revenue is now
> **478.834B USD** for period 2026-09-26); financials cache 234 ok / 1 failed;
> 3,245 news documents (last sweep: 232 `ok` / 4 `empty` companies);
> **relations 13,186** (13,009 `sec-13f-v1`, 90 `hkex-dion-v1`, 22 `reported`
> F10, 64 `inferred`, 1 GLEIF `parent_of`); 1,097 companies (1,086
> non-fixture + 11 fixtures), **1,757 index memberships** (SPX refreshed to
> `2026-10-30`), 1,109 securities, 4,888 aliases, **2,994 identifiers** (incl
> **503 CUSIP**, 183 LEI, 186 ISIN, 64 USCC, 98 Wikidata QID); **13,186
> pending review items** (13,009 13F + 90 DION + 87 pre-existing); **8 filing
> documents / 125 chunks** (P1.4 acceptance sample 6/123 plus the P1.5
> sample's link-only AAPL 10-K and MSFT 10-Q documents, 2/2); **2
> `company_filing_state` rows / 10 `filings` rows** (P1.5 EDGAR sample: AAPL,
> MSFT).
> **Known content gaps:** 1 researched company has `sector = null`
> (`HK:00823` 领展, F10 `EmptyRender`); **P1.5's first sweep is a baseline,
> not a backfill** — historical announcements are not ingested automatically;
> 13F issuer name variants/ADRs without a CUSIP under-match by design (exact
> names only). P1.2 GLEIF parent coverage is sparse (see §5). Stubs
> intentionally have no profile, documents, financials, chunks or embeddings.
>
> **Running (2026-11-03, rebuilt for P1.5):**
> - API `node apps/api/dist/server.js` on `:8787`
> - Vite `corepack pnpm --filter @occ/web dev` on `:5173`
> - persistent news worker: `scripts/dev-news-worker.sh start` (pid in
>   `.occ/news-worker.pid`, log `.occ/news-worker.log`)
> - **persistent data worker: `scripts/dev-data-worker.sh start`** (queues
>   `data,financials`; pid in `.occ/data-worker.pid`, log
>   `.occ/data-worker.log`) — required for the daily filing/financials loop
> - F10 + DION + HKEXnews/PDF sidecar `:8090` (`occ-f10 serve`), Postgres
>   `:5432`, Qdrant `:6333`, embeddings `:8080`
> - no research/financials worker, no NIM gateway (official DeepSeek default)
>
> **Last news run** `b892648d-4537-4b73-8916-aaeca32bfedc`: completed 236/236,
> 0 failed, 8m59s; 232 `ok` / 4 `empty`; 3,237 new articles; 0 LLM tokens;
> history kept 3 days; next due ≈ +23 h.
>
> **Last data run** `8898e0a4-1713-47d1-8e76-32b71dda89f5` (CLI sample,
> `--company AAPL --source edgar`): 1 `data.source.check` + 1
> `ingest.filing` + 1 `financials.company`, **3/3 completed**; AAPL's 10-K
> (period 2026-09-26) was detected, its existing document was skipped
> idempotently, and 340 EDGAR facts were rewritten; 0 LLM tokens. The earlier
> two-company cold sample (`61e6ac7e-…`, AAPL + MSFT) produced the same result
> for both.
>
> **Tests/build:** all green — API 33, web 48, worker 52, extract 42, ingest
> 49, agent 17, CLI 7, retrieval 10, db 11, storage 5, sources (F10 9 + news 9
> + **filings 25**), entity 29, ownership 17 (**363 total**). Web bundle
> 439.06 KB (gzip 135.29 KB); CSS 54.24 KB (gzip 10.70 KB). Python: **30**
> (F10/API, DION, PDF, HKEXnews). Run tests serially:
> `corepack pnpm -r --workspace-concurrency=1 test`.
>
> **Recent commits:** `faaa499` filings: add official filing adapters + PDF
> (P1.4); `926365b` web: stagger inner/outer rings in dense ownership graph;
> `eead595` web: make dense ownership graphs readable (P1.3 follow-up);
> `a6c0289` docs: add P1.3 dense-graph UI follow-up; `01c9909` docs: record
> P1.3 commit and live numbers; `03449da` P1.3 US 13F + HKEX DION ownership;
> `b19a8ef` fixture sector normalization + P1.2 docs. Migrations
> `0008_global_news_last_update.sql`, `0009_entity_merge_log.sql`,
> `0010_relation_metadata.sql` and **`0011_filing_refresh.sql`** are applied;
> run `node apps/cli/dist/occ.js migrate` after pulling schema changes.
> **P1.5 adds migration `0011_filing_refresh.sql`** (`company_filing_state`,
> `filings`, `backfill_runs.kind='data'`).

### 0.1 Monitor commands

```bash
node apps/worker/dist/cli.js status
node apps/worker/dist/cli.js states --limit 100
node apps/worker/dist/cli.js news status
scripts/dev-news-worker.sh status
tail -n 20 .occ/news-worker.log
curl -s 'http://127.0.0.1:8787/v1/news/status?company=AAPL'
node apps/worker/dist/refresh-cli.js status
#   or: node apps/worker/dist/cli.js data status
scripts/dev-data-worker.sh status
tail -n 20 .occ/data-worker.log
node apps/worker/dist/refresh-cli.js sweep --now [--limit N] [--company REF] [--source LIST]
node apps/cli/dist/occ.js ownership coverage
node apps/cli/dist/occ.js ownership sync --market US          # dry run
node apps/cli/dist/occ.js ownership sync --market HK --limit 3 --days 365
node apps/cli/dist/occ.js filings coverage
node apps/cli/dist/occ.js filings sync --market US --company AAPL --days 90   # dry run

psql postgres://occ@127.0.0.1:5432/occdb -c \
  "select extractor_version,status,count(*) from relations group by 1,2 order by 3 desc;"

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
psql postgres://occ@127.0.0.1:5432/occdb -c \
  "select metadata->>'source' src, metadata->>'market' market, count(*)
     from documents where doc_type='filing' group by 1,2 order by 3 desc;"
psql postgres://occ@127.0.0.1:5432/occdb -c \
  "select last_status,count(*) from company_filing_state group by 1 order by 2 desc;"
psql postgres://occ@127.0.0.1:5432/occdb -c \
  "select source,periodic,count(*) from filings group by 1,2 order by 1,2;"
psql postgres://occ@127.0.0.1:5432/occdb -c \
  "select id,kind,status,total_jobs,completed_jobs,failed_jobs
     from backfill_runs where kind='data' order by created_at desc limit 5;"
psql postgres://occ@127.0.0.1:5432/occdb -c \
  "select queue,status,count(*) from backfill_jobs
     where run_id=(select id from backfill_runs where kind='data'
                    order by created_at desc limit 1)
     group by 1,2 order by 1,2;"
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
- **Filings are deterministic and LLM-free** (P1.4 + P1.5). Discovery comes
  from SEC EDGAR submissions, CNINFO (A, covering SSE+SZSE) and HKEXnews
  (sidecar); PDFs are parsed by `pdfplumber` with page provenance.
  `doc_type='filing'` documents appear in a separate 公告文件 tab, not mixed
  into news. The operator path is still `occ filings sync`; the automatic
  daily path is P1.5.
- **Daily company data is automatic and LLM-free** (P1.5). `data.sweep` checks
  every researched (company, source) pair once a day, diffs `filings` by
  `(source, accession)`, ingests new announcements and re-runs
  `financials.company` for a new periodic report. The first check is a
  **baseline**, not a historical backfill; only recent periodic reports are
  acted on. Keep `scripts/dev-data-worker.sh` running. If the company page
  shows `排队中`, the data worker is not running; if it shows `重试中`, inspect
  `occ-refresh status` / `.occ/data-worker.log` (HK checks need the sidecar).
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
- **P1.4 (2026-11-02)**: deterministic official filing layer.
  `@occ/sources-filings` discovers SEC EDGAR submissions, CNINFO A-share
  announcements (SSE + SZSE), HKEXnews titles (Playwright sidecar), optional
  IR RSS and GDELT. `occ filings sync|coverage` writes `doc_type='filing'`
  documents, page-numbered chunks, Qdrant points and a separate 公告文件
  block; PDF text/tables are extracted by `pdfplumber` (`POST
  /v1/pdf/extract`). No LLM, no schema migration. See
  [docs/FILINGS.md](docs/FILINGS.md).
- **P1.5 (2026-11-03)**: automatic daily company-data/filing refresh.
  `data.sweep` derives one check per researched (company, source) pair
  (EDGAR/CNINFO/HKEXnews, F10 fallback for a company with no official feed),
  leases `company_filing_state`, and enqueues `data.source.check`.
  `data.source.check` diffs the official index against `filings` by
  `(source, accession)`; new announcements go to `ingest.filing` (P1.4
  documents), and a new periodic report (10-K/10-Q/20-F/40-F, annual/interim/
  quarterly report) enqueues `financials.company` with `bypassCache`.
  The first check is a baseline; a recent periodic report is still acted on.
  Migration `0011_filing_refresh.sql`; 0 LLM tokens. See
  [docs/REFRESH.md](docs/REFRESH.md).
- **P1.3 (2026-11-02)**: deterministic ownership layer. `@occ/sources-ownership`
  streams SEC Form 13F data sets (13F-HR only; filer by CIK, issuer by CUSIP
  with an exact-name fallback; options/non-share rows skipped) and the HKEX
  DION sidecar returns substantial-shareholder notices (long position only).
  `occ ownership sync|coverage` writes additive `invests_in` edges with
  `relations.metadata`, evidence and a pending review item. Migration
  `0010_relation_metadata.sql` (metadata + `ownership_sync_runs`). See
  [docs/OWNERSHIP.md](docs/OWNERSHIP.md).
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
- Build: web main JS 439.06 KB (gzip 135.29 KB), lazy Markdown chunk 162.66 KB
  (gzip 49.05 KB), CSS 54.24 KB (gzip 10.70 KB).

Verified 2026-11-03 (P1.5):

- Planned coverage: **236 researched companies → 251 checks** (100 `edgar` /
  66 `cninfo` / 85 `hkexnews`; 850 stubs excluded; 0 F10 fallback in the
  current corpus).
- Cold EDGAR sample (`--limit 2`): AAPL's new **10-K** (period 2026-09-26,
  filed 2026-11-03) and MSFT's **10-Q** (filed 2026-10-28) were detected as
  recent periodic reports; `ingest.filing` wrote 1 link-only document + 1
  chunk each (Qdrant indexed); `financials.company` wrote **340 EDGAR facts**
  each; AAPL's latest structured period became `2026-09-26` (FY2026 revenue
  **478.834B USD**, up from FY2025 416.161B); the card's
  `filingRefresh.latest` was the 10-K with `lastStatus=changed`; **0 LLM
  tokens**.
- Steady rerun for AAPL: `discovered=2, inserted=0, enqueuedFilings=0,
  enqueuedFinancials=0`; 3-day window after a check 1 minute earlier.
- Failure path (HKEXnews with the sidecar down): `last_status=failed`,
  `consecutive_failures=1`, `next_due_at` +15 min; the card exposed
  `lastStatus=failed` so the UI renders `重试中`, never fake success.
- Migration `0011_filing_refresh.sql` applied; 363 TypeScript tests + 30
  Python tests green.

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
    UI.md  EXTRACT.md  AGENT.md  NEWS.md  ENTITY.md  OWNERSHIP.md  FILINGS.md
    REFRESH.md
  apps/
    web/                           # React 19 + Vite 8 consumer UI
    api/                           # Hono + Zod API, SSE agent, OpenAPI
    cli/                           # occ CLI + MCP stdio server
    worker/                        # pg-boss parallel backfill + data/* refresh
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
    sources/ownership/             # US 13F data sets, HKEX DION planner, ZIP reader
    sources/filings/               # EDGAR/CNINFO/HKEXnews/RSS/GDELT + PDF client (P1.4/1.5)
    sources/news/                  # Google News RSS adapter
  services/
    finance-analyst/               # Python sidecar: A/HK/US F10 (uv + Playwright)
    embeddings/                    # local BGE-M3 / reranker sidecar
  scripts/
    dev-db.sh dev-qdrant.sh dev-embeddings.sh dev-minio.sh e2e-search.sh
    dev-news-worker.sh dev-data-worker.sh   # persistent automatic workers
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
node apps/cli/dist/occ.js migrate     # apply SQL migrations (0011 for P1.5)
node apps/api/dist/server.js        # http://127.0.0.1:8787
corepack pnpm dev:web               # http://127.0.0.1:5173 (proxy /v1 → 8787)

# persistent automatic-news worker (separate process)
scripts/dev-news-worker.sh start    # status | stop | restart | logs

# persistent daily data/filing worker (P1.5; queues data,financials)
scripts/dev-data-worker.sh start    # status | stop | restart | logs

# P1.5 observe / force a sweep (advisory-locked; still leases the cursors)
node apps/worker/dist/refresh-cli.js status
node apps/worker/dist/refresh-cli.js sweep --now [--limit N] [--company REF] [--source LIST]
#   or: node apps/worker/dist/cli.js data status|sweep --now

# refresh index snapshots, then create/update A500/SPX stubs + memberships
uv run scripts/snapshot-indices.py
node apps/cli/dist/occ.js indices sync [--index A500|SPX|all] [--dry-run] [--json]

# P1.2 sector + identifier enrichment (uses cached F10/EDGAR; reindexes sectors)
node apps/cli/dist/occ.js entities enrich [--dry-run] [--force] [--skip-index]
node apps/cli/dist/occ.js entities coverage [--json]
node apps/cli/dist/occ.js entities resolve [--apply]      # dual-listed A/HK stubs
node apps/cli/dist/occ.js entities gleif [--apply]        # LEI + parent edges
node apps/cli/dist/occ.js entities wikidata [--apply]     # QIDs

# P1.3 ownership (dry-run by default; add --apply to write)
node apps/cli/dist/occ.js ownership sync --market US [--apply] [--limit N] [--dataset NAME] [--refresh]
node apps/cli/dist/occ.js ownership sync --market HK [--apply] [--limit N] [--days 365] [--max-pages 10]
node apps/cli/dist/occ.js ownership coverage [--json]

# P1.4 official filings (dry-run by default; --apply fetches PDFs + indexes)
node apps/cli/dist/occ.js filings sync --market US --company AAPL --days 90 --max-items 5
node apps/cli/dist/occ.js filings sync --market all --limit 5 --max-items 5 --apply
node apps/cli/dist/occ.js filings sync --market A --company 600519 --days 180 --skip-pdf --apply
node apps/cli/dist/occ.js filings coverage [--json]
#   default excludes A500/SPX stubs; --include-stubs opts in
#   --sources official|all|edgar,cninfo,hkexnews,ir-rss,gdelt
#   --skip-pdf, --full-text (EDGAR HTML), --max-pages N, --refresh, --skip-index

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
| `OCC_DION_TIMEOUT_MS` | `60000` (P1.3) |
| `OCC_DION_SETTLE_MS` | `1500` (P1.3) |
| `OCC_DION_MAX_PAGES` | `10` (P1.3) |
| `OCC_DION_RATE_PER_SEC` | `1.0` (P1.3; keep polite) |
| `OCC_FILINGS_DIR` | `.occ/filings` (P1.4 raw PDFs + extraction JSON) |
| `OCC_IR_FEEDS` | `config/ir-feeds.yaml` (P1.4 opt-in IR feeds) |
| `OCC_HKEXNEWS_TIMEOUT_MS` / `_SETTLE_MS` | `60000` / `1500` (P1.4) |
| `OCC_HKEXNEWS_RATE_PER_SEC` | `1.0` (P1.4; sidecar serializes searches) |
| `OCC_DATA_SWEEP` | on; `none`/`off` disables the daily data/filing sweep (P1.5) |
| `OCC_DATA_SWEEP_CRON` / `_TZ` | `0 8 * * *` / machine timezone (P1.5) |
| `OCC_DATA_TTL_MS` | `82800000` (23 h; shorter than the daily period) |
| `OCC_DATA_CLAIM_TIMEOUT_MS` | `1800000` (30 min lease) |
| `OCC_DATA_SWEEP_BATCH` | `500` checks per sweep |
| `OCC_DATA_HISTORY_MS` | `259200000` (3 days of data-run history) |
| `OCC_DATA_PAUSE_AFTER` | `5` consecutive failures → `paused` |
| `OCC_DATA_CONCURRENCY` | `4` `data.source.check` jobs in parallel |
| `OCC_DATA_COLD_DAYS` | `30` (first-check/baseline window) |
| `OCC_DATA_MAX_STEADY_DAYS` | `30` (lookback cap after an outage) |
| `OCC_DATA_MAX_ITEMS` | `20` discovered/ingested filings per source per check |
| `OCC_FILINGS_CONCURRENCY` | `2` `ingest.filing` jobs |
| `OCC_FILINGS_FULL_TEXT` | off; `1`/`on` follows EDGAR HTML in the automatic path |
| `OCC_FILINGS_MAX_PAGES` | `80` |
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
- `/c/:ref` — ticker, slug, Chinese alias or ULID. Six tabs:
  基本资料 / 财务数据 / 关系图谱 / 新闻动态 / 公告文件 / 资料来源. A `stub` company
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
  - Filings (P1.4 + P1.5): official announcements in a separate tab, newest
    first; each row shows date/title/form-category and a **来源** button that
    opens the original PDF or SEC filing page. Kept separate from News so a
    busy news day cannot bury announcements. A status line above the list
    shows `最新报告 2026-09-26 (10-K) · 财报更新于 …`, `披露检查排队中…`, or
    `披露检查失败，将自动重试（连续 N 次）` (warning colour). The Financials
    coverage line adds `财报更新于 <date>`. The card polls every 15 s while a
    check is pending.
  - Sources: grouped by trust tier, deduped, copy-all-citations.
- **Top-nav TaskDock** (2026-11-01; **shared design restored 2026-11-03**):
  last control after `EN` / 深色. **Current production is news-only**: a 34 px
  ring with the active sweep's progress and a count badge; the expanded card
  shows the active sweep, per-company subtasks (`19 条` / `抓取中` / `队列中`,
  link to `/c/:ticker`) and completed sweeps within the last 3 days; idle shows
  the last sweep and next due time. **No manual controls**; polling
  `/v1/news/status` is also what lazily starts a due sweep. The target restored
  design adds the automatic `财报更新` group (data/filing/financials sweep) and
  `全部 / 更新新闻 / 财报更新` filter tabs to the same dock; the manual
  refresh-news button stays cancelled. This is a **P1.5 follow-up** (§10), not
  yet in production; see [docs/UI.md](docs/UI.md) §7.9. The News tab adds
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
  `SearchCompaniesQuery.sector`; `ResearchJobView.payload/meta`;
  `RelationView.extractorVersion`/`metadata` (P1.3); `FilingRefreshView`,
  `FilingSourceStateView`, `LatestFilingView` and `CompanyCard.filingRefresh`
  (P1.5).
- `GET /v1/companies/:ref?include=filings` — now also returns `filingRefresh`
  (latest periodic/any filing, per-source cursors, `lastStatus`, `pending`);
  no new endpoint.

Known limitations:

- **Ownership coverage (P1.3, 2026-11-02):** **13,009 US 13F `invests_in`
  edges** (63 filers, 529 issuers) plus **90 HKEX DION edges** (14 holder
  companies matched, 45 issuers; 10 cross-source duplicates skipped).
  13F holder coverage is intentionally low — the corpus is index companies, not
  asset managers; out-of-universe filers/issuers are counted, never created.
  A/HK F10 top-10 edges and the GLEIF parent edge remain additive and
  unchanged. See [OWNERSHIP.md](OWNERSHIP.md). Do not fake edges in the UI.
- **Filings have two layers (P1.4 + P1.5):** the P1.4 operator command
  (`occ filings sync`) remains the historical/manual path; the P1.4 acceptance
  sample has 6 documents / 123 chunks (AAPL, 600519, 00700). P1.5 adds the
  automatic daily `data.sweep`, which checks **251 (company, source) pairs**
  for 236 researched companies and acts only on new filings. The first check
  is a **baseline, not a backfill**: historical announcements are not ingested
  automatically; a recent periodic report is ingested and triggers financials.
  EDGAR HTML stays link-only unless `OCC_FILINGS_FULL_TEXT=1`. A500/SPX stubs
  are excluded. See [REFRESH.md](REFRESH.md) and [FILINGS.md](FILINGS.md).
- **Daily refresh needs the data worker:** `data.sweep` / `data.source.check` /
  `ingest.filing` progress only while `scripts/dev-data-worker.sh` runs
  (`work --queues data,financials`). A/HK PDF/announcement checks also need the
  sidecar (`occ-f10 serve`). With no worker the company page shows `排队中`;
  with a failing source it shows `重试中` after a 15 min backoff. The current
  production TaskDock is news-only; the shared `更新新闻` + `财报更新` dock is
  a P1.5 follow-up (see §10), not yet shipped.
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
  inventing edges; P1.3 adds 13F/DION ownership separately.
- **Dense ownership graphs (fixed 2026-11-02):** 13F adds 25–35 holders to
  large caps (GOOGL/NVDA/AAPL/BLK). The web graph now shows the top 10 by
  amount plus an「其他机构 +N」cluster, uses a two-ring layout above 8 direct
  nodes, hides colliding labels and draws 13F/DION edges faintly without
  arrows.「显示全部」expands; the full relation list is unchanged. No 13F edge
  is hidden in the API or the list. See [docs/UI.md](docs/UI.md) §7.4.1.
- **Relation labels are per-source (fixed 2026-11-02):** `reported` renders as
  `已报告`; the pill shows `13F 持仓` / `HKEX 权益披露` / `GLEIF 母公司` /
  `F10 股东` from `extractorVersion`. Unknown extractors fall back to `已报告`.
  Relations sort by confidence then `amount` so the largest holdings surface
  first.
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
- **Ownership (P1.3, 2026-11-02)**: `packages/sources/ownership` streams SEC
  Form 13F data sets (only `13F-HR`, filer by CIK, issuer by CUSIP with an
  exact-name fallback) and the HKEX DION sidecar returns substantial-shareholder
  notices (long position only). `occ ownership sync|coverage` writes additive
  `invests_in` edges with `relations.metadata`, evidence and a pending review
  item; `ownership_sync_runs` stores the last report per market. Deterministic,
  0 LLM tokens. See [docs/OWNERSHIP.md](docs/OWNERSHIP.md).
- **Filings (P1.4, 2026-11-02)**: `packages/sources/filings` discovers SEC
  EDGAR submissions, CNINFO announcements (SSE + SZSE), HKEXnews titles via
  the Playwright sidecar, optional IR RSS and GDELT. `occ filings sync` writes
  `documents` with `doc_type='filing'`, page-numbered chunks and Qdrant
  points; PDFs are cached under `.occ/filings/` and parsed by `pdfplumber`
  (`POST /v1/pdf/extract`) with text + tables and page provenance. Dedupe is
  `(companyId, source, externalId, canonicalUrl)` + content hash; reruns
  insert 0. A failed/skipped Qdrant index leaves `metadata.indexed=false` and
  the next normal run retries it.
  Deterministic, 0 LLM tokens, no migration. See
  [docs/FILINGS.md](docs/FILINGS.md).
- **Daily company-data refresh (P1.5, 2026-11-03)**: `data.sweep`
  (`apps/worker/src/data-sweep.ts`) plans one check per researched
  (company, source) pair from `securities`/`company_ids`, leases
  `company_filing_state` and enqueues `data.source.check`
  (`apps/worker/src/data/plan.ts` holds the pure planner). The check diffs the
  official index against `filings` by `(source, accession)`, enqueues
  `ingest.filing` for new announcements and `financials.company` with
  `bypassCache` for a new periodic report. `ingest.filing` shares the P1.4
  content loader/PDF cache (`packages/sources/filings/src/content.ts`). The
  first check is a baseline; a recent periodic report is still acted on.
  Migration `0011_filing_refresh.sql`; deterministic, 0 LLM tokens. See
  [docs/REFRESH.md](docs/REFRESH.md).
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
33. **One shared task dock, news + automatic data refresh** (decision
    2026-10-30; revised to news-only 2026-11-01; **restored 2026-11-03**).
    History: the original design (`08519b1`) was one top-right dock for news
    and company research, with task-kind badges and filter tabs. `fa84287`
    narrowed it to news-only and cancelled the manual refresh button. The
    2026-11-03 decision restores the **shared information architecture** for
    the two **automatic** producers only:
    - `news_refresh` — the automatic news sweep; badge `更新新闻`;
    - `data_refresh` — the daily filing/financials sweep
      (`data.sweep` → `data.source.check` → `ingest.filing` /
      `financials.company`); badge `财报更新`.
    The dock keeps the original kind badges, `全部 / 更新新闻 / 财报更新`
    filter tabs, expandable per-company subtasks and the
    queued/running/completed/partial/failed states. **The manual
    refresh-news button stays cancelled** (decision 34); no public control
    triggers a fetch. Retry/review buttons are not restored in this cut
    because both producers retry automatically; add them only with a separate
    decision. `company_research` remains operator-only and is **not** a public
    dock producer. **Implementation is a P1.5 follow-up (see §10); the
    production dock is still news-only until it ships.** The prototype
    (`docs/prototypes/task-dock.html`, `dd465fc`) is the visual reference.
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
52. **13F is a deterministic SEC data-set pipeline, not page scraping**
    (decision 2026-11-02): fetch the SEC's official Form 13F data-set index,
    pick the latest filing window, cache the ZIP under
    `<OCC_EDGAR_DIR>/13f/<dataset>/` with SHA-256, and stream `INFOTABLE.tsv`
    through a dependency-free ZIP reader. Only `13F-HR` is used (`13F-HR/A`
    amendments and `13F-NT` notices are skipped and reported); options and
    non-share rows are skipped; the latest period wins and share classes sum.
    Filer = exact CIK first, exact normalized manager name only as a fallback;
    issuer = CUSIP first, exact normalized issuer name as a reported fallback.
    Edge = `invests_in` only (13F is a position, not control);
    `extractorVersion='sec-13f-v1'`.
53. **CUSIP is a first-class identifier from the SPY snapshot** (decision
    2026-11-02): the SPY holdings workbook's `Identifier` column is the CUSIP;
    `scripts/snapshot-indices.py` records it and `occ indices sync` writes it
    to `company_ids` (503 ids). Never derive/guess a CUSIP. The SPX snapshot
    was refreshed to `as_of 2026-10-30` for this; older membership snapshots
    remain as history and the API serves the newest per company.
54. **HKEX DION is browser-only and long-position-only** (decision 2026-11-02):
    the DI site's JS bot defense rejects plain HTTP, so the Playwright sidecar
    (`POST /v1/dion/notices`, `occ-f10 dion`) drives the normal search form at
    **1 request/second**. Only the `(L)` line of a notice is used; a
    short-only notice is ignored. Holders match by exact normalized name
    against display/legal/profile names and brand/legal aliases — **pinyin and
    ticker aliases are excluded** (`sndl` for 深南电路 must not match SNDL
    Inc.). Individuals/funds/parent groups outside the universe are counted,
    never created. Edge = `invests_in`; DION percentage alone never implies
    `owns`.
55. **Ownership writes are additive, idempotent and review-queued**
    (decision 2026-11-02): one edge per `(holder, issuer, type)`; a new quarter
    updates the same row and adds evidence. Every edge gets a source row, an
    evidence quote/URL, and a pending review item. The writer never deletes F10
    / GLEIF / human-reviewed edges; a same-pair edge owned by another extractor
    is counted as a duplicate and left untouched. `relations.metadata jsonb`
    carries quarter/shares/CUSIP/percentage/serial; `amount` stays the primary
    monetary value. `ownership_sync_runs` stores the last run report per market
    so coverage can report matched vs out-of-universe without re-running.
56. **Relation pills show the source, the status stays `已报告`** (user
    decision 2026-11-02): `reported` is no longer rendered as `媒体报道`.
    `sec-13f-v1`, `hkex-dion-v1`, `gleif-lei-v1` and `f10-table-v1` have
    per-source Chinese/English labels; unknown extractors fall back to
    `已报告`. Relations sort by confidence then `amount` so the largest
    holdings surface first.
57. **Filings are documents, not facts** (decision 2026-11-02): a P1.4 filing
    is a `documents` row (`doc_type='filing'`) with `sources` provenance,
    page-numbered `chunks` and Qdrant points. It does **not** enter the review
    queue and does not write `facts`; the document itself is the evidence.
    `metadata.source/externalId/form/category/pdfUrl/linkOnly/pages/warnings`
    carry the source-specific provenance. No migration.
58. **CNINFO is the A-share adapter for both boards** (decision 2026-11-02):
    CNINFO is the CSRC-designated disclosure platform for SSE and SZSE; one
    adapter covers both and links the exchange-published PDFs. The `orgId` is
    resolved through `new/information/topSearch/query` (form-encoded), because
    it is not always derivable from the ticker (e.g. 601318 → `9900002221`).
    Do not add direct SSE/SZSE scrapers unless CNINFO coverage proves
    insufficient.
59. **HKEXnews is browser-only; HKEX DION remains separate** (decision
    2026-11-02): the public title-search page is a JSF form and the old
    `titleSearchServlet` returns empty. Drive it through the Playwright
    sidecar at 1 request/second and read the result table. DION is ownership
    (P1.3); HKEXnews is announcements (P1.4).
60. **PDF extraction is deterministic and capped** (decision 2026-11-02):
    `pdfplumber` text + tables, page provenance, 0 LLM tokens. Caps: 30 MB,
    80 pages default (hard 200), 20k chars/page, 20 tables/page; truncation is
    reported, never silent. No OCR: image-only PDFs stay link-only.
61. **Filing identity is company + source + external id + canonical URL**
    (decision 2026-11-02): `(companyId, source, accession/announcementId/PDF
    URL/article URL, canonicalUrl)` determines the document id; content hash
    (`rawSha256`, `textSha256`) is stored. A rerun skips an existing complete
    document and never refetches its PDF. A link-only document is retried when
    a new content path appears (a PDF or `--full-text`), after a content error,
    or while `metadata.indexed=false`; a scanned/no-text PDF is marked
    `contentAttempted` so it is not re-fetched every run. `--refresh` forces
    re-ingestion.
62. **Official-first, link-only supplements** (decision 2026-11-02): the
    default `--sources official` set is EDGAR + CNINFO + HKEXnews. IR RSS and
    GDELT are opt-in (`--sources all`) and remain link-only `media`/`company_ir`
    sources; no article-body scraping, no paywall bypass, no bulk
    redistribution. The 公告文件 tab is separate from News so official
    announcements are not buried (decision 2026-11-02).
63. **Daily data refresh is a deterministic cursor/lease sweep, not an agent**
    (decision 2026-11-03): `data.sweep` is a singleton producer (advisory
    lock + `short` queue) that leases `company_filing_state` and enqueues
    `data.source.check`. Detection is a set diff on `(source, accession)`; no
    LLM runs on the daily path. The optional agent fallback stays a P2 idea.
64. **Detection inbox is separate from the document store** (decision
    2026-11-03): `filings` holds `(source, accession, form, filed_at,
    period_end, url, content_hash, status)`; user-facing evidence stays
    `documents(doc_type='filing')` written by `ingest.filing`. Never point the
    company page's 公告文件 list at the inbox.
65. **The first check is a baseline, not a backfill** (decision 2026-11-03):
    cold start inserts discovered rows as `applied` (`metadata.baseline=true`)
    without ingesting historical announcements or re-running financials for
    the whole universe. The exception is a **recent periodic report** (filed
    within `OCC_DATA_COLD_DAYS`), which is ingested and triggers one
    financials run. Historical backfill remains `occ filings sync`.
66. **Periodic classification is deterministic and conservative** (decision
    2026-11-03): EDGAR 10-K/10-Q/20-F/40-F (amendments inherit); CNINFO
    年度/半年/季度报告 titles excluding 摘要/说明会/预告/快报/问询/停牌/澄清;
    HKEXnews annual/interim/quarterly results or reports excluding board
    dates, profit warnings, monthly returns, clarification/suspension.
    `8-K` / `6-K` are announcements, not periodic reports. Unknown is null,
    never guessed.
67. **A new periodic report uses `bypassCache`, not `force`** (decision
    2026-11-03): `financials.company` must bypass the 24 h EDGAR/F10 caches to
    see the new period, but a check retry must not re-run a completed job.
    `bypassCache` forces the upstream fetch; `force` remains the operator's
    "reopen completed" flag.
68. **The automatic filing path shares the P1.4 content loader** (decision
    2026-11-03): `createFilingContentLoader` in `@occ/sources-filings` owns PDF
    fetch/extraction caching for both the CLI and `ingest.filing`; EDGAR HTML
    stays link-only unless `OCC_FILINGS_FULL_TEXT=1`. No duplicate loader in
    the worker.
69. **Source selection is derived, not registered** (decision 2026-11-03):
    one candidate per company/market from securities/identifiers (US+CIK →
    EDGAR, SSE/SZSE → CNINFO, HKEX → HKEXnews); F10 content-hash fallback only
    when no official feed exists (e.g. BSE-only). Stubs and fixtures are never
    polled. Dual-listed A/HK companies get both legs.
70. **The TaskDock is being restored to shared news + data refresh**
    (decision 2026-11-03): the original shared-dock design (`08519b1`) is
    re-opened for the two automatic producers. `更新新闻` (news sweep) and
    `财报更新` (data/filing/financials sweep) share the top-nav dock, badges,
    filter tabs and per-company subtasks. The manual refresh-news button stays
    cancelled (decision 34); research remains operator-only and is not a public
    producer. **The current production dock is still news-only; the shared
    version is a P1.5 follow-up (§10) until it ships.**

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
| 13F data-set URL changed | Do not hardcode `/files/structureddata/...`; the SEC now also publishes `/files/datastandardsinnovation/...`. `occ ownership sync US` reads the index page and follows the latest link; `--dataset` resolves the name on that page. |
| 13F values look 1000× too large/small | The SEC reports dollars for filings on/after 2023-01-03 and thousands before. The planner checks each filing date and tags `valueUnit`; do not apply a global multiplier. |
| 13F restatement is not reflected | `13F-HR/A` amendments are skipped in this cut. A restatement arrives with the next `13F-HR`; do not merge amendments blindly or you double-count. |
| Name fallback matches a wrong company | Only exact normalized names are used. Pinyin/ticker aliases are excluded from the ownership index (`sndl` for 深南电路 vs SNDL Inc.). If a new collision appears, fix the alias kind/source, not the matcher with fuzzy rules. |
| HKEX DION “temporarily unavailable” | The site's JS bot defense rejects plain HTTP. Use the Playwright sidecar (`occ-f10 serve` + `occ ownership sync --market HK`); do not retry with curl/requests. |
| DION run takes too long | 1 req/s is deliberate; a 365-day window over 85 companies can take tens of minutes. Use `--limit`/`--days`/`--max-pages` for a quick sample. |
| HKEXnews search returns 0 or `fetch failed` | The sidecar must run (`uv run occ-f10 serve --port 8090`); the old plain-HTTP title-search servlet is dead. The sidecar drives the JSF form and returns the first result page. A missing stock id means the code is not on HKEXnews. |
| CNINFO returns 0 announcements for a valid code | The `orgId` is not derivable for many 601xxx codes. `fetchCninfoFilings` resolves it through `topSearch/query`; do not hardcode `gssh0` + ticker. |
| PDF extraction returns empty text | The PDF is scanned/image-only (no OCR in P1.4) or hit the page/char cap. Check `metadata.warnings`/`truncated`; the document is still stored as link-only. |
| Qdrant indexing fails after a filing write | The documents/chunks are already committed; a rerun would skip them. Start Qdrant/embeddings and rerun the same command with `--refresh`, or use `--skip-index` for a Postgres-only run. |
| Filing rerun refetches PDFs / churns | Existing complete documents are skipped by `(companyId, source, externalId, canonicalUrl)`. A link-only document is retried when a PDF/`--full-text` path appears, after a content error, or while `metadata.indexed=false`; a scanned PDF is marked `contentAttempted` and is not re-fetched every run. `--refresh` forces a re-fetch, and a failed refresh preserves the existing full text instead of downgrading to link-only. |
| Filings missing from the News tab | By design: `listEvents` is news/profile events; filings live in `listFilingEvents` and the 公告文件 tab (`include=filings`). Do not merge them back into the 10-item news list. |
| Ownership edges are missing after a rerun | The writer is additive and dedupes by `(holder, issuer, type)`; a same-pair edge from another extractor is reported as a duplicate. Check `occ ownership coverage` and the run's `duplicates` count, not the graph alone. |
| Large-cap graph is a hairball | Fixed in the web UI (2026-11-02): top-10 default +「其他机构」cluster, two-ring layout, collision-aware labels, faint 13F edges. The data/API still contain every edge. Do not reduce data or hide 13F edges in the API; adjust the web layout in `apps/web/src/lib/graph-layout.ts` instead. |
| First `data.sweep` ingests nothing | Expected: the first check is a baseline (`filings.status='applied'`, `metadata.baseline=true`). Only a periodic report filed within `OCC_DATA_COLD_DAYS` is ingested and triggers financials. Do not “fix” this by enqueuing a historical backfill. |
| Company page says `排队中` forever | The data worker is not running. Start `scripts/dev-data-worker.sh start` (queues `data,financials`). The API only schedules/observes; it never fetches filings. |
| HKEXnews checks fail with `fetch failed` | The F10/PDF/HKEXnews sidecar is not running: `cd services/finance-analyst && uv run occ-f10 serve --port 8090`. The state backs off 15 min and the page says `重试中`; it does not fake success. |
| New 10-Q detected but financials still show the old period | The financials job must run with `bypassCache: true` (P1.5 check) so the 24 h EDGAR/F10 cache is bypassed. `force` alone is for operators and also bypasses the completed-job guard; do not use it for automatic checks. |
| `filings` rows exist but 公告文件 is empty | `filings` is the detection inbox. `ingest.filing` writes the user-facing `documents`. Check the `ingest.filing` job in the data run and the worker log; the dead-letter queue is `ingest.filing.dead`. |
| `data.source.check` jobs queued but never start | No `data` worker. `occ-refresh sweep` only creates the run and jobs; `scripts/dev-data-worker.sh` executes them. |
| Duplicate checks in one sweep / double financials | `data.sweep` is advisory-locked, `leaseFilingSource` leases each row, and `financials.company`/`ingest.filing` follow-up rows use one key per run. Keep all three guards; do not remove one “because the others work”. |
| F10 fallback never appears | Expected for the current corpus: every A/HK researched company has a CNINFO/HKEXnews feed. The fallback is only for companies with no official feed (e.g. BSE-only). |
| Filing detection window misses a late filing | The steady window is the previous check + 2 days, capped at `OCC_DATA_MAX_STEADY_DAYS` (30). A worker outage longer than 30 days only re-reads 30 days; older items need `occ filings sync`. |
| Two financials workers double the EDGAR request rate | The EDGAR 110 ms limiter is per process. Run `financials` in one process per host (`scripts/dev-data-worker.sh` runs `data,financials`); stop it before starting another worker with `financials`. |
| TaskDock only shows news | Current production is news-only. The 2026-11-03 decision restores the shared `更新新闻` + `财报更新` dock as a P1.5 follow-up (see §10); do not describe it as shared until it ships. The manual refresh-news button stays cancelled. |

---

## 10. Next tasks — active plan (2026-11-03)

> **Scope rule:** P1.1–P1.5 are shipped; the active list is the **two P1.5
> follow-ups** (financials verification/retry, then the restored shared
> TaskDock). **P2 is deferred**; do not start it unless the user explicitly
> reopens delivery/engineering quality. **Backfill is out of scope** (STAR 50,
> any remaining HSI/CYB50 gaps, A500/SPX bulk research).
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
  HSI + A500. Fixture index members were also normalized to canonical sectors,
  so the A500 index-page filter no longer shows `AI 芯片`/`半导体代工` labels.
- Stubs stay sector-null; no stub was researched or given fake metrics.

### P1.3 — Investment/ownership graph depth ✅ done 2026-11-02

Shipped end-to-end; migration `0010_relation_metadata.sql`; details in
[`docs/OWNERSHIP.md`](docs/OWNERSHIP.md).

- New `packages/sources/ownership` (`@occ/sources-ownership`): dependency-free
  streaming ZIP reader, SEC 13F data-set discovery/download/cache (SHA-256),
  pure 13F planner, exact-name matching (pinyin/ticker aliases excluded), HKEX
  DION long-position parser and sidecar client. 17 unit tests.
- New `occ ownership sync --market US|HK|all [--apply] [--limit N] [--days N]
  [--max-pages N] [--dataset NAME] [--refresh] [--json]` and
  `occ ownership coverage [--json]`; both follow the `occ entities` pattern.
- US 13F: only `13F-HR`; filer by exact CIK then exact normalized manager name;
  issuer by CUSIP first, exact normalized `nameOfIssuer` fallback (reported
  separately); options/non-share/self rows skipped; latest period wins and
  share classes sum. `amount` = reported USD, `extractorVersion='sec-13f-v1'`,
  quarter/shares/CUSIP/accession in `relations.metadata`.
- HKEX DION: the public site's JS bot defense blocks plain HTTP, so the
  Playwright sidecar (`POST /v1/dion/notices`, `occ-f10 dion`) drives the normal
  search form at 1 req/s, follows `NSNoticeSSList` pages, and returns the
  notice link + raw long/short cells. Only the `(L)` line is used; the latest
  notice per holder wins; holders are exact normalized names (individuals and
  parents outside the universe are counted). `extractorVersion='hkex-dion-v1'`.
- Every edge gets `status='reported'`, a source URL + quote (evidence), a
  pending review item and a deterministic id; writes are additive and
  idempotent; a same `(holder, issuer, type)` pair owned by another extractor is
  counted as a duplicate and left untouched.
- `relations.metadata jsonb` + `ownership_sync_runs` (last run report per
  market); `RelationView` exposes `extractorVersion`/`metadata`; evidence is
  newest-first; relations sort by confidence then `amount`.
- CUSIP identifiers: the SPY holdings workbook `Identifier` column is the CUSIP;
  `scripts/snapshot-indices.py` records it and `occ indices sync` writes **503
  `cusip` ids**. The SPX snapshot was refreshed to `as_of 2026-10-30`; reruns
  insert 0. No CUSIP is derived from a ticker/ISIN.
- UI: `reported` now reads `已报告`; the pill shows the source (`13F 持仓`,
  `HKEX 权益披露`, `GLEIF 母公司`, `F10 股东`). No graph layout work.
- US result: dataset `01jun2026-31aug2026` (period 2026-06-30), 9,501 `13F-HR`
  filings (399 amendments + 1,946 notices skipped), 63 filers matched (59 by
  CIK, 4 by exact name: HSBC, AIA, NetEase), 529 issuers, 9,767 out-of-universe
  CUSIPs, **13,009 edges**, 38 sources, 13,009 pending reviews. Sample:
  Berkshire Hathaway → AAPL ($65B), BlackRock → NVDA.
- HK result: 85 researched companies, 365-day window, **4,520 notices** (all
  with a long position), **100 planned / 90 written / 10 cross-source
  duplicates**, 14 holder companies matched, 45 issuers, 209 out-of-universe
  holder names, 0 ambiguous, 0 failures; latest notice 2026-10-30. Samples:
  Las Vegas Sands → 金沙中国 75.56%, COSCO Shipping → 东方海外 71.07%,
  JD → 京东健康 67.38%, 华润置地 → 华润万象生活 70.12%, BlackRock → 新奥能源
  9.85%.
- Acceptance: no counterparty outside `companies` is created; every edge opens
  to its source and has a pending review; reruns are idempotent; graph API/UI
  render the edges with source labels.

### P1.3 follow-up — dense ownership graph readability ✅ done 2026-11-02

**Problem (user report 2026-11-02):** GOOGL/NVDA-style graphs are a hairball.
13F adds 25–35 institutional holders; the current layout puts every neighbour on
one equal-angle ring, so labels collide, dotted edges cross the center, and
bottom nodes overlap the center label. The data is correct; the **layout and
default density** are wrong. This is a web-only task; do not hide 13F edges,
change relation status/types, or alter the API.

**Acceptance:**

- Default view shows a readable subset: the **top N holders by
  `relation.amount`** (suggest N=8–10) and an “其他机构 (N)” cluster/row for the
  rest. A “显示全部” control expands; the full relation list stays available.
- No one-ring layout for >12 nodes. Use one of: two rings (top holders inner,
  others outer), radial grouping by relation family, or a force/collision
  layout. Keep the existing ≤6/≤8 layout intact where it already reads well.
- Collision-aware labels: one line, hide overlapping labels, show the full name
  on hover/selection; no label may cover the center node.
- 13F edges are lower-emphasis by default (thinner/lower opacity, no arrow
  clutter); the selected/hovered edge highlights. Consider hiding non-selected
  families or edge bundling.
- Preserve amount ordering, the source pill (`13F 持仓` etc.) and the source
  button; clicking a cluster opens the full relation list.
- Verify at 1440px and mobile with **GOOGL, NVDA, AAPL, BLK, 02318**; no
  node/label overlap at the default view. Add screenshots to this handoff or
  `docs/UI.md`.
- If a top-N parameter is needed, add it to `@occ/core` first and fetch more on
  demand; do not change relation semantics.

**Implementation (web-only; API and relation semantics unchanged):**

- New pure module `apps/web/src/lib/graph-layout.ts` with 8 layout tests:
  - 13F/DION direct neighbours are ranked by `amount` (DION falls back to
    `metadata.percent`); when more than 12 exist, the default graph shows the
    top 10 plus a synthetic「其他机构 +N」node. F10/GLEIF and non-investment
    edges stay visible.
  - >8 visible direct nodes use two rings (top holders inner, rest outer) with
    relation-family arcs; inner/outer angles are interleaved so an outer
    holder's edge to the centre passes between inner nodes instead of through
    one (which would look like the two companies are connected). ≤8 keeps the
    previous single ring/radii.
  - Labels are single-line, placed in priority order, and hidden when they
    would cover the centre, another node, or another label. Hover shows the full
    name via `<title>`; the inspector shows it on selection.
- `CompanyGraph.tsx`:「显示全部 / 只看前 10 家」toggle; cluster node/edge
  (click expands and scrolls to the full relation list); ownership edges are
  thinner/lower-opacity with no arrowheads and highlight on hover/selection;
  unrelated edges dim when a node/edge is selected; amount shown in the list
  and inspector.
- Verification: 1440px + 390px screenshots for GOOGL, NVDA, AAPL, BLK and
  02318 are in [`docs/screenshots/p1.3/`](docs/screenshots/p1.3/) with
  `overlap-report.json` (0 node collisions, 0 label collisions at the default
  view for every company, including GOOGL's 39-node expanded state). BLK is an
  S&P 500 stub and is verified through `/graph?company=blackrock`.
- Web tests/typecheck/build green (43 web tests).

### P1.4 — Official filing adapters ✅ done 2026-11-02

Shipped end-to-end; **no migration**. Details in
[`docs/FILINGS.md`](docs/FILINGS.md).

- New `@occ/sources-filings` package: SEC EDGAR submissions parser (8-K,
  10-K/10-Q, 20-F/40-F, 6-K, proxy, SC 13D/G; routine Form 3/4/5, 144, 13F,
  N-PORT excluded), CNINFO orgId + announcement query (SSE + SZSE), HKEXnews
  result mapping, RSS/Atom, GDELT, PDF bytes fetch + sidecar extraction
  client. 18 tests.
- Sidecar: `POST /v1/hkexnews/search` (Playwright, JSF form, 1 req/s) and
  `POST /v1/pdf/extract` (`pdfplumber`, text + tables, page provenance,
  30 MB / 80-page / 20k-char / 20-table caps). CLI: `occ-f10 hkexnews`,
  `occ-f10 pdf`. Python tests 30.
- `occ filings sync --market A|HK|US|all [--apply] [--company REF] [--limit N]
  [--days N] [--max-items N] [--sources official|all|...] [--include-stubs]
  [--skip-pdf] [--full-text] [--max-pages N] [--refresh] [--skip-index]
  [--json]` and `occ filings coverage [--json]`. Dry run is the default;
  A500/SPX stubs are excluded unless `--include-stubs`.
- Ingest: `ingestFilings` writes `documents` (`doc_type='filing'`), one
  source row, page-numbered chunks (600/800/90 token chunking), Qdrant points
  and a `metadata` provenance block. Dedupe by `(companyId, source,
  externalId, canonicalUrl)` + content hash; reruns insert 0. Raw PDFs/extraction JSON are
  cached under `.occ/filings/`.
- UI/API: `listFilingEvents` + `include=filings` (`filing_limit` 30) and a
  separate 公告文件 tab; every row opens the original PDF/SEC filing. News
  stays news-only. Sources tab includes filing sources.
- Acceptance sample: AAPL 2 EDGAR filings (4 chunks), 600519 2 CNINFO PDFs
  (3 chunks), 00700 2 HKEXnews PDFs (116 chunks); `documents '茅台 第三季度
  经营数据'` returns the filing chunk as top hit; reruns insert 0. Coverage:
  6 documents / 123 chunks.
- Known limits: EDGAR recent window only; EDGAR HTML link-only unless
  `--full-text`; CNINFO orgId resolved per run; HKEXnews first result page;
  PDF caps; no OCR; GDELT/IR RSS opt-in and link-only; the daily sweep is
  P1.5 (shipped 2026-11-03).

### P1.4 original scope (kept for reference)

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

### P1.5 — Daily company-data / financial-report refresh ✅ done 2026-11-03

Shipped end-to-end; migration `0011_filing_refresh.sql`; details in
[`docs/REFRESH.md`](docs/REFRESH.md).

- New `company_filing_state` (per-company/source cursor + lease) and `filings`
  (detection inbox; unique `(source, accession)`, `periodic`/`period_kind`,
  `status`, `content_hash`). `backfill_runs.kind` gains `data`.
- New `data.sweep` producer (advisory-locked, `short` policy, daily
  `OCC_DATA_SWEEP_CRON` default `0 8 * * *`) and `data.source.check`
  (`OCC_DATA_CONCURRENCY=4`). `apps/worker/src/data/plan.ts` derives one check
  per researched company/source (EDGAR/CNINFO/HKEXnews, F10 fallback only
  when no official feed exists); stubs/fixtures never participate.
- `data.source.check` diffs the official index against `filings`, inserts only
  unseen rows, enqueues `ingest.filing` (`OCC_FILINGS_CONCURRENCY=2`) for new
  announcements and `financials.company` with `bypassCache` for a new periodic
  report. Periodic classification is deterministic
  (`@occ/sources-filings` `periodic.ts`).
- `ingest.filing` turns detected rows into P1.4 `documents`/`chunks`/Qdrant
  using the shared `createFilingContentLoader` (same PDF cache as the CLI).
- First check is a **baseline**: historical announcements are not ingested and
  financials are not re-run for the whole universe; a periodic report filed
  within `OCC_DATA_COLD_DAYS` (30) is still ingested and triggers one
  financials run.
- Success advances `last_checked_at` and `next_due_at` (+23 h); failures
  back off (15 min × 2^n, capped at TTL) and pause after 5. `occ-refresh
  status|sweep --now`, `occ-backfill data status|sweep --now`, and
  `scripts/dev-data-worker.sh` (`work --queues data,financials`).
- UI/API: `CompanyCard.filingRefresh` (latest periodic/any filing, per-source
  cursors, `lastStatus`, `pending`); the 公告文件 tab shows
  `最新报告 … · 财报更新于 …` / `排队中` / `重试中`; the Financials coverage
  line adds `财报更新于 …`. TaskDock stays news-only in the shipped cut; the
  restored shared TaskDock (`更新新闻` + `财报更新`) is the follow-up below.
- Acceptance: planned **251 checks for 236 companies** (100 EDGAR / 66
  CNINFO / 85 HKEXnews; 850 stubs excluded); cold sample AAPL 10-K + MSFT 10-Q
  detected, ingested and **340 EDGAR facts** written per company (AAPL latest
  period `2026-09-26`); steady rerun inserted/enqueued 0; HK failure backed off
  and surfaced `lastStatus=failed`; 0 LLM tokens. Tests: filings 25, worker 52,
  db 11, web 48; **363 total**.
- **Known gap:** the auto-run is one-shot. See the follow-up section below;
  A/HK is not closed until that is implemented and live-accepted.

### P1.5 follow-up — financials verification/retry (not done)

The daily path detects a new periodic report and enqueues `financials.company`
**once**. It does **not** verify that the expected period actually landed.
This is acceptable for US EDGAR (verified live) but is **not closed for A/HK**:
F10 often lags the CNINFO/HKEXnews announcement, so the one-shot run can finish
"successfully" without the new period. The `filings` row is already `applied`
and the accession is no longer new, so nothing re-triggers it.

Required follow-up (next agent):

- Persist `expected_period_end`, `financials_status`
  (`pending|applied|failed`) and `next_retry_at` on `filings` (or a separate
  `financials_refresh_state` table).
- After `financials.company`, verify `max(financial_facts.period_end)` covers
  the expected period. If not, keep `pending` and retry with 1h/6h/1d backoff
  (max N days); do not re-fetch the filing index or re-ingest the document.
- Add a `data.sweep` "financials catch-up" pass for `pending` rows.
- Live-accept A/HK with the sidecar running: `600519` / `00700`, including one
  deliberate F10-lag run (first check pending, later retry applied).
- The P1.5 cadence's slower profile/description/sector refresh
  (weekly/monthly, content-hash gated) was **not** implemented either; it is
  separate from the daily filing poll.

The shipped UI is per-company (`filingRefresh`); the news TaskDock remains
news-only in production. The **2026-11-03 decision restores the shared dock**
(news + `财报更新`) as a separate follow-up below; the manual refresh-news
button stays cancelled. Until that follow-up ships, do not describe the dock as
shared.

### P1.5 follow-up — restore shared TaskDock (news + data refresh, not done)

**Decision.** The original 2026-10-30 design (`08519b1`) was one shared
top-right dock for news + research. `fa84287` (2026-11-01) narrowed it to
news-only and cancelled the manual refresh button. On 2026-11-03 the user
restored the **shared information architecture** for the two automatic
producers; the manual refresh-news button stays cancelled.

**Target design:**

- Producers: `news_refresh` (automatic news sweep, badge `更新新闻`) and
  `data_refresh` (daily `data.sweep` → `data.source.check` →
  `ingest.filing` / `financials.company`, badge `财报更新`).
- Dock: same top-nav placement; collapsed ring/badge; expanded card with
  `全部 / 更新新闻 / 财报更新` filter tabs, per-company subtasks and the
  `queued / running / completed / partial / failed` states. Data rows should
  read like `检查中` / `无更新` / `发现 N 条` / `财报更新中` / `公告入库中` /
  `重试中`; never fake success.
- **Do not add a manual refresh-news button** (decision 34), and do not add
  `POST /v1/news/refresh` or a page-entry nudge. Retry/review buttons are not
  restored in this cut because both producers retry automatically.
- `company_research` remains operator-only (decision 34) and is not a public
  dock producer; do not wire it just because the prototype shows it.
- API: prefer one `GET /v1/tasks/status` (news + data) or extend
  `/v1/news/status` with a `data` block; keep the lazy news sweep trigger.
  `GET /v1/runs/:id` stays the per-company subtask source.
- Reuse the prototype [`docs/prototypes/task-dock.html`](docs/prototypes/task-dock.html)
  for the two-kind visual, filters and mobile/dark states; remove its manual
  controls and the `company_research` mock rows.

**Acceptance:**

- With both workers running, the dock shows the active/recent news sweep and
  the active/recent data run; the filter tabs switch between them.
- A failed HKEXnews check shows `失败/重试中`; an unchanged company shows
  `无更新`; a detected 10-K shows `财报更新中` then `已完成`.
- No refresh button anywhere; the News tab still updates automatically.
- Mobile (390 px), dark mode, `aria-live`/`progressbar`; no horizontal scroll.
- Tests cover the status mapping and the two-kind grouping; 0 LLM tokens.

### P1.5 original scope (kept for reference)

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
  **Update 2026-11-03:** the user restored the shared design; see the
  “P1.5 follow-up — restore shared TaskDock” section above. The manual
  refresh-news button remains cancelled.
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
  unless P1.5 leaves a real gap).** P1.5 shipped the deterministic daily path
  for discovery, periodic detection and financials; there is no required gap
  today. If one is ever found, the guards are: change-gated (0 LLM tokens on
  unchanged days), one call per company per changed filing, hard daily cap
  (e.g. 20 calls / 200k tokens), cheap model + low reasoning + structured
  JSON, send only the changed table/rows, content-hash cache, results go to
  the **review queue**. It must never become the daily polling loop.
- Small follow-ups: “continue research” after a budget stop; verify AI
  watchlist entries (Zhipu `02513.HK`, MiniMax listing status).
- STAR 50 backfill and any remaining HSI/CYB50 coverage: **backfill, out of
  scope for this plan**; revisit only if the universe plan changes.

### Done index (details live in the linked docs)

- 2026-11-03 — P1.5 daily company-data/financial-report refresh
  (`company_filing_state` + `filings`, `data.sweep`/`data.source.check`/
  `ingest.filing`, financials auto-rerun, 251 checks for 236 companies,
  0 LLM tokens) → [docs/REFRESH.md](docs/REFRESH.md).
- 2026-11-02 — P1.4 official filing adapters (EDGAR + CNINFO + HKEXnews +
  IR RSS/GDELT, PDF text/tables, 公告文件 tab, 0 LLM tokens) →
  [docs/FILINGS.md](docs/FILINGS.md).
- 2026-11-02 — P1.3 US 13F + HKEX DION ownership (13,009 US edges + 90 HK
  edges, 503 CUSIP ids, per-source labels, 0 LLM tokens) →
  [docs/OWNERSHIP.md](docs/OWNERSHIP.md).
- 2026-11-01 — P1.2 sector + entity resolution (235/236 sectors, 12 A/HK
  stub merges, 183 LEIs, 1 GLEIF parent edge, 98 QIDs) →
  [docs/ENTITY.md](docs/ENTITY.md). Follow-up `b19a8ef`: fixture legacy
  sectors normalized so index-page filters stay canonical.
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
- [x] P1.4: filing documents are `doc_type='filing'` with official sources,
  page-numbered chunks and a pending-free provenance block; the 公告文件 tab
  opens the original PDF/filing; rerunning a filing sync inserts 0; the
  acceptance sample is AAPL/600519/00700 (6 docs / 123 chunks). No migration.
- [x] `company_research_state`: 104 `ready` / 31 `needs_review`; review is
  operator work, not a bug.
- [x] Automatic news refresh: `global_news_last_update` is the only cursor;
  daily schedule + lazy `/v1/news/status` trigger; 3-day history; no manual
  refresh control; 0 LLM tokens.
- [x] TaskDock in the top nav and News-tab status line; tests and builds green.
- [x] P1.5: `company_filing_state` + `filings` exist; the planner covers 236
  researched companies with 251 checks (100 EDGAR / 66 CNINFO / 85 HKEXnews);
  the first check is a baseline; a cold recent periodic report enqueues
  `ingest.filing` + `financials.company` (`bypassCache`); a steady rerun
  inserts/enqueues 0; HK failures back off and surface `lastStatus=failed`;
  the company card exposes `filingRefresh`; migration `0011_filing_refresh.sql`
  applied; 0 LLM tokens.
- [x] No key/token/`.env` tracked; no NIM gateway on the default path.
- [x] `corepack pnpm -r --workspace-concurrency=1 test` green; web build green.

P1 (shipped P1.1–P1.5; two follow-ups active; see §10):

- [x] P1.1 A500 + SPX placeholders: 500 + 500 memberships, 862 stubs at
  P1.1, `occ indices sync` idempotent, searchable `未收录` pages; existing
  company rows untouched; no migration.
- [x] P1.2 sector + entity resolution: 235/236 sectors; 12 A/HK stub merges
  audited; 183 LEI / 64 USCC / 184 ISIN / 98 QID; 1 GLEIF `parent_of` edge
  with source + review item; `occ entities coverage` reports every missing
  company. Migration `0009_entity_merge_log.sql`.
- [x] P1.3 US 13F + HKEX DION ownership: 503 CUSIP ids; US dataset
  `01jun2026-31aug2026` → **13,009 edges**, 38 holders, 529 issuers, 13,009
  pending reviews; HK DION → **90 edges** (14 holders matched, 45 issuers, 10
  duplicates skipped); reruns insert 0; migration
  `0010_relation_metadata.sql`; per-source labels shipped.
- [x] **P1.3 follow-up: dense ownership graph readability (web-only).**
  `apps/web/src/lib/graph-layout.ts` + `CompanyGraph.tsx`; 48 web tests;
  screenshots/overlap report in `docs/screenshots/p1.3/`.
- [x] **P1.4 official filing adapters + PDF** (`@occ/sources-filings`,
  `ingestFilings`, `occ filings sync|coverage`, sidecar HKEXnews/PDF,
  公告文件 tab). Acceptance sample 6 documents / 123 chunks; reruns insert 0;
  0 LLM tokens; no migration.
- [x] **P1.5 daily company-data/financial-report refresh** (`data.sweep`,
  `data.source.check`, `ingest.filing`, `company_filing_state`, `filings`,
  deterministic periodic detection, `financials.company` auto-enqueue,
  `occ-refresh`, company-page status line, 0 LLM tokens). Migration
  `0011_filing_refresh.sql`. See [docs/REFRESH.md](docs/REFRESH.md).
- [ ] **P1.5 follow-up: financials verification/retry** — one-shot auto-run
  does not confirm the expected period landed; A/HK F10 lag can miss it.
  Add pending/retry state and a catch-up pass; live-accept with the sidecar.
- [ ] **P1.5 follow-up: restore shared TaskDock** — `更新新闻` + `财报更新`
  groups, filter tabs, per-company subtasks; manual refresh-news button stays
  cancelled. See §10.

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
- [`docs/OWNERSHIP.md`](docs/OWNERSHIP.md)
- [`docs/FILINGS.md`](docs/FILINGS.md)
- [`docs/REFRESH.md`](docs/REFRESH.md)
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

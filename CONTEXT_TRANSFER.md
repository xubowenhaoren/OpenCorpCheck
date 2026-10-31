# OpenCorpCheck — Context Transfer

> Handoff: **2026-10-31 (this round: HSI + reviewer + F10 relations + NIM/Parallel)**.
> The old 1,394-line document is preserved verbatim in
> [`context_transfer_history.md`](context_transfer_history.md).
>
> Current phase: Phase 0 + P1 + P2 + P2.5 + P3.1–P3.5 complete.
> **This round adds**:
> **(a) headless NIM + Parallel cutover** — the local worker pool now runs
> `deepseek-ai/deepseek-v4.1-flash` through the in-worker retry gateway
> (`apps/worker/src/nim-gateway.ts`, `127.0.0.1:4010`) and mounts Parallel's
> keyless Search MCP (`mcp__psearch__web_search` / `mcp__psearch__web_fetch`);
> the ACP sidebar is unchanged and keeps official DeepSeek + official
> search/fetch;
> **(b) HSI** — `config/indices/hsi.yaml` (85 constituents, `as_of`
> 2026-10-31), worker `--universe hsi`, F10 attached by default for A/HK;
> **(c) hidden reviewer** — `review.company` queue, official DeepSeek with
> reasoning on, structured `{verdict, issues, fix_instructions}`, bounded
> revision (`OCC_REVIEW_MAX_CYCLES=2`) then `needs_review`;
> **(d) structured F10 shareholder relations** — `gdyj` / `MajorShareholder` /
> `gbgd` tables become `reported`-status `owns` / `invests_in` edges when the
> shareholder is already in the universe.
>
> **Next after the HSI pilot/batch**: the `HK:00700` pilot completed research +
> ingest + 3 reviewer cycles and ended `needs_review` with 6 real issues (the
> gate working as designed). The 3-company cross-holding pilot (`00001` /
> `00006` / `01038`) is still finishing reviewer revisions and has already
> written real F10 ownership edges. **The full HSI batch (81 companies, run
> `a19a67ba-8739-4361-833b-6887395556ad`) is live — supervise it via §0.**
> News auto-update and A500/SPX placeholders remain §10 Next 1/2. The P3.4
> first-class sub-agent card is **deferred — not needed for this project**;
> `deep_research` stays a tool card.
>
> **Scope change (2026-10-30, revised 2026-10-31)**: placeholder coverage
> expands to **CSI A500 (中证A500, 000510) + S&P 500 (SPX)**. Every constituent
> not already in the DB gets a stub company page storing only ticker +
> Chinese/English name + index membership. **Neither index gets a bulk
> backfill, and there is no in-app on-demand research**: data is filled only by
> an explicit, capped **local operator batch** through the worker pool. P4 bulk
> backfill (STAR50 + ChiNext50 + HSI) is unchanged.
>
> **Scope change (2026-10-29)**: A-share backfill = **STAR 50 (科创50, 000688) +
> ChiNext 50 (创业板50, 399673)**. Hang Seng backfill unchanged. **S&P 500 (SPX)
> backfill cancelled.** NASDAQ-100 already backfilled (100 companies).
> Synthetic seed fixtures still carry legacy A500/SPX memberships
> (`apps/cli/src/seed-data.ts`); they are E2E fixtures, **not** the v1 plan.
>
> **Machine constraint**: the current machine is a macOS VM and **cannot run
> Docker**. P5 (Docker/Electron packaging) is deferred. Development uses native
> Postgres 17, Qdrant 1.18, uv sidecars and Node 24. Cross-platform macOS +
> WSL2/Linux remains a v1 requirement: no OS-specific branches, use
> `node:path`/`URL`, and keep scripts working on Darwin and Linux.

---

## 0. LIVE STATE — HSI backfill in progress (read first)

> Snapshot: **2026-10-31 13:39 PT**. This section is authoritative for the
> in-flight batch; later numbers will change. The next agent's job is to
> **supervise, not re-enqueue**.

### 0.1 Running processes

| PID | Started | What |
|---|---|---|
| `86264` | 13:16 | cross-holding pilot worker (`work --queues research,ingest,review,f10 --drain`); **owns the NIM gateway on :4010** |
| `88701` | 13:26 | full HSI batch worker; `OCC_RESEARCH_CONCURRENCY=2`, `OCC_INGEST_CONCURRENCY=2`, `OCC_REVIEW_CONCURRENCY=1` |
| `89118` | 13:28 | shell waiter: polls :4010, then `exec node apps/worker/dist/nim-gateway-server.js` |

Do **not** start a third worker without checking :4010. If the cross worker
exits first, the waiter binds the standalone gateway within ~2 s; the batch
worker keeps using `127.0.0.1:4010`. If all workers/waiter are gone, resume
with:

```bash
cd /Users/bowenxu/Downloads/Projects/OpenCorpCheck
node apps/worker/dist/cli.js work --queues research,ingest,review,f10 --drain
```

This picks up queued/retry jobs from pg-boss. **Never re-run `enqueue research
--universe hsi`** for the same targets — that creates a second run and duplicate
LLM work. The batch is durable in `pgboss` + `backfill_jobs`.

If the gateway is down (worker reports connection refused / `PI_AI_ERROR`
without retries), start it manually:

```bash
node apps/worker/dist/nim-gateway-server.js
```

### 0.2 Runs

| Run id | What | Status at snapshot |
|---|---|---|
| `a19a67ba-8739-4361-833b-6887395556ad` | **full HSI batch**, 81 targets; excludes pilots `00700,00001,00006,01038` | running |
| `5e7da4c4-4aa8-4c28-aa41-7f8604cabc60` | cross-holding pilot `00001` / `00006` / `01038` | running (reviewer revisions) |
| `b9d9b644-58c9-4ee1-b58a-f0401eecbc75` | `HK:00700` pilot | partial; `needs_review` after 2 revisions |

### 0.3 Counts at snapshot

- research queue: `created=76 retry=1 active=6 completed=127` (all runs)
- ingest queue: `completed=119`, no active
- review queue: `completed=14 active=1`
- `company_research_state`: `running=14 reviewing=1 queued=68 needs_review=1 failed=1`
- `HK:00101` is **failed** with `dsh: PI_AI_ERROR: Internal server error` — an
  episodic NIM 500 that escaped the gateway. pg-boss has a retry pending; a
  failed row with `retry`/`attempts` is not terminal. Do not “fix” it by
  re-enqueueing the universe.
- `relations.status='reported'`: **4** (CK group + 恒基兆业地产→香港中华煤气; see
  §2 verified list).
- `index_memberships` HSI `as_of=2026-10-31`: **7** (grows as batch completes).
- The `research.company` retry count can rise from NIM 500s; only dead-lettered
  jobs (`*.dead`) or a run with `failed_jobs > 0` need operator action.

### 0.4 Monitor commands

```bash
cd /Users/bowenxu/Downloads/Projects/OpenCorpCheck

node apps/worker/dist/cli.js status --run a19a67ba-8739-4361-833b-6887395556ad
node apps/worker/dist/cli.js states --limit 100

# queue depth / pending jobs
node apps/worker/dist/cli.js status --json | jq '.counts'

# HSI members and reported edges
psql postgres://occ@127.0.0.1:5432/occdb -c \
  "select count(*) from index_memberships where index_code='HSI' and as_of='2026-10-31';"
psql postgres://occ@127.0.0.1:5432/occdb -c \
  "select status,count(*) from relations group by 1;"
```

### 0.5 What “normal” looks like

- **NIM 500s are episodic.** The gateway retries 3×; dsh can still surface
  `PI_AI_ERROR`, which pg-boss retries. One failed company is not a reason to
  stop the batch.
- **`needs_review` is success of the gate**, not a bug. The reviewer is strict
  and finds real numeric/citation issues. Do not flip `needs_review` to
  `ready`, and do not raise `OCC_REVIEW_MAX_CYCLES` in production.
- **`backfill_runs.total_jobs` grows** when the reviewer enqueues another
  research/ingest/review cycle. Use `status`/`states`, not the original 81.
- The full batch was started with two concurrent workers; running a single
  worker with the default `OCC_RESEARCH_CONCURRENCY=4` on resume is fine.
- F10 page JSON under `.occ/f10/` is the source for the post-batch relations
  pass; do not delete it.

### 0.6 When the batch is done

```bash
node apps/worker/dist/cli.js status --run a19a67ba-8739-4361-833b-6887395556ad
# expect status completed|partial, research created/active/retry = 0

node apps/worker/dist/cli.js states --limit 100
# expect ready / needs_review / failed counts; needs_review is operator work

node apps/worker/dist/cli.js relations f10 --universe hsi
# re-resolve cached F10 pages now that all HSI companies exist
```

Then verify `/v1/indices/:code` / `/indices/HSI` shows the members and spot-check
the graph for the CK group (`00001` / `00006` / `01038`) and a few bank/insurer
names. Report the final counts, not a claim that every company passed review.

### 0.7 Commits from this round

- `039a38c` HSI pipeline / NIM + Parallel / reviewer / F10 relations
- `81260bd` standalone NIM gateway + shared-port health recheck
- `76aa5c2` research prompt: verify cited URLs / strip process residue
- `51caabf` handoff: HSI cross-holding edges and batch run
- `5358580` jobs: reset research state counters on a new queued run
- `95395a0` handoff: live HSI batch supervision state

---

## 1. What this is

OpenCorpCheck is an open, agentic, provenance-first company intelligence store.
Every number/relation should link back to a source; the agent can propose facts
but cannot write verified data directly.

**v1 universe** (~280 research-filled companies, ~1,000 placeholder rows,
plus an AI watchlist and on-demand private companies):

| Index | Code | Market | Status |
|---|---|---|---|
| CSI A500 / 中证A500 | `000510` | A | **placeholder (planned)**: stub pages, filled only by operator batches |
| S&P 500 | `SPX` | US | **placeholder (planned)**: stub pages, filled only by operator batches |
| STAR 50 / 科创50 | `000688` | A (SSE) | planned bulk backfill (P4) |
| ChiNext 50 / 创业板50 | `399673` | A (SZSE) | planned bulk backfill (P4) |
| Hang Seng Index | `HSI` | HK | **snapshot added 2026-10-31**: 85 constituents in `config/indices/hsi.yaml`; pilot → full batch in progress |
| NASDAQ-100 | `NDX` | US | **done**: 100 companies backfilled |

- **A500 and S&P 500 have no bulk backfill and no in-app on-demand research.**
  They are placeholder pages; an operator fills companies through an explicit,
  capped local batch (decision 2026-10-31). Cost data:
  [`docs/NVIDIA_NIM_MIGRATION.md`](docs/NVIDIA_NIM_MIGRATION.md) §2/§5.
- Placeholder rows are intentionally minimal: ticker, Chinese/English name,
  market and index membership. No profile, documents, financials or embeddings
  until an operator-run batch fills them.
- AI watchlist (~24 names: OpenAI, Anthropic, DeepSeek, Moonshot/Kimi, Zhipu,
  MiniMax, ByteDance, Huawei, …) lives in [`config/universe.yaml`](config/universe.yaml).
- The product is exposed through a web UI, CLI, MCP server and a DeepSeek
  Harness (dsh) ACP sidebar. Phase 0 validated the headless dsh research path.

---

## 2. Current state (2026-10-30)

- **LLM/search providers — dual mode (decision 2026-10-31)**:
  - **Interactive ACP sidebar** = paid **DeepSeek API** (`deepseek-flash`) +
    `deepseek-official` search/fetch. Unchanged; the user's key stays.
  - **Local headless backfill / worker pool** = **NVIDIA NIM**
    (`deepseek-ai/deepseek-v4.1-flash`, free tier) + **Parallel Search MCP**
    (`https://search.parallel.ai/mcp`, keyless).
  - The repo keeps `DEEPSEEK_API_KEY.txt` for the sidebar and gains a
    gitignored `NVIDIA_API_KEY.txt` for the worker. The assistant's coding
    session key is outside the repo and must not be touched. Measured NIM
    behaviour: [`docs/NVIDIA_NIM_MIGRATION.md`](docs/NVIDIA_NIM_MIGRATION.md).
- **Phase 0**: 7 MAG7 profiles generated by dsh headless with
  **`deepseek-flash`** (not Pro). Validation PASS; deliverables under
  [`phase0/out/`](phase0/out/). Historical detail in the archive.
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
- **P0 headless cutover (2026-10-31)**: worker research = NIM
  `deepseek-ai/deepseek-v4.1-flash` via `apps/worker/src/nim-gateway.ts`
  (retry + `reasoning_content` normalisation + 36 RPM bucket) and Parallel
  Search MCP. ACP sidebar unchanged. Rollback:
  `OCC_LLM_PROVIDER=deepseek`.
- **HSI (2026-10-31)**: `config/indices/hsi.yaml` + worker `--universe hsi`;
  A/HK research attaches F10 by default. Pilot on `HK:00700` exercises
  research → ingest → reviewer → revise.
- **Reviewer (2026-10-31)**: `review.company` queue + `company_research_state`;
  official DeepSeek with reasoning on, structured JSON, max 2 revisions, then
  `needs_review`. `occ-backfill states` exposes operator status.
- **Structured F10 relations (2026-10-31)**: A `gdyj` / HK
  `MajorShareholder` / US `gbgd` shareholder rows become `reported`-status
  `owns`/`invests_in` edges when the shareholder is in the company universe;
  page JSON cached under `.occ/f10/`.

Verified numbers worth keeping:

- Visible corpus: **102 real profiles**, NDX 100 + 600519/00700; 14 synthetic
  companies / 31 fixture documents remain in the DB but hidden.
- Agent regression question (“goog 今天股价大跌，是什么原因？”): **57 s /
  15 tool calls / 7 sources** with a cited Markdown answer after the budget
  fix. The old failure was 32 distinct calls in 95 s with no repeats.
- Graph: AAPL 3 edges, ARM 8, NVDA 14; 2-hop NVDA 26 nodes.
- Search p95 (no rerank): companies 218–300 ms, documents 366–473 ms.
- Build: web main JS 399 KB (gzip 123 KB), lazy Markdown chunk 163 KB
  (gzip 49 KB), CSS 42.8 KB (gzip 8.8 KB).

Verified this round (2026-10-31):

- NIM probe: dsh headless returns `OK`; Parallel search returns ranked URLs;
  F10 `CompanyProfile` on HK `00700` works through `mcp__occ__f10_scrape`.
- `HK:00700` pilot on NIM: research **289 s** / 99k input + 6k output tokens,
  ingest **27 s** / 16 chunks, reviewer **73 s** per cycle. The reviewer found
  6 real issues (OCF vs FCF reconciliation, a mismatched citation, source-count
  mismatch, a meaningless sentence, wrong interest-coverage definition, mixed
  single-quarter/cumulative columns); after 2 revisions it correctly ended
  **`needs_review`** instead of pretending success. This is the intended
  quality gate; the profile is still ingested and visible.
- F10 shareholder parsing verified against the real `00006` page: 长江基建
  (`01038`) and 长江和记 (`00001`) resolve to `invests_in` edges at 36.01%.
  The live cross-holding pilot also wrote real `reported` edges:
  **长江和记 owns 75.67% of 长江基建**, **长江和记 / 长江基建 each
  invest_in 電能實業 (36.01%)**, and **恒基兆业地产 invest_in 香港中华煤气
  (41.53%)** — with evidence quotes, F10 URLs and review items.
- Reviewer with the stricter prompt/content checklist now has only
  web search/fetch tools; file/shell/sub-agent tools are disabled.

Tests (serial, because parallel vitest workers collide on
`node_modules/.vitest-cache`): `corepack pnpm -r --workspace-concurrency=1 test`.
Current counts: API 30, agent 17, web 22, ingest 39, extract 22, worker 26,
CLI 7, retrieval 10, db 9, storage 5, sources 13 (F10 9 + news 4). All green.

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
    UI.md  EXTRACT.md  AGENT.md  NEWS.md
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
    sources/news/                  # Google News RSS adapter
  services/
    finance-analyst/               # Python sidecar: A/HK/US F10 (uv + Playwright)
    embeddings/                    # local BGE-M3 / reranker sidecar
  scripts/
    dev-db.sh dev-qdrant.sh dev-embeddings.sh dev-minio.sh e2e-search.sh
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
| `DEEPSEEK_API_KEY` / `_FILE` | required by the **ACP sidebar** (official API), ingest/extraction and the **reviewer** |
| `NVIDIA_API_KEY` / `_FILE` | required by the **headless research worker** (NIM); `NVIDIA_API_KEY.txt` is gitignored |
| `OCC_LLM_PROVIDER` | `nvidia` (worker default); `deepseek` rolls back research |
| `OCC_NIM_GATEWAY_PORT` / `OCC_NIM_RPM` | `4010` / `36` |
| `OCC_REVIEW_MAX_CYCLES` | `2` (then `needs_review`) |
| `OCC_F10_RELATIONS` | `on`; `none` disables structured shareholder extraction |

`OCC_AGENT_DSH_PATCH` defaults to `.dsh/acp.patch.yml`; pass `none` to disable
the ACP overlay. The overlay sets `reasoningEffort: low` on `llm-deepseek` (ACP
does not read `agent-default-model`; the adapter has no `medium`). `dsh --patch`
replaces an entry's `config` wholesale.

---

## 5. Web UI (P3.5)

React 19 + Vite 8 + TypeScript + React Router 7 + TanStack Query 5. Styles use
the prototype CSS tokens; **no Tailwind/shadcn**. Vite dev binds
`127.0.0.1:5173`, proxies `/v1` to `127.0.0.1:8787`. Production static hosting
is still TODO.

Pages:

- `/` — hero search, hot companies (static list), market shortcuts, NDX entry,
  recent views (`localStorage`).
- `/search?q=` — company hybrid search with market/index/sector filters. Rows
  show name, ticker, country, sector, indices and a two-line description; no
  score/matchType. Short Chinese queries with no exact/alias/fuzzy hit and a
  low dense score show “没找到 + 问助手” instead of unrelated vector neighbours.
- `/c/:ref` — ticker, slug, Chinese alias or ULID. Five tabs:
  基本资料 / 财务数据 / 关系图谱 / 新闻动态 / 资料来源.
  - Overview: one-line summary, segment bars, key numbers, recent events, and
    right-column shareholders/investments/related companies.
  - Financials: metric cards + annual/quarterly tables by statement; every
    cell can open its source; native currency formatting.
  - Graph: 1/2 hops, type filter, verified-only, graph/list toggle, zoom/drag,
    node/edge inspector with evidence quote + source, empty state.
  - News: timeline with source popovers.
  - Sources: grouped by trust tier, deduped, copy-all-citations.
- `/graph?company=` — global ego network with company picker.
- `/indices/NDX` — 100 QQQ constituents; planned A/HK index pages show the
  not-loaded state. The UI filter codes are
  `["NDX", "STAR50", "CYB50", "HSI"]` (SPX/A500 removed from the picker).
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
- `GET /v1/indices/:code` — constituents (NDX works; other codes 404 until
  loaded), with ticker/sector/markets/as_of.
- `GET /v1/sectors` — industry filter values (fixtures hidden).
- `GET /v1/search/companies` — new `sector` filter.
- `GET /v1/agent/sessions` — persisted dsh sessions for the history menu
  (title, prompt count, updated time; subagent children excluded).
- `GET /v1/agent/sessions/:id/replay` — persisted turns + tool calls from
  dsh's `session.v4.jsonl.zstd`; 404 when no log exists.
- `@occ/db` — `listIndexCompanyIds`, `listSectors`.
- `@occ/core` — `CompanyGraphQuerySchema`, `CompanyGraphView`,
  `IndexMemberView`, `IndexView`; `SearchCompaniesQuery.sector`.

Known limitations:

- Investment/equity relations are sparse: only `partners_with` / `supplies` /
  `other` / `buys_from` / `licenses_to` / `joint_venture_with`; no
  `invests_in` / `owns` / `parent_of` yet. Do not fake edges in the UI.
- Many NDX companies have `sector = null`; the index page shows `—`.
- English mode translates UI chrome only; company descriptions stay as sourced.
- Hot companies are a static front-end list; there is no admin backend.
- News is a static DB snapshot: no refresh button and no automatic stale sweep
  yet; ingestion is CLI/worker-only (planned in §10 Next 1). The source is
  Google News RSS, not agentic search, so a refresh costs 0 LLM tokens.
- No web unit tests beyond trajectory helpers; acceptance is currently
  Playwright/manual.
- Production static hosting (API/nginx same-origin) is still TODO.

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
- **News** (`packages/sources/news`): Google News RSS, link-only, ~10 items /
  company / 30 days, `doc_type='news'`. No full-text fetch or redistribution.
  Ingestion is deterministic and LLM-free; today it runs only through the
  `news.company` worker queue (`occ-backfill enqueue news`). Manual refresh and
  stale sweep are §10 Next 1.
- **F10** (`services/finance-analyst` + `packages/sources/eastmoney-f10`):
  A/HK/US structured pages, per-domain rate limits, table/XHR extraction,
  2 MB cap, retries + jitter. Eastmoney data is for internal demo + attribution.

---

## 8. Key decisions (active)

1. **TypeScript everywhere**, except the Python + Playwright F10/EDGAR/HKEX
   sidecar.
2. **Qdrant** for hybrid retrieval; pgvector/ParadeDB are fallbacks. Do not turn
   Postgres into the search engine.
3. **dsh headless** for company research (operator-invoked; a batch is explicit
   and capped, never a full-index sweep); **ACP** for the interactive sidebar.
4. **Dual-mode providers (revised 2026-10-31)**. Interactive ACP sidebar =
   official **DeepSeek API + `deepseek-official` search/fetch** (fast, paid,
   low volume, no migration). Local **headless backfill/worker pool** =
   **NVIDIA NIM `deepseek-ai/deepseek-v4.1-flash`** + **Parallel free Search
   MCP**; never write `deepseek-v4-pro` back into config. Slightly lower
   Chinese news quality in backfilled data is accepted for a tech demo. The
   DeepSeek key stays in the repo for the sidebar; the coding session keeps
   its own copy.
5. **No Docker on this machine**; use native services. Cross-platform support
   (macOS + WSL2/Linux) is still required; Electron/Docker stay in P5.
6. **Universe scope (2026-10-29, updated 2026-10-31)**: STAR 50 + ChiNext 50 +
   HSI + NDX + AI watchlist + on-demand private companies. **A500 and S&P 500
   have no bulk backfill and no in-app research** — placeholders filled only by
   explicit, capped operator batches. NDX is done; A/HK are P4.
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
29. **News refresh is idempotent and server-deduped**: one active news run per
    company; stage 2 stale sweeps run server-side and multiple browser tabs
    only nudge them. Track `news_updated_at` per company; TTL is configurable.
30. **Placeholders are first-class rows, not seed data**: `coverage_tier='stub'`
    + `is_placeholder=true`, only ticker + Chinese/English names + index
    membership. They are excluded from default semantic search, listed on index
    pages and reachable by direct `/c/:ticker`; never overwrite a real profile.
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
33. **One shared task dock, news-only** (decision 2026-10-31): the **top-nav**
    control (last item after `EN` / `深色`) has exactly one producer,
    `news_refresh` (badge “更新新闻”). No `company_research` rows, no filter
    tabs. The prototype (commit `dd465fc`) is approved; only its news path is
    wired.
34. **No in-app on-demand stock research** (decision 2026-10-31): the
    placeholder CTA and `POST /v1/companies/:ref/research` are cancelled.
    Research is operator-initiated through the local worker pool (explicit,
    capped batches). On-demand **news refresh** stays because it is LLM-free.
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
| `deep_research` returns 400 for private companies | It requires a recognized exchange listing. Private companies go through CLI/backfill until P4 entity resolution. |
| `deep_research` is async | Poll `get_run`; research completion automatically enqueues `ingest.company`. |
| News ingestion says `company not found` | Ingest the company profile first. |
| Google News RSS is link-only, ~10/company | Don’t fetch/redistribute full text; add a separate adapter for bodies. |
| News rerun shows `skipped=5` | Idempotent title+summary sha256; not a failure. |
| “刷新新闻”完成但 UI 不变 | News events come from `documents` via `listEvents`; invalidate the company query after the run completes instead of relying on a cached response. Do not pass `force=true` for unchanged items. |
| Two tabs trigger two news refreshes | Server-side dedupe with one active run per company; the page-entry call is only a nudge, not the scheduler. |
| Placeholder companies pollute search | Default search excludes `is_placeholder`; index pages/direct routes include them with a “未收录” badge. |
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

## 10. Next tasks

### Next 0 — Headless-provider cutover only (P0, dual-mode)

**Status 2026-10-31: implemented.** NIM provider + gateway + Parallel MCP are
wired for the worker; the ACP sidebar is untouched. Acceptance probes:
engine chat, Parallel `mcp__psearch__web_search`, F10 `mcp__occ__f10_scrape`,
and a reviewer turn all succeeded. Remaining: finish the HSI pilot/batch
measurement and record final latency/500 counts.

**Decision (revised 2026-10-31): two provider routes, not one.**

| Route | Inference | Search/fetch | Why |
|---|---|---|---|
| **ACP sidebar** (browser Q&A) | official DeepSeek API, `deepseek-flash` | `deepseek-official` | Latency + quality matter; volume is tiny; **no changes at all** |
| **Headless worker pool** (local backfill) | NVIDIA NIM `deepseek-ai/deepseek-v4.1-flash` | Parallel Search MCP (keyless) | Batch, unattended; free tier is acceptable |

The repo **keeps** `DEEPSEEK_API_KEY.txt` (sidebar) and gains a gitignored
`NVIDIA_API_KEY.txt` (worker). The coding session's own key is outside the
repo and untouchable. Plan, measured data, touchpoints and rollback:
[`docs/NVIDIA_NIM_MIGRATION.md`](docs/NVIDIA_NIM_MIGRATION.md).

Key facts to carry in:

- NIM is OpenAI-compatible (`https://integrate.api.nvidia.com/v1`), ~40 RPM
  free tier, no card, no SLA; `/v1/models` currently lists 85 models including
  `z-ai/glm-5.3-flash`, `moonshotai/kimi-k2.6` and the two DeepSeek ones.
- **Measured 2026-10-31 (same prompts, ~35 RPM):** DeepSeek v4.1-flash p50
  8–17 s, p95 35–62 s, with **episodic 500s** (3/10 in one batch, 0/10 in the
  next) and occasional empty `content`. GLM-5.3-flash is faster on trivial
  calls but needs **67–118 s** for Chinese long-form and timed out at 120–150 s
  repeatedly — **rejected** for the backfill path.
- **NIM quirks that must be coded for:**
  - `response_format: json_object` / `json_schema` returns 200 but puts the
    JSON in `reasoning_content` and leaves `content` empty — unless
    `thinking: false` is set (then it is correct and fast).
  - Thinking tokens count against `max_tokens`; a small budget yields an empty
    `content`. Use `max_tokens ≥ 512` for extraction, more for research.
  - Unknown parameters are rejected with `400 Validation: Unsupported
    parameter(s)`; `thinking`, `reasoning_effort: "none"` and
    `chat_template_kwargs` are accepted.
- **Step-level retry is mandatory.** A single 500 must not kill an 18-step
  company run: 3 attempts with backoff (500s return in <3 s, so retries are
  cheap), plus a `content`-empty fallback to `reasoning_content`. Prefer a
  small local OpenAI-compatible gateway (~100 lines) in front of NIM so both
  the dsh adapter and `packages/extract` get retry/normalisation in one place.
- **Timeout headroom:** raise the headless research timeout (not
  `OCC_AGENT_TURN_TIMEOUT_MS`, which stays 180 s for the sidebar); p95 per
  call is ~60 s, so one company can take several minutes.
- **Not migrated on purpose:** LLM relation extraction (`packages/extract`) and
  the reviewer agent stay on **official DeepSeek with reasoning on** — quality
  matters there and volume is low. The worker therefore carries **both** keys,
  with a per-job env whitelist (research → NVIDIA only, reviewer/extraction →
  DeepSeek only).
- Parallel is keyless and free, no quota/SLA. It exposes `web_search` and
  `web_fetch`; mount it with `@deepseek-ai/dsh-mcp-client`
  (`transport: streamable-http`) **in the headless profile only**. Tools become
  `mcp__psearch__web_search` / `mcp__psearch__web_fetch`; update the headless
  prompt, skills, `phase0/lib/validate.mjs`, `phase0/lib/dsh.mjs` URL
  extraction (fetch input is a `urls` array) and their tests. **Leave the ACP
  patch, `apps/web/src/lib/agent-trace.ts` and the sidebar alone.**
- Parallel quality trade-off (measured 2026-10-30): slower search (0.8–1.4 s
  vs 0.55 s), much faster fetch (0.16 s typical), better US/English official
  sources, weaker Chinese/HK freshness (Tencent top results included 2022
  pages). Accepted for backfilled data.
- **No paid fallback.** One retry + plain-HTTP fetch for non-JS pages; if
  Parallel is down the batch fails loudly.

Acceptance and rollback are in the migration doc §7–8. The sidebar path is
explicitly out of scope: its DeepSeek key, model row, timeout and
`reasoningEffort` must remain byte-for-byte unchanged.

### Next 1 — News auto-update (after the NIM + Parallel migration)

**Source facts (verified 2026-10-30).** The news tab is **Google News RSS**, not
agentic search: [`packages/sources/news/src/google-news.ts`](packages/sources/news/src/google-news.ts)
fetches `news.google.com/rss/search` (one request per company, 10 items / 30
days, link-only, no article bodies). [`packages/ingest/src/news.ts`](packages/ingest/src/news.ts)
writes `documents(doc_type='news')` + one chunk + one source row and indexes
the chunk; it is idempotent by title+snippet hash. The UI reads
[`listEvents`](packages/db/src/repositories/insights.ts) from Postgres. **The
refresh path must stay LLM-free: 0 LLM tokens; only local BGE-M3 embedding,
and unchanged items skip embedding.**

Stage 1 — manual refresh (per company):

1. Add a **刷新新闻** button to the News tab header
   ([`CompanyNews.tsx`](apps/web/src/components/CompanyNews.tsx)); states
   `idle → refreshing → done | error`, disabled while a refresh is active.
2. New API: `POST /v1/companies/:ref/news/refresh`.
   - Resolve the company; reject fixtures and placeholders (no profile → no news).
   - Deduplicate: if an active/recent news run for this company exists, return
     it instead of enqueueing a second job (unique run/job key per company +
     window).
   - Enqueue the existing `news.company` pg-boss queue (2 retries, polite RSS);
     respond `202 { runId, status }`.
3. Persist a company-level timestamp on success (and on a successful empty
   check): add `companies.news_updated_at` (or a small
   `company_refresh_state` table). This is also the stage-2 input.
4. UI polls the run (`GET /v1/runs/:runId` or a dedicated news status endpoint)
   every ~1 s while visible; on `completed` invalidate the company query so the
   list re-renders without a reload. Toast: “已更新 N 条” / “已是最新” / error.
5. Do not pass `force=true` for normal refreshes: unchanged articles must not
   re-embed.

Stage 2 — automatic stale sweep:

1. On entering any page, the client calls `POST /v1/news/refresh` (cheap,
   idempotent). The server selects companies with
   `news_updated_at < now() - ttl` (exclude fixtures/placeholders), caps the
   sweep (`OCC_NEWS_REFRESH_BATCH`, e.g. 50), and enqueues one `news` run with
   one job per stale company.
2. **The server owns dedupe** (advisory lock / unique run per sweep); multiple
   tabs must not fan out. A pg-boss schedule (e.g. every 15 min) should do the
   real sweep; the page-entry call only nudges it.
3. TTL: `OCC_NEWS_REFRESH_TTL_MS`, default 24 h. Respect Google News terms: one
   request per company, reuse `newsConcurrency`, per-domain rate limits.
4. UI: **reuse the shared top-nav task dock** (defined in Next 2) with task
   kind `news_refresh`. Do not build a separate news progress widget: the dock
   shows one group “更新新闻 · 42 家公司” with per-company subtasks and the
   same completed/failed states as research.

Acceptance:

- Manual refresh shows new items without a full reload; unchanged refresh is a
  clear no-op (“已是最新”).
- Two clicks / two tabs produce one job.
- Stage 2 enqueues stale companies once after TTL; a second page entry before
  TTL does nothing.
- No LLM API call anywhere in the refresh path; embeddings are local.

### Next 2 — A500 + S&P 500 placeholders + local research/reviewer worker pool

**Status 2026-10-31**: the reviewer half is implemented (`review.company`,
`company_research_state`, bounded revisions, `occ-backfill states`). The
A500/SPX placeholder half (index snapshots, `occ indices sync`, placeholder
pages) is still pending. HSI is the first end-to-end user of the research +
reviewer pipeline.

**Scope.** Add index snapshots `config/indices/a500.yaml` (CSI A500, `000510`)
and `config/indices/sp500.yaml` (`SPX`), each with `as_of`, optional weights and
license/source. `occ indices sync` (new command) inserts a **placeholder** row
for every constituent not already resolvable by ticker+exchange/name. A real
profile is never overwritten.

**No in-app on-demand research (decision 2026-10-31).** The placeholder CTA,
`POST /v1/companies/:ref/research` and the whole user-triggered research flow
are **cancelled**. Placeholders are filled only when the operator runs a local
batch through the worker pool (NIM + Parallel). There is still **no full
constituent sweep**: A500/SPX batches are explicit, capped and operator-started.
On-demand **news refresh** stays (Next 1, 0 LLM tokens).

Placeholder row:

- `companies.coverage_tier='stub'`, `is_placeholder=true`, market,
  `display_name`, `name_en` / `name_zh` (or aliases when one language is
  unknown), `profile={}`.
- `index_memberships` rows for `A500` / `SPX` with `as_of`.
- **No** documents, chunks, financials, embeddings or profile sections.
- Default semantic search excludes placeholders; index pages and direct
  `/c/:ticker` routes include them. An exact ticker/name match may show a row
  with a “未收录” badge.

Placeholder page:

- `/c/:ref` resolves the ticker; render names, ticker, market, index/weight and
  a “尚未收录” state. **No CTA** — show a short neutral note that data is
  filled by the operator (e.g. “数据由运营侧批量补充”), never a fake progress
  bar. Other tabs stay empty (no fake data).
- No new endpoint is added. The page is read-only.

Pipeline and worker pool (operator-invoked):

- **Do not adopt a DSH batch plugin.** The durable queue and worker pool are
  already [`pg-boss`](packages/jobs/src/queues.ts) + [`apps/worker`](apps/worker);
  DSH is the executor only: one `dsh --profile headless` process per company via
  [`runDshResearch`](apps/worker/src/research/dsh.ts). Headless runs use the
  NIM + Parallel profile (Next 0); the ACP profile is untouched.
- Entry point is the local CLI/worker (e.g. `occ-backfill enqueue research
  --index A500 --limit N`), never a web route. Any batch must preview its count
  and enforce `OCC_RESEARCH_BATCH_MAX` (default 20); no command accepts “all
  constituents”.
- State machine per company: `queued → running → reviewing → ready`, with
  terminal `failed` / `needs_review`. Store it in a small
  `company_research_state` table (company_id PK, status, run_id, attempts,
  review_attempts, last_error, requested_at, updated_at) for operator
  visibility; keep detailed run/checkpoint rows in the existing run store.
- Retries/timeouts: **step-level retry (3 attempts, backoff) is mandatory** for
  NIM's episodic 500s and empty `content`; pg-boss `retryLimit` is the outer
  net, not the primary defence. Raise the headless research timeout (NIM p95
  ≈ 60 s/call); one active job per company (unique key).
- Worker concurrency: configurable (start 2–4, ≤ 36 RPM total) to respect the
  NIM free tier; queue backpressure rather than unbounded fan-out.

Reviewer agent (after research + ingest) — **official DeepSeek, reasoning on**:

- Enqueue `review.company` (new queue) or run it as a second phase of the same
  job. It is a second **headless dsh** run with a checklist prompt: numbers
  match cited sources, relations have evidence, no unsupported claims, required
  profile sections present.
- **Provider (decision 2026-10-31):** the reviewer gets its own dsh profile on
  the **official DeepSeek API** with reasoning enabled — not NIM. The review is
  the quality gate; NIM's reliable structured-output mode requires
  `thinking:false`, which defeats the purpose. Volume is 1–3 runs per company.
  Spawn it with a DeepSeek-only env whitelist (research children get
  `NVIDIA_API_KEY` only, reviewer children get `DEEPSEEK_API_KEY` only).
- Structured output:
  `{ verdict: "pass" | "revise", issues: [{field, reason, evidence}], fix_instructions }`.
  On NIM this requires `thinking:false` + a generous `max_tokens` (JSON lands
  in `reasoning_content` otherwise).
- `pass` → mark `ready`; `revise` → re-enqueue research with the feedback,
  **max 2 review cycles**, then `needs_review`; `needs_review` is visible to the
  operator (review queue/logs), not as a fake success.
- The reviewer is **hidden in the UI**; only aggregate status, counts and token
  usage appear in the progress dock.

Shared task dock (top nav, last control after `EN` / `深色`):

- One global `<TaskDock>` mounted in the **top navigation**, as the last control
  after `EN` and `深色`, visible across routes; modeled on the browser download
  bubble. It is **not** a per-page widget and there is only one of it.
- **News is the only producer** (`news_refresh`, badge “更新新闻”): one group
  per sweep, “更新新闻 · 42 家公司”, completion “已更新 128 条 · 3 家失败”.
  There is **no `company_research` producer** (decision 2026-10-31): operator
  batches are local-only and are not mirrored into the dock.
- Collapsed button: ring shows aggregate progress; a count badge appears when
  tasks are active. Expanded card header: overall `12/37 · 32%` and a
  “查看全部任务” footer. With one task kind, no filter tabs.
- Each row: badge, title, status line (`更新中 12/42 · 28%`, `已完成 — 128 条`,
  `2 家需要重试`), determinate or step-based progress bar, elapsed time, and a
  chevron for subtasks. A failed/needs-review row keeps its error reason;
  clicking a company row navigates to `/c/:ticker`.
- States: `queued`, `running`, `completed`, `partial`, `failed`,
  `needs_review`. Color encodes state (semantic, not accent-only); text always
  names the state too. Use `role="progressbar"` with `aria-valuenow` and a
  polite live region for completion; respect `prefers-reduced-motion`.
- Data source: one polling manager per active run (`GET /v1/runs/:runId` every
  1–2 s while the dock is open; slower when collapsed). Polling is DB/API only —
  no LLM. Closing/minimizing the dock does not cancel.
- Mobile: the card becomes a full-width sheet under the header; never causes
  horizontal scroll.

**Prototype status.** The standalone dock prototype was approved and placed in
the top nav on 2026-10-30 (commit `dd465fc`). It renders both task kinds, but
the production component wires **only `news_refresh`**; the
`company_research` kind is not built (decision 2026-10-31).

Acceptance:

- A500 + SPX seed: constituent count minus already-present companies; no
  duplicate slugs/tickers; existing real profiles untouched; placeholders have
  no documents/embeddings.
- **No** route, endpoint or UI action can enqueue research; the placeholder page
  is read-only with no CTA.
- A local capped batch runs end-to-end through the worker pool on NIM/Parallel
  and never appears in the dock.
- Reviewer `revise` triggers exactly one bounded retry cycle; repeated failure
  ends in `needs_review` and is logged.
- A single NIM 500 or empty response does not fail an 18-step company run
  (step-level retry verified with injected failures).
- Any batch is explicit, capped at `OCC_RESEARCH_BATCH_MAX`, and shows its count
  before enqueueing.
- No reviewer internals or raw JSON in the UI.

Token discipline:

- News refresh: **0 LLM tokens**.
- Research: one headless run per company, operator-invoked only; reviewer adds
  one run per attempt; at most 2 revisions. **No bulk pre-research of A500/SPX.**
- The only batch path is an explicit, capped operator command. No endpoint,
  CLI command or scheduled job accepts “all constituents”.
- Progress polling and page refreshes never call an LLM.

### Wider agent sidebar — done 2026-10-29

- The AI assistant sidebar is **35% of the page width** on desktop
  (`35vw` on `.ask-sidebar`, hardcoded in
  [`apps/web/src/styles.css`](apps/web/src/styles.css)). No drag-to-resize.
- Layout offset matches (`body.ask-open .app-shell { padding-right: 35vw }`,
  nav search `min(560px, 65vw - 200px)`), so page content neither overlaps nor
  leaves a gap. The ≤1100 px overlay (420 px) and full-screen mobile width are
  unchanged, and the left-side layout is untouched.

### Done — ACP `session/resume` (2026-10-30)

**Shipped.** `DshAcpRuntime.resumeSession` + `AgentService` resume-on-miss +
yellow `agent.resume.failed` notice. Capability probe confirmed
`dsh@0.2.1-rc.3` advertises `sessionCapabilities.resume`. Live-verified across
API restart and idle dispose (memory survived; replay 2 turns; history 1 row)
and with a corrupt log (notice + normal answer). Tests: `@occ/agent` 17,
API 30, web 22. Design record below is kept for the next similar protocol
change.

**Why.** Replay restores the UI, not the model. Before this change, when
`AgentService.prompt` could not resolve a session it called
`runtime.createSession()` ([`apps/api/src/services/agent.ts`](apps/api/src/services/agent.ts))
and aliased the old UI id in memory. The new dsh session contained only
`SYSTEM_CONTEXT` + the current question; prior turns were absent. Verified
2026-10-30 (session `9ece6cfe…` → new `18bd84ff…`): asking the model to repeat
the previous question answered “不知道”; the new turn went to a separate log and
a separate history row. See §6 “Session memory”.

**Goal.** After API restart / idle dispose / process restart, reuse the **same
dsh session id and log** whenever a persisted log exists, so memory, replay and
the history menu stay on one continuous conversation.

**Official facts (checked 2026-10-30).**

- Upstream `@deepseek-ai/dsh-acp` supports `session/list` and `session/resume`.
  `session/resume` restores the persisted log but **does not replay updates** —
  exactly what we want (our replay stays independent).
- `session/load` (replay-on-load), delete, fork and transcript replay are
  **not supported upstream**. Do not switch to third-party plugins for this.
- Request shape: `{ sessionId, cwd, mcpServers, additionalDirectories? }`.
  The response contains `modes`/`configOptions` but **no `sessionId`**.
- `@agentclientprotocol/sdk@2.1.0` exposes the raw request as
  `connection.agent.request("session/resume", …)`; it has no public resume
  builder (see implementation note below).
- **Pinned dsh verified (2026-10-30).** `dsh@0.2.1-rc.3` returns
  `agentCapabilities.sessionCapabilities = { list: {}, resume: {}, close: {} }`.
  `DshAcpRuntime.start` now stores the `initialize` response and exposes
  `capabilities` / `supportsSessionResume` for diagnostics. If a future dsh
  drops `resume`, resume will fail into the yellow-notice fallback; re-probe
  before assuming npm docs match the pin.
- **SDK inference quirk.** `connection.agent.request(methods.agent.session.resume, params)`
  returns `unknown` when `params` is a widened variable (the typed overload's
  conditional mapped type only resolves with a contextual argument). Annotate
  the request as `ResumeSessionRequest` (or pass a literal) or the response
  loses its type.

**Implementation sketch.**

1. `DshAcpRuntime.resumeSession(sessionId, options?)` in
   [`packages/agent/src/runtime.ts`](packages/agent/src/runtime.ts):
   - Extract the `mcpServers` builder from `createSession` into a helper; reuse
     it so the resumed session gets the exact same `occ` MCP attachment.
   - `await this.start()` (spawns `dsh --profile acp` if the idle disposer
     killed it), then
     `connection.agent.request("session/resume", { sessionId, cwd, mcpServers })`.
   - Attach the resumed session to the SDK's update router, otherwise
     `prompt()`/`nextUpdate()` never receive `session/update`. The SDK's
     `ClientContext.attachSession(response)` is private but only needs
     `response.sessionId`; call it through one narrow cast and keep it in this
     single method:
     ```ts
     // `ActiveSession` is already imported in runtime.ts.
     const attach = (
       connection.agent as unknown as {
         attachSession(response: {
           sessionId: string;
           modes?: unknown;
           configOptions?: unknown;
         }): ActiveSession;
       }
     ).attachSession.bind(connection.agent);
     const active = attach({ ...response, sessionId });
     ```
     If a future SDK exposes a public resume builder, switch to it.
   - Store it: `this.sessions.set(sessionId, active)`; return
     `{ sessionId, acpSessionId: sessionId }`. If `hasSession(sessionId)` is
     already true, return it without resuming.
2. `AgentService.prompt` ([`apps/api/src/services/agent.ts`](apps/api/src/services/agent.ts)):
   - On `resolveSession` miss, call `findSessionLog(options.dshHome, sessionId)`
     (already exported from `@occ/agent`, read-only). If a log exists →
     `runtime.resumeSession(sessionId)`; otherwise → `runtime.createSession()`.
   - Keep the alias map for legacy ids; after a successful resume set
     `aliases.set(sessionId, sessionId)`.
   - If resume fails (corrupt/unsupported log, dsh error), fall back to
     `createSession()` **and emit a localized `notice`** (new code, e.g.
     `agent.resume.failed`) so the UI knows the context was reset. Do not fail
     the prompt and do not silently pretend memory survived.
3. `apps/web`: no protocol change needed — the stored id already points at the
   log. Optional polish: when `run.started.sessionId` differs from the stored
   id (fallback path), update `occ.agent.sessionId` and show the notice.

**Tests / acceptance.**

- Runtime unit test with a fake connection: `session/resume` is called with the
  same `cwd` + `mcpServers`; updates for that id route to the session; calling
  it twice does not resume twice.
- `AgentService` unit test: unknown id + existing log → resume; unknown id +
  no log → create; resume throws → create + notice.
- Live: one turn, restart the API, follow-up “请原样复述我上一条问题” must
  answer correctly; replay of the same id shows **2 turns**; history shows
  **1 row**. Repeat with `OCC_AGENT_IDLE_TIMEOUT_MS=1000` (idle dispose) and
  with a fresh browser holding the stored id.
- Keep the current live path green: same-process follow-ups must not call
  resume (session already attached).

**Pitfalls.**

- `attachSession` is private API; confined to `resumeSession()`, SDK pinned.
  Re-check on any `@agentclientprotocol/sdk` upgrade.
- The resume response has no `sessionId`: use the requested id.
- Never point `OCC_AGENT_DSH_HOME` at `phase0/.dsh-home` (plaintext vs zstd).
- A crashed turn leaves an open `turn/start`; dsh appends `interrupted`
  closers on resume. If resume still fails, use the notice + fresh-session
  fallback.
- The resumed session must receive the same `occ` MCP server spec; reuse the
  helper extracted from `createSession`.
- After resume, `hasSession(id)` must be true so later prompts don’t create
  yet another session.
- `findSessionLog` rejects unsafe ids; do not pass raw UI input into path
  joins.

### P3.4 UX v3 — done 2026-10-29

Shipped: **one** trajectory card at the top of the assistant bubble (above the
answer), live while researching and static in place once text streams; merged
group lines; expandable search/fetch rows (query, status, result count, top
domains, hit links in a new tab, duration, 已引用 badge); and a “计划与来源”
disclosure with the ledger. `AgentActivity.tsx` was removed — the card reuses
the same element for both states. Files:
`apps/web/src/components/AgentTrajectory.tsx`, `apps/web/src/lib/agent-trace.ts`,
`styles.css`, `i18n.tsx`, and the `packages/agent/src/runtime.ts` content
bridge. Verification: Playwright on the live sidebar + 17 web / 10 agent unit
tests.

### P3.4 remaining

- ~~First-class sub-agent card for `deep_research`/`get_run` with nested steps.~~
  **Deferred 2026-10-30 — not needed for this project.** `deep_research` stays
  a tool card; do not re-propose it as roadmap work.
- **Replay + resume done** (read dsh's log; ACP `session/resume` for memory).
  New turns stay on one continuous session/log; sessions split before
  2026-10-30 remain split (a persisted alias chain is optional cleanup). Child
  subagent sessions still do not replay.
- Consider “continue research” after a budget stop.

### P4 — A/HK coverage (revised scope)

**HSI status 2026-10-31**: `config/indices/hsi.yaml` has 85 constituents and
`scripts/backfill-hsi.sh` runs the batch (enqueue `--universe hsi --exclude
00700` → `work --queues research,ingest,review,f10 --drain` → `relations f10
--universe hsi`). A/HK research attaches F10 by default. After ingest, the
index page `/indices/HSI` reads the memberships with no API change. The
post-batch `relations f10` pass re-resolves cached shareholder pages against the
now-complete HSI universe (a 01038 shareholder of 00006 may not exist yet when
00006 ingests). The full batch for the remaining **81 companies** was enqueued
as run `a19a67ba-8739-4361-833b-6887395556ad` (excludes the 4 pilot names
`00700,00001,00006,01038`); `occ-backfill status` / `states` track it. STAR 50 /
ChiNext 50 snapshots remain to do.

- Index snapshots: **STAR 50 (000688, SSE)**, **ChiNext 50 (399673, SZSE)**,
  **HSI**; store `as_of`, weights and license. **Do not add S&P 500.** NDX is
  done (`config/indices/ndx.yaml`, 2026-10-28); HSI is done
  (`config/indices/hsi.yaml`, 2026-10-31).
- Backfill A/HK profiles: parallel pg-boss, F10 + official filings, per-company
  checkpoints. A-share path is already validated on 600519, HK on 00700.
- Entity resolution: LEI / CIK / USCC / ISIN / ticker+exchange / Wikidata QID /
  domain. Fill `sector` coverage for NDX while here.
- Adapters: SEC EDGAR, CNINFO, HKEXnews, HKEX DION, GLEIF, company IR, news.
- AI watchlist: confirm Zhipu `02513.HK` against HKEX; MiniMax listing status
  is still `verify`.
- Investment/equity relations (`invests_in`, `owns`, `parent_of`) need 13F/
  shareholder data; the UI currently has no such edges.

### P5 — Docker / Electron (deferred)

All Docker/Compose/multi-arch/GHCR and Electron work is deferred until a machine
with Docker is available. The current native setup is the supported dev path.
Cross-platform requirements do not change.

### P6 — Evaluation / quality

Golden set covers Chinese/English names, tickers, typos, pinyin initials and
natural language. Track MRR@10, nDCG@10, Recall@50, zero-result rate, p95.
Add agent eval (Google–Anthropic relations, M7 fact checks, citation precision)
and a UI smoke suite.

---

## 11. Handoff checklist

- [ ] HSI: `--universe hsi` resolves 85 HKEX targets; pilot research → ingest →
  reviewer completes; `/indices/HSI` lists members after ingest.
- [ ] Reviewer: `review.company` pass → `ready`; `revise` is capped at
  `OCC_REVIEW_MAX_CYCLES`; repeated failure ends in `needs_review`; `states`
  shows the last review result.
- [ ] NIM: worker research resolves `deepseek-ai/deepseek-v4.1-flash` through
  `127.0.0.1:4010`; Parallel tools are `mcp__psearch__web_search` /
  `mcp__psearch__web_fetch`; a 500/empty-content response is retried.
- [ ] F10 relations: A/HK/US ownership page JSON is cached under `.occ/f10/`;
  in-universe shareholders become `owns`/`invests_in` with evidence; refresh
  does not delete LLM or verified edges; `relations f10 --universe hsi`
  re-resolves cached pages after the batch.
- [ ] ACP sidebar unchanged: same model row, `reasoningEffort`, timeout,
  `deepseek-official` tools and `agent-trace.ts`.
- [ ] Repo is private; no key/token/cookie/`.env` tracked.
- [ ] Migration (dual-mode): provider `nvidia` is registered in the **headless**
      profile only; the headless `agent-default-model` points at
      `deepseek-ai/deepseek-v4.1-flash`; `NVIDIA_API_KEY.txt` is gitignored.
- [ ] Migration: **the ACP `acp` row, `reasoningEffort`, `OCC_AGENT_TURN_TIMEOUT_MS`
      and `agent-trace.ts` are unchanged**; the sidebar still uses
      `deepseek-flash` + `deepseek-official`.
- [ ] Migration: Parallel Search MCP mounted in the **headless profile only**
      (`streamable-http`, `https://search.parallel.ai/mcp`); headless
      prompt/skills/`validate.mjs`/URL extraction use
      `mcp__psearch__web_search` / `mcp__psearch__web_fetch`.
- [ ] Migration: `DEEPSEEK_API_KEY.txt` **stays** (sidebar + ingest/extraction
      + reviewer) and is still gitignored; per-job env whitelist keeps it out
      of the research child.
- [ ] Migration: step-level retry (3 attempts + backoff) on NIM 500 / empty
      `content`, plus `reasoning_content → content`; a single 500 never fails
      an 18-step company run.
- [ ] Migration: reviewer spawns a **DeepSeek** headless profile with reasoning
      on and a DeepSeek-only env; relation extraction is unchanged.
- [ ] Migration: no paid fallback for Parallel; one retry + plain-HTTP fetch
      fallback only; failure mode documented.
- [ ] Migration: global 36 RPM limiter across worker shards; a 10-minute
      sustained run leaves no dead jobs.
- [ ] Migration: the coding session still runs with the user's own key;
      nothing under `~/.claude*` or shell profiles changed.
- [ ] `scripts/dev-db.sh status` and `node apps/worker/dist/cli.js status` work.
- [ ] `corepack pnpm -r --workspace-concurrency=1 test` is green.
- [ ] `node scripts/e2e-search.mjs` passes against the live corpus.
- [ ] Default search shows only real profiles; `include_fixtures=true` exposes
      synthetic rows.
- [ ] Web: `corepack pnpm --filter @occ/web typecheck` + `build` pass.
- [ ] Agent: same-session follow-ups work; idle/restart behavior is understood;
      no limit notice on a normal research question.
- [ ] Replay: after one live turn, reload shows the same question/answer and
      trajectory; “新对话” clears `occ.agent.sessionId`; the clock menu lists
      persisted sessions and opens one.
- [ ] Resume: one live turn → restart the API (or wait out
      `OCC_AGENT_IDLE_TIMEOUT_MS`) → “请原样复述我上一条问题” answers correctly;
      replay of the same id shows 2 turns; history shows 1 row.
- [ ] Resume failure shows the yellow `agent.resume.failed` notice between the
      question and the answer, then answers normally (do not fail the prompt).
- [ ] News stage 1: “刷新新闻” updates the tab without a reload; unchanged run
      says “已是最新”; two clicks/tabs produce one job; no LLM tokens.
- [ ] News stage 2: entering a page after the TTL enqueues each stale company
      once; before the TTL it does nothing.
- [ ] A500 + SPX placeholders: constituent counts match minus existing
      companies; no documents/embeddings; default search excludes them; index
      pages and direct `/c/:ticker` show the 未收录 state.
- [ ] Placeholder page is **read-only**: no CTA, no `/research` endpoint, no
      route or UI action can enqueue research.
- [ ] Local capped research batch (operator CLI) runs through the worker pool on
      NIM/Parallel; reviewer pass flips the page to the full profile,
      `revise` is capped at 2 cycles.
- [ ] Shared task dock prototype approved (commit `dd465fc`); production dock
      wires **only** `news_refresh` — no `company_research` rows, no filter tabs.
- [ ] A/HK **bulk backfill** plan is STAR 50 + ChiNext 50 + HSI; **A500 and
      SPX stay placeholder-only** (filled by explicit, capped operator batches),
      never a full sweep.
- [ ] Do not write `deepseek-v4-pro` back into any config.
- [ ] Do not commit keys, tokens, cookies, or `.env`.

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
- [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md)
- [`docs/PRIOR_ART.md`](docs/PRIOR_ART.md)
- [`docs/NVIDIA_NIM_MIGRATION.md`](docs/NVIDIA_NIM_MIGRATION.md) — P0
  **headless-only** cutover: NIM inference + Parallel search/fetch for the
  worker pool, measured comparison, touchpoints, cost, rollback
- [`config/universe.yaml`](config/universe.yaml)
- [`config/indices/ndx.yaml`](config/indices/ndx.yaml)
- [`phase0/README.md`](phase0/README.md)

Historical archive: [`context_transfer_history.md`](context_transfer_history.md)

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

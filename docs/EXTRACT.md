# Company facts and relations

> Status: P3.2 · 2026-10-28
> Related: [Data layer & hybrid search](SEARCH.md) · [Search evaluation](EVAL.md) ·
> [Architecture](ARCHITECTURE.md)

The research profiles are prose plus Markdown tables. This layer turns them into
structured, cited rows in Postgres so agents can answer “what was revenue”, “who
supplies whom”, and “what happened recently” without re-reading the whole profile.

Two pipelines, deliberately separated:

| Stage | Method | Calls an LLM? | Output |
|---|---|---|---|
| Deterministic | Markdown tables, regex, alias matching | No | `financial_facts`, `facts` |
| Relations | `deepseek-flash` constrained to known companies | Yes, one call per company | `relations`, `relation_evidence`, `review_queue` |
| F10 relations | Structured F10 shareholder tables + universe matching | No | `relations` (`reported`), evidence, review queue |

## Commands

```bash
# Parse only; no DB writes, no LLM calls
node apps/cli/dist/occ.js extract --all --dry-run --json

# Deterministic only
node apps/cli/dist/occ.js extract --all --relations none

# Deterministic + LLM relations for the existing corpus
DEEPSEEK_API_KEY_FILE=DEEPSEEK_API_KEY.txt \
  node apps/cli/dist/occ.js extract --all --relations llm --concurrency 2

# One company, force a re-run
node apps/cli/dist/occ.js extract --tickers AAPL --relations none --force

# Review queue: list, then decide one or a filtered batch
node apps/cli/dist/occ.js review list --status pending --kind relation
node apps/cli/dist/occ.js review approve --ids rvw_...,rvw_... --reviewer bowen
node apps/cli/dist/occ.js review approve --kind relation --company AAPL --limit 20 --dry-run
node apps/cli/dist/occ.js review reject --all --yes --limit 50 --reviewer bowen
```

Batch decisions need a filter (`--ids`, `--kind`, `--company`, or
`--all --yes`), so an empty request can never approve the whole queue.
`--dry-run` prints the count without writing.

`--all` scans `phase0/out/sections/*.md` (the Phase 0 corpus). `--index ndx` uses
`config/indices/ndx.yaml` primary constituents; `--tickers` accepts `AAPL`,
`600519:A`, `00700:HK`.

## Deterministic extraction

- **Financials** (`### 5. 财务表现…`): recognizes the standard metric rows
  (`营收/营业总收入`, `毛利率`, `营业利润`, `净利润/归母净利润`, `EPS`,
  `经营现金流`, `Capex/资本开支`, `自由现金流`), units (`百万美元`, `十亿美元`,
  `亿美元`, `百万欧元`, `人民币亿元`), and periods (`FY2023`, `2023`, `2026Q2`,
  `Q3 FY2026`, `2026H1`, `TTM 2026/6`).
- **Snapshot** (`### 2. 公司快照`): `listing`, `headquarters`, `founded`,
  `fiscal_year_end`, `employees`, `market_cap`.
- **Segments** (`### 3. 业务与收入结构`): `revenue_segment` facts with segment,
  revenue, share, currency and period.
- **Timeline** (`### 10. 近 12 个月大事`): `timeline_event` facts (`{date,title,text}`)
  so the company card's `events` block has content before news ingestion exists.

Missing cells (`未验证`, `未获取`, `未单列`, `n/a`) are skipped, never stored as
zero. Values carry `source_refs` (the `[n]` markers) and a `source_id` pointing at
the cited URL, not just the research profile.

Confidence is explicit and deliberately conservative:

| Case | Confidence |
|---|---|
| Cell has its own `[n]` citation | 0.95 |
| Row/paragraph carries citations | 0.85 |
| Chapter carries citations | 0.80 |
| No citation | 0.70 (0.60 if the unit was inferred) |
| Period end derived from fiscal calendar | multiplied down to ~0.60–0.75 |

Periods store `period_kind` (`annual|quarter|half|ttm`) and the raw
`period_label`, because a single `period_end` date cannot express “FY2025” and
“Q3 FY2026” on its own. Derived dates are marked in `method`/`confidence` and in
the prompt-facing docs; they are not filing-grade.

## Relation extraction

The model receives only the `### 9. 关键关系` chapter, the citation map, and a
candidate list built by whole-name/alias matching over the visible universe. If
no known company is mentioned, no LLM call is made.

Types are grounded in Wikidata / schema.org (ownership, parent/subsidiary) and
common supply-chain company-KG practice (supplies, buys_from, competes_with,
partners_with, joint_venture_with, licenses_to/from, other). `src` is always the
profiled company, so direction is unambiguous. Incoming edges are labelled with
the inverse type at read time (`owned_by`, `subsidiary_of`, `buys_from`, …);
only one edge is stored.

Validation drops a relation unless:

1. the destination is in the candidate list and is not the source;
2. the type is in the allowed set;
3. the quote is a literal substring of the chapter (whitespace/`[n]` ignored);
4. at least one cited ref exists and belongs to the chapter's source list;
5. it is not a duplicate of an already accepted `(dst, type, quote)`.

Accepted edges are written as `relations.status='inferred'`, get one
`relation_evidence` row per accepted relation, and are also inserted into
`review_queue` (`kind='relation'`, deduped by `relation:<id>`). `inferred` means
“machine-extracted, not reviewed”; agents must expose the status and cite the
evidence quote/URL. Only a human can move an edge to `verified`.

LLM failures never fail ingest: deterministic data is kept, the error is
recorded in `extraction_cache` (`stage='relations'`, `status='partial'`), and the
batch reports it per company.

## Structured F10 shareholder relations (2026-10-31)

The profile's `关键关系` chapter is not the only source of ownership edges. After
ingest, the worker also reads the company's structured F10 ownership page:

| Market | Page | Table |
|---|---|---|
| A | `gdyj` | 十大股东 / 十大流通股东 |
| HK | `MajorShareholder` | 直接/间接持股方 |
| US | `gbgd` | 最新持股 / 董事及股东权益 |

The page JSON is saved under `.occ/f10/<market>/<code>/<page>.json`; extraction
(`packages/extract/src/relations/f10.ts`) turns each row into a candidate edge
**only when the shareholder already exists in our company universe**. Out-of-
universe shareholders are counted and logged, never invented as companies.

- Direction is always shareholder → profiled company.
- `owns` when the stake is ≥ 50%, otherwise `invests_in`.
- Rows are written as `relations.status='reported'` with an evidence quote and
  the F10 URL, plus a `review_queue` item. The UI labels them 媒体报道; only a
  human decision moves them to `verified`.
- Extraction is **additive**: refreshing a page never deletes LLM-inferred or
  human-reviewed edges. Unreviewed F10 edges into the same company are replaced
  when the page changes, so stale percentages do not accumulate.
  `OCC_F10_RELATIONS=none` disables the pass.
- After a batch, re-run against cached pages so a shareholder that was not yet
  ingested at first pass becomes an edge:
  `node apps/worker/dist/cli.js relations f10 --universe hsi`.

HK HSI holdings are a useful example: Power Assets (00006) reports 长江基建
(01038) and 长江和记 (00001) as shareholders, so the graph gets real investment
edges once those companies are ingested.

## Structured financial statements (2026-11-01)

The `financials.company` queue adds filing-grade statements on top of the
profile extraction. One row per `(company, statement, item, period_end,
period_kind)` wins by source precedence:

| Priority | Source | Markets | `method` / `sources.trust_tier` |
|---|---|---|---|
| 1 | SEC EDGAR XBRL `companyfacts` + 10-K/10-Q filing URL | US | `xbrl` / `filing` |
| 2 | Eastmoney F10 `cwfx` (HK: `NewFinancialAnalysis`) | **A / HK only** (US removed 2026-11-01) | `f10` / `secondary` |
| 3 | Research-profile Markdown tables | all | `deterministic_table_v1` |

> **US is EDGAR-only (done 2026-11-01).** The US pipeline no longer fetches or
> writes F10; the existing US `f10` rows were deleted (2,053 rows). EDGAR
> parses both `us-gaap` and `ifrs-full`, so 20-F/40-F issuers (CCEP, Ferrovial,
> Thomson Reuters) are covered. F10 remains the A/HK structured layer and the
> generic parser/tests stay. After the cleanup NDX is **100/100 on `xbrl`**.

- Pure parsers live in `packages/extract/src/financials/f10-cwfx.ts`,
  `edgar-xbrl.ts` and `canonical.ts`; fixture tests never call the network.
- The worker stage (`apps/worker/src/financials/run.ts`) caches the raw pages
  under `.occ/f10/<market>/<code>/<page>.json` (A/HK only) and
  `.occ/edgar/<cik>/companyfacts.json` + `submissions.json`; the ticker → CIK
  map is `.occ/edgar/company_tickers.json`.
- EDGAR merges the `us-gaap` and `ifrs-full` taxonomies (us-gaap wins a
  concept-name collision) and picks one reporting currency per company, taken
  from `Assets`, so a dual-tagged concept (EUR + USD) cannot mix currencies.
- Values are stored in native units (`unit='currency'` + `currency`,
  `unit='percent'`, `unit='currency_per_share'`), never millions. `period_label`
  keeps `FY2025` / `2026Q3` / `2026H1` and `period_start` records the window.
- EDGAR prefers a true 90-day quarter when a filing reports both the quarter and
  its YTD total. F10 keeps the source's cumulative 一季报/中报/三季报 columns;
  `period_start` (e.g. Jan 1) tells consumers it is cumulative.
- **Derived cells are marked, not reported**: when the taxonomy omits a
  subtotal, `computeDerivedFacts` calculates `gross_profit = revenue -
  cost_of_revenue`, `total_liabilities = total_assets - total_equity`,
  `gross_margin = gross_profit / revenue` and `free_cash_flow = operating cash
  flow - |capex|`. Their quote always starts with `计算：` and confidence is
  below 1; the web UI shows a `推导` badge. Nothing is derived unless both
  inputs exist for the same period.
- Upserts only overwrite an equal/lower-ranked method (`xbrl` 30, `f10` 20,
  profile 10), so re-running profile extraction never clobbers filing data. The
  structured run passes the incoming method's own rank, so an A/HK F10 pass
  cannot overwrite EDGAR rows for a dual-listed company. Profile rows within
  ±7 days of a structured period are removed, preventing duplicate columns for
  52/53-week fiscal calendars.
- The EDGAR-vs-F10 comparison (`extraction_cache.stats.comparison`) is retired
  with the US F10 leg; it now always records zeros. Do not add a source
  discriminator or a conflict view until it is actually scheduled.
- CIK resolution uses `company_tickers.json`. SEC requires a declared
  `OCC_EDGAR_USER_AGENT` with contact info and ≤10 requests/second (a global
  110 ms limiter); responses are cached for 24 h.
- `OCC_FINANCIALS=none` stops ingest from enqueuing the stage; the explicit
  command still works and `--force` refreshes both source caches.

```bash
# Pilot / explicit batch (never a full-universe sweep by default)
node apps/worker/dist/cli.js enqueue financials --tickers AAPL:US,600519:A,00700:HK --force
node apps/worker/dist/cli.js enqueue financials --universe ndx
OCC_FINANCIALS_CONCURRENCY=2 \
  node apps/worker/dist/cli.js work --queues financials --drain
```

## Reviewer (hidden quality gate)

Research + ingest can enqueue `review.company`. The reviewer is a second
headless dsh run on the **official DeepSeek API with reasoning on** (not NIM),
with a checklist prompt and only web search/fetch tools. It returns:

```json
{"verdict":"pass|revise","issues":[{"field":"5. 财务表现","reason":"...","evidence":"..."}],"fix_instructions":"..."}
```

`pass` → `ready`. `revise` → the first `review.company` job that pass is not met
re-enqueues research with the feedback, capped at `OCC_REVIEW_MAX_CYCLES`
(default 2), then `needs_review`. The reviewer is not exposed in the public UI;
`occ-backfill states` shows operator status and the last review result.

The 2026-10-31 `HK:00700` pilot is the reference: research 289 s, ingest 27 s,
three reviewer turns (~73 s each), final verdict `revise` → `needs_review`
after the cap. The issues were real (OCF/FCF reconciliation, a mismatched
citation, source-count mismatch, wrong interest-coverage definition, mixed
single-quarter/cumulative columns), so the profile stayed ingested but was not
marked ready. That is the intended behaviour: never fake a pass.



## Reviewing the queue

A decision is the only path from `inferred` to `verified`. Only `pending` items
transition, so replays are idempotent (`updated` vs `skipped`).

| Item | Accepted | Rejected |
|---|---|---|
| Extracted relation (`relations.review_id = item.id`) | edge → `verified` | edge → `rejected` |
| Agent relation proposal (no row yet) | creates the edge (`verified`) + evidence | nothing written |
| Agent fact proposal | inserts a `facts` row with an `agent_proposal` source | nothing written |

The evidence URL is upserted as a `sources` row (`trust_tier='proposal'`), and
the quote is stored on the fact/evidence row. Batch filters are `ids`, `kind`,
and `company` (ticker/slug/ULID), capped at 500. The local API also serves a
plain HTML console at `GET /v1/review/ui` (no build step, no external assets);
it lists pending items and calls the same batch endpoint.

## Caching and idempotency

- `extraction_cache(company_id, stage)` stores `input_sha256`, `prompt_hash`,
  model, status, stats and token usage.
- Deterministic output is deleted by `extractor_version` and re-inserted inside
  the per-company advisory lock, so changed tables do not leave stale rows.
- Relations for a company are replaced wholesale on every successful LLM run;
  human-reviewed rows (`verified`/`rejected`) and non-inferred rows are never
  deleted.
- Review-queue upserts refresh payload/evidence but never reset `status` or
  `reviewer`.
- Rerunning without `--force` and with an unchanged section/prompt is a cache
  hit and costs no tokens.

## Reading it

```bash
node apps/cli/dist/occ.js company AAPL --include financials,relations,events
node apps/cli/dist/occ.js review list --status pending
```

```
GET /v1/companies/AAPL?include=financials,facts,relations,events
POST /v1/review/proposals        # agent proposals only; never writes facts directly
GET  /v1/review/queue?status=pending
POST /v1/review/items/{id}/decision   # {decision: accepted|rejected, reviewer?}
POST /v1/review/batch                 # {decision, ids|kind|company|all, limit, reviewer?}
GET  /v1/review/ui                    # local HTML console
```

MCP exposes the same surface as `search_companies`, `get_company`,
`search_documents`, `propose_fact`, `propose_relation` (plus the two F10 tools).

## Acceptance (2026-10-28, live corpus)

Command: `occ extract --all --relations llm --concurrency 2 --force`.

| Metric | Result |
|---|---:|
| Companies processed | 102 |
| Deterministic errors / missing companies | 0 / 0 |
| `financial_facts` | 2,834 |
| `facts` | 1,200 |
| `relations` (`status='inferred'`) | 64 |
| Relations lacking evidence / review item | 0 / 0 |
| Self-relations | 0 |
| Relations by company | 35 companies have ≥1 (ARM: 8) |

Spot checks:

- AAPL FY2025 revenue `416,161,000,000 USD` (period end 2025-09-27).
- 600519 2025 revenue `172,100,000,000 CNY` (period end 2025-12-31).
- Tencent 2025 revenue `751,800,000,000 CNY`.
- AAPL → GOOGL `buys_from`: “Google/Alphabet：既是 Siri 的模型供应商，
  也是默认搜索位付费方”, with a source URL and a pending review item.

Rerunning without `--force` reports `relationsSkipped: true` for unchanged
sections and makes no LLM call.

## Known limits

- Fiscal-quarter ends for 52/53-week and non-calendar filers are derived, not
  exact; confidence and `period_label` make the uncertainty visible.
- A fiscal-year end can also be a Q4 end (`FY2026` and `Q4 FY2026` both ending
  2026-07-31). The natural key includes `period_kind`, so both rows coexist. Do
  not “fix” this by dropping one of them.
- Only companies already in the database can be relation destinations. Mentions
  of out-of-universe counterparties are ignored rather than invented.
- Segment tables are extracted when they follow the standard three-column shape;
  free-form prose segments are not parsed.
- News documents (`doc_type='news'`) come from Google News RSS (link-only); the
  company card's `events` merges them with profile timeline events. See
  [NEWS.md](NEWS.md).
- The LLM can still pick the wrong relation type. That is why nothing is
  `verified` without review.

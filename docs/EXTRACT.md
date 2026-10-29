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
- News documents (`doc_type='news'`) are not ingested yet; `events` currently
  comes from the profile timeline.
- The LLM can still pick the wrong relation type. That is why nothing is
  `verified` without review.

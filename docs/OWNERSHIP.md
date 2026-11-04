# Ownership graph (P1.3) — US 13F + HKEX DION

> Status: implemented 2026-11-02 · Related: [DATA_SOURCES](DATA_SOURCES.md),
> [ENTITY](ENTITY.md), [ROADMAP](ROADMAP.md)

## 1. Goal

The investment graph no longer stops at the F10 top-10 table. Two public,
deterministic sources add ownership depth:

- **US SEC Form 13F-HR** holdings → `invests_in` edges from institutional
  filers to their US-listed holdings.
- **HKEX Disclosure of Interests (DION)** substantial-shareholder notices →
  `invests_in` edges from the disclosed holder to the listed HK company.

Both adapters only connect companies that already exist in `companies`
(researched profiles or A500/SPX stubs). A counterparty outside the universe is
counted and reported, never created. The pipeline is deterministic and uses
**0 LLM tokens**.

## 2. US Form 13F

### 2.1 Source and cache

The SEC publishes one ZIP per filing window at
<https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets>. The
current files use a filing-date-range name (`01jun2026-31aug2026_form13f.zip`);
older quarters use `2023q4_form13f.zip`. The adapter fetches the index page,
picks the latest window, and caches it at:

```text
<OCC_EDGAR_DIR>/13f/<dataset>/dataset.zip   # raw ZIP, gitignored
<OCC_EDGAR_DIR>/13f/<dataset>/meta.json     # url, SHA-256, bytes, downloadedAt
```

`--refresh` re-downloads; otherwise a cached ZIP with the recorded byte size is
reused. Raw files are never committed. The ZIP is read by a dependency-free
streaming reader (`src/zip.ts`): only the central directory is loaded, and
`INFOTABLE.tsv` (≈400 MB uncompressed) is streamed through `inflateRaw`.

### 2.2 Parsing and matching

- **Filings**: only `SUBMISSIONTYPE='13F-HR'` is used. `13F-HR/A` amendments
  and `13F-NT` notices are counted and skipped (an amendment is not merged in
  this first cut).
- **Filer**: match `SUBMISSION.CIK` exactly against `company_ids.cik`. If the
  CIK is absent, an exact normalized `COVERPAGE.FILINGMANAGER_NAME` is allowed;
  ambiguity is reported. Filers are never created.
- **Issuer**: match `INFOTABLE.CUSIP` exactly against `company_ids.cusip`.
  CUSIPs come from the SPY holdings workbook (`Identifier` column) through
  `occ indices sync`; they are not derived from tickers or ISINs. When a CUSIP
  is absent (NDX-only names, corporate-action CUSIP changes, ADRs), an exact
  normalized `NAMEOFISSUER` match is the documented fallback; it is reported
  separately. This is how HK/A companies with US ADRs (JD, Baidu, Trip.com,
  Ping An, …) are connected to their 13F holders.
- **Rows**: options (`PUTCALL` non-empty) and non-share rows (`SSHPRNAMTTYPE
  != 'SH'`) are skipped. Self-holdings are skipped.
- **Period**: a later `PERIODOFREPORT` replaces the previous one for the same
  `(holder, issuer)`; multiple share classes in the same period are summed.
- **Value**: the SEC reports dollars for filings on/after 2023-01-03 and
  thousands before that. Each filing is evaluated by its filing date; the quote
  says “reported in thousands” when the old unit applies.

### 2.3 Edge shape

- type `invests_in` (13F is an institutional position, not control).
- `status='reported'`, `confidence=0.9`.
- `extractorVersion='sec-13f-v1'`.
- `amount` = reported market value in USD; `currency='USD'`.
- `evidence.quote` carries period, issuer/CUSIP, shares, value and accession.
- `relations.metadata` carries `source, period, filingDate, accession, shares,
  valueUsd, cusip, issuerName, managerName, holderCik, holderMatchedBy
  (cik|name), issuerMatchedBy (cusip|name), valueUnit`.
- Source URL: the SEC filing index
  `https://www.sec.gov/Archives/edgar/data/<cik>/<accession-no-dashes>/`.

Dedupe is `(holder, issuer, type)`: a new quarter updates the same edge and
adds a new evidence row; reruns insert no duplicate edges.

## 3. HKEX DION

### 3.1 Browser sidecar

The public DI site is behind a JavaScript bot-defense layer; a plain HTTP POST
returns “temporarily unavailable”. The Python sidecar therefore uses the same
Playwright Chromium as the F10 adapter:

- `POST /v1/dion/notices` `{ code, days, max_pages }`
- `occ-f10 dion 02318 --days 365 --max-pages 10`

The scraper follows the site's normal form flow (search page → set date range →
submit → “List of notices filed by substantial shareholders”), paginates with
`pg=N`, and paces requests at **1 request/second**. Every notice keeps its
detail link (`NSForm2.aspx?fn=…`). No bulk redistribution.

### 3.2 Interpretation

- Only the **long-position** line is used. A cell like
  `6.37(L)\n3.36(S)\n2.82(P)` yields 6.37% and the `(L)` holdings; a short-only
  notice is ignored.
- Holder matching is exact normalized name against company display/legal names,
  English/company profile names, and brand/legal aliases. **Pinyin and ticker
  aliases are excluded** — `sndl` for 深南电路 must not match SNDL Inc.
- The issuer is the searched HK company; the holder must already exist in
  `companies`. Individuals, funds and parent groups outside the universe are
  counted and listed, never created.
- The latest notice per `(holder, issuer)` becomes the edge; the event date is
  `validFrom`/`publishedAt`. A percentage is never used to infer control:
  `invests_in` is used for every DION edge (`owns` would require an explicit
  control statement).
- Metadata: `source, serial, eventDate, percent, shares, holdingsRaw,
  reasonCode, reason, code, issuerName`.
- `extractorVersion='hkex-dion-v1'`.

## 4. Data model

Migration `0010_relation_metadata.sql` adds:

- `relations.metadata jsonb NOT NULL DEFAULT '{}'` — source-specific
  provenance; `amount`/`currency` stay for the primary monetary value.
- `relations_extractor_idx`.
- `ownership_sync_runs` — one row per applied run (`market`, `dataset`,
  `ran_at`, `stats jsonb`) so `occ ownership coverage` can report matched vs
  out-of-universe counts without re-downloading the 13F data set or re-scraping
  DION.

Every new edge gets:

1. a `relations` row (`status='reported'`);
2. a `relation_evidence` row (URL + quote + `publishedAt`);
3. a `sources` row (`trust_tier='official'`, `robotsOk=true`);
4. a pending `review_queue` item (`origin: sec-13f|hkex-dion`, dedupe key
   `relation:<id>`).

A human decision is the only route to `verified`. The writer never deletes F10,
GLEIF or human-reviewed edges; a same-pair edge owned by another extractor is
counted as a duplicate and left untouched.

## 5. Commands

```bash
# dry run (default): plan edges and print matched/out-of-universe counts
node apps/cli/dist/occ.js ownership sync --market US
node apps/cli/dist/occ.js ownership sync --market HK --days 365

# write edges + evidence + review items
node apps/cli/dist/occ.js ownership sync --market all --apply

# options
#   --limit N       US: max 13F-HR filings; HK: max companies
#   --days N        HK DION lookback (default 365)
#   --max-pages N   HK DION pages per company (default 10)
#   --dataset NAME  pin a 13F window, e.g. 01jun2026-31aug2026
#   --refresh       re-download the 13F data set
#   --json          machine-readable report

node apps/cli/dist/occ.js ownership coverage [--json]
```

The DION path requires the sidecar:

```bash
cd services/finance-analyst && uv run occ-f10 serve --port 8090
```

Env:

| Env | Default |
|---|---|
| `OCC_EDGAR_DIR` | `.occ/edgar` (13F cache lives under `13f/`) |
| `OCC_EDGAR_USER_AGENT` | `OpenCorpCheck/0.1 (Bowen Xu; xubowenhaoren@gmail.com)` — must contain a contact |
| `OCC_FINANCE_ANALYST_URL` | `http://127.0.0.1:8090` |
| `OCC_DION_TIMEOUT_MS` | `60000` |
| `OCC_DION_SETTLE_MS` | `1500` |
| `OCC_DION_MAX_PAGES` | `10` |
| `OCC_DION_RATE_PER_SEC` | `1.0` |

## 6. UI labels

The relation status `reported` now renders as **已报告** globally. The pill on a
reported edge shows its source instead:

| `extractorVersion` | Chinese | English |
|---|---|---|
| `sec-13f-v1` | 13F 持仓 | 13F holding |
| `hkex-dion-v1` | HKEX 权益披露 | HKEX DI notice |
| `gleif-lei-v1` | GLEIF 母公司 | GLEIF parent |
| `f10-table-v1` | F10 股东 | F10 shareholder |

`RelationView` exposes `extractorVersion` and `metadata`; the graph inspector
and relation list show the source after the status. Relations are sorted by
confidence and then `amount`, so the largest 13F holdings appear first. In the
graph itself, 13F/DION are low-emphasis dotted edges without arrowheads; when
more than 12 institutional holders exist the default view shows the 10 largest
by `amount` (DION falls back to `metadata.percent`) plus an「其他机构 +N」
cluster.「显示全部」expands; the full list and API are unchanged. See
[UI.md](UI.md) §7.4.1.

## 7. Results (2026-11-02)

US (dataset `01jun2026-31aug2026`, period 2026-06-30):

- 9,501 `13F-HR` filings (399 `13F-HR/A` + 1,946 `13F-NT` skipped);
- 63 filer companies matched (59 by CIK, 4 by exact name: HSBC, AIA,
  NetEase); **38 filers have at least one in-universe holding and produce
  edges**;
- 529 issuer companies matched (78 by exact name); 9,767 out-of-universe
  CUSIPs counted; 8,807 distinct unmatched filers reported;
- 4,826 options and 2,495 non-share rows skipped; 130 self-holdings skipped;
- **13,009 edges**, 13,009 evidence rows, 13,009 pending review items, 38
  source rows. Sample: Berkshire Hathaway → AAPL ($65B), BlackRock → NVDA
  ($388.6B).
- Visibility split: **2,585 edges target 115 researched issuers** (NDX + US
  listings of HSI/CYB50 companies) and are visible on company/graph pages
  today; 10,424 edges target 414 SPX stubs, whose placeholder pages have no
  tabs until an operator researches them. Holders: 31 stubs / 7 researched.
- Top holders: BlackRock 514 edges ($5.43T), State Street 507 ($3.00T),
  JPMorgan 514 ($1.20T), Morgan Stanley 514 ($1.16T), Invesco 514 ($1.09T).
  This is the expected shape of a corpus built from index companies, not asset
  managers.
- CUSIP coverage: **500/515 non-fixture US companies (503 ids)**. The 15 gaps
  are NDX-only names not in the current SPY snapshot (e.g. ALNY) and are
  covered by the exact-name fallback where the 13F issuer name matches.
- `occ ownership coverage` (2026-11-02): US 13F edges 13,009 · 38 holders ·
  529 issuers · 13,009 pending reviews · latest 2026-06-30; last run
  `01jun2026-31aug2026` prints **63 filers matched / 8,807 out-of-universe**
  and **529 issuers matched / 9,767 out-of-universe CUSIPs**.

HK DION (full run 2026-11-02, 85 researched HK companies, 365-day window,
max 10 pages):

- **4,520 notices** returned, all with a long position; **100 planned edges /
  90 written / 10 cross-source duplicates** (the pair already had a 13F edge);
  14 holder companies matched (13 with a written DION edge), 45 issuers,
  209 out-of-universe holder names, 0 ambiguous, 0 failures; latest notice
  2026-10-30 (latest written edge 2026-10-28).
- Write: +90 relations, +90 evidence rows, +90 pending reviews, +90 source
  rows.
- Samples: Las Vegas Sands → 金沙中国 **75.56%**, COSCO Shipping → 东方海外
  **71.07%**, 华润置地 → 华润万象生活 **70.12%**, JD → 京东健康 **67.38%**,
  Alibaba → 阿里健康 **63.50%**, 中国平安 → 招商银行 **21.04%**, JPMorgan →
  美的集团 **14.56%**, BlackRock → 新奥能源 **9.85%**.
- `occ ownership coverage`: HK DION edges 90 · 13 holders · 45 issuers · 90
  pending reviews · latest 2026-10-28; last run reports 209 out-of-universe
  holder names.

## 8. Known limits

- **13F filer coverage is low by design.** The corpus is index companies, not
  asset managers; most filers (8,807 distinct) are outside the universe. The
  acceptance metric is the coverage report, not an edge-count target.
- **Amendments are not merged** (`13F-HR/A` skipped). A restatement is not
  applied until a later initial filing.
- **Options and debt rows are skipped**; 13F `PRN` rows are not ownership.
- **CUSIP fallback**: some issuers have a different CUSIP in the 13F data set
  than the SPY snapshot (corporate actions, non-SPX listings, ADRs). Exact
  normalized issuer names fill the gap and are tagged `issuerMatchedBy='name'`.
  Variant names (`ALIBABA GROUP HLDG LTD` vs `Alibaba Group Holding Limited`)
  do **not** match; they stay out-of-universe. The deterministic fix is to add
  their CUSIP, not to add abbreviation/fuzzy rules.
- **DION thresholds**: a notice only appears at 5% (or a crossing), so smaller
  stakes are invisible. Short-only notices are ignored; group/parent names
  outside the universe are counted, never merged into the listed subsidiary.
- **No control inference**: 13F and DION edges are `invests_in`; `owns` from
  these sources would need an explicit control statement.
- **Cross-source overlaps**: 10 DION edges matched an existing 13F edge
  (same holder/issuer/type) and were counted as duplicates. The existing edge
  is left untouched, so the DION percentage is not merged into it. This is
  expected for HK ADRs (e.g. Alibaba, JD) that also appear in 13F; a future
  pass can attach DION evidence to the existing relation.
- **F10 `owns` vs DION `invests_in`**: four ≥50% pairs (华润置地→华润万象生活,
  JD→京东健康, Alibaba→阿里健康, JD→京东物流) have both an F10 `owns` edge and
  a DION `invests_in` edge. They are different source claims and different
  types, so both are kept; the graph shows the control edge and the percentage
  edge. No cross-source merge is attempted.
- **Stub visibility**: most 13F edges target SPX stubs. The edge is stored and
  the issuer's researched neighbours show it, but a stub page intentionally has
  no tabs/graph until an operator researches it. Do not un-stub a company just
  to show ownership.
- **Review queue volume**: 13F creates one pending item per edge. This is
  intentional provenance, not a backlog to bulk-approve blindly.

## 9. Tests

- `packages/sources/ownership/tests`: matching (article/legal suffix,
  ambiguity), 13F parsing/aggregation/options/latest period, data-set discovery,
  DION long-position parsing/latest notice/self-skip.
- `services/finance-analyst/tests/test_dion.py`: DION row parser and helpers.
- Run: `corepack pnpm --filter @occ/sources-ownership test` and
  `cd services/finance-analyst && uv run pytest tests/test_dion.py`.

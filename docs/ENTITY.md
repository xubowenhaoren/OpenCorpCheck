# Entity resolution and sector classification (P1.2)

> Status: implemented 2026-11-01 · Related: [DATA_SOURCES](DATA_SOURCES.md),
> [ARCHITECTURE](ARCHITECTURE.md) §5.2, [CONTEXT_TRANSFER](../CONTEXT_TRANSFER.md) §10

## 1. Goal

Make the company header, the search sector filter and ownership matching
trustworthy for the **236 researched companies**. A500/SPX placeholders
(`coverage_tier='stub'`) intentionally stay sector-null and identifier-light;
filling 862 stubs is not part of P1.2.

## 2. Sector taxonomy

One coarse, GICS-style 11-sector spine (`SECTOR_TAXONOMY_VERSION =
"gics-like-11@1"`), in Chinese because the corpus and UI labels are Chinese:

```
信息技术 · 通信服务 · 可选消费 · 必需消费 · 医疗保健
金融 · 工业 · 能源 · 原材料 · 公用事业 · 房地产
```

`companies.sector` stores one of those values. The vendor's granular label is
kept in `companies.profile.industry` (and `industryCsrc` for A-shares), and
`sectorSource` records the deterministic rule, source label, market, URL and
timestamp. No sector is guessed: an unmapped label leaves `sector` null and is
listed in the coverage report.

### Deterministic precedence

| Market | Primary | Fallback |
|---|---|---|
| A | Eastmoney F10 `所属东财行业` first level (`gsgk`) | legacy thematic label only |
| HK | Eastmoney F10 `所属行业` (`CompanyProfile`) | legacy thematic label only |
| US | Eastmoney F10 `所属行业` (`gsgk`) | SEC EDGAR SIC code + description |

The mapping tables live in
[`packages/sources/entity/src/sectors.ts`](../packages/sources/entity/src/sectors.ts).
Unknown vendor labels fall through a keyword rule and then to `null`; nothing is
invented. The old free-form seed labels (`白酒`, `大模型`, …) are normalized only
when no vendor profile exists.

Fixtures (hidden from search) also get their legacy thematic labels mapped to the
canonical set. They can be A500/SPX index members, and the index-page sector
filter is built from membership rows; without this step `AI 芯片`, `半导体代工`
etc. leaked into the filter. This does not create profiles, fetch sources or
fill stubs.

## 3. Identifiers

`company_ids` is the entity spine. P1.2 adds/refreshes:

| `id_type` | Source | Notes |
|---|---|---|
| `ticker` | securities | canonical `AAPL` / `00700.HK` / `600519.SH` |
| `cik` | SEC EDGAR ticker map / submissions | US only |
| `domain` | F10 `公司网址`, EDGAR submissions | normalized bare domain |
| `isin` | F10 profile (A-share pages usually omit it) | validated 12-char ISIN |
| `uscc` | F10 A-share `工商登记` | validated GB 32100 checksum |
| `ein` | SEC submissions | US only |
| `lei` | EDGAR `lei` or GLEIF exact-name lookup | 20-char LEI |
| `wikidata` | Wikidata exact-label lookup | `Q<id>` |

The global unique key `(id_type, id_value)` is the deterministic entity key. An
identifier that already belongs to another company is **reported as a conflict
and skipped**, never stolen. `entity_merge_log` records every explicit merge.

## 4. GLEIF parent edges

`occ entities gleif --apply` resolves an LEI for each researched company (using
an existing identifier, EDGAR's LEI field, or a GLEIF name search), then follows
`/direct-parent` and falls back to `/ultimate-parent`. When the parent LEI
belongs to another company in the corpus, a `parent_of` relation is written
with:

- `status='reported'`
- `extractorVersion='gleif-lei-v1'`
- GLEIF API source URL + quote
- a pending review-queue item (`origin: gleif`)

Only exact normalized legal names (or registered other names) are accepted;
inactive, branch and ambiguous records are rejected. Human review remains the
only route to `verified`. Parents outside the corpus are counted, never
fabricated as companies.

If a reported parent is not a researched company but already exists as an
A500/SPX **stub** with an exact normalized name match, the stub receives that
LEI and the edge is written (the stub is still a universe row; no new company
is created). A non-unique stub name is skipped.

Current result (2026-11-01): 182/236 researched LEIs resolved. One real edge
was written: **Las Vegas Sands (SPX stub) → 金沙中国** (`direct-parent`), with
the GLEIF API URL, evidence quote and a pending review item. Four other issuers
report parents outside the corpus (SoftBank, Deutsche Telekom,
中国人寿保险（集团）, 联想控股), so they are reported rather than attached.

## 5. Cross-listing resolution

A-share stubs can duplicate a researched HK company (e.g. 601318 中国平安 vs
02318.HK). `occ entities resolve` uses a safe chain:

1. Candidate detection only (normalized name containment between an A-share stub
   and a researched HK company).
2. Fetch the stub's A-share `gsgk` page and read the structured `H股代码`.
3. Confirm the H-share ticker belongs to a researched HK company.
4. Merge only with `--apply`: move securities, aliases, identifiers and index
   memberships to the survivor, delete the stub and write `entity_merge_log`
   with the URL, field and value.

The stub must have no documents, chunks, facts, financials, relations, review
items or news cursor; otherwise the merge is blocked. Nothing is merged on fuzzy
name similarity alone.

## 6. Commands

```bash
# sector + domain/ISIN/USCC/CIK/EIN/ticker identifiers; reindexes changed companies
node apps/cli/dist/occ.js entities enrich [--dry-run] [--force] [--skip-index]
                                         [--markets A,HK,US] [--limit N] [--json]

# coverage report (236 researched; stubs excluded)
node apps/cli/dist/occ.js entities coverage [--json]

# cross-listing stub merges (dry-run by default; add --apply)
node apps/cli/dist/occ.js entities resolve [--apply] [--limit N] [--json]

# LEI + GLEIF parent edges (dry-run by default; add --apply)
node apps/cli/dist/occ.js entities gleif [--apply] [--limit N] [--json]

# Wikidata QID (dry-run by default; add --apply)
node apps/cli/dist/occ.js entities wikidata [--apply] [--limit N] [--json]
```

`enrich` is offline when the F10/EDGAR caches already exist. Pulling a missing
profile uses the F10 sidecar (`OCC_FINANCE_ANALYST_URL`, default
`:8090`). GLEIF and Wikidata are the only public-network steps and are separate
commands so the daily path stays deterministic and cheap.

Env:

| Env | Default |
|---|---|
| `OCC_F10_DIR` | `.occ/f10` |
| `OCC_EDGAR_DIR` | `.occ/edgar` |
| `OCC_FINANCE_ANALYST_URL` | `http://127.0.0.1:8090` |
| `OCC_GLEIF_BASE_URL` | `https://api.gleif.org/api/v1` |
| `OCC_WIKIDATA_API_URL` | `https://www.wikidata.org/w/api.php` |

## 7. Result (2026-11-01)

- Sector: **235/236** researched companies covered (99.6%). The only gap is
  `HK:00823` 领展房地产投资信托基金, whose F10 page returns `EmptyRender`
  (the same documented F10 gap as its financials). Vendor labels and sources are
  recorded in `companies.profile`.
- Identifier coverage is reported by `occ entities coverage`; the report lists
  every missing company per type rather than a percentage alone. Current
  coverage: ticker 236/236, CIK 100 (US), domain 229, ISIN 184, USCC 64
  (A-share; two red-chip A listings have no USCC by source), EIN 91, LEI 182
  researched (+1 SPX stub used as a parent), Wikidata QID 98 (strict
  exact-label matching; the rest are unmatched, not guessed).
- 12 dual-listed A/HK stubs merged into their researched HK company; 850 stubs
  remain. `entity_merge_log` has one row per merge.
- Stubs remain sector-null by design; `occ entities coverage` prints them as
  excluded.
- No migration for sectors/identifiers; migration
  `0009_entity_merge_log.sql` adds the merge audit table.

## 8. Known limits

- F10 is a proprietary Eastmoney surface: internal demo/research with
  attribution, no bulk redistribution. GLEIF and Wikidata are CC0.
- GLEIF coverage is partial for Cayman/BVI-listed HK companies and for most
  A-share issuers; unmatched names are reported, not guessed.
- Wikidata matching is deliberately strict (exact label + company-like
  description); ambiguities are reported.
- Stub resolution is limited to dual-listed A/HK names with a structured
  `H股代码`. Other cross-market duplicates need a deterministic identifier
  before P1.3 ownership work.

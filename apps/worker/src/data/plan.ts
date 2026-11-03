import type { EntityCompany, FilingStateSnapshot } from "@occ/db";

/**
 * Pure planning for the daily data sweep (P1.5).
 *
 * The sweep is state, not a registry: candidates are derived from each
 * company's securities/identifiers and the `company_filing_state` rows are
 * merged in. This keeps the SQL simple and makes the source selection
 * deterministic and unit-testable.
 *
 * Source rules:
 * - US company with a SEC CIK → `edgar`
 * - SSE/SZSE listing → `cninfo` (CNINFO covers both boards)
 * - HKEX listing → `hkexnews`
 * - A/HK listing with no usable official adapter (e.g. BSE-only) → `f10`
 *   content-hash fallback
 */

export type DataMarket = "A" | "HK" | "US";
export type DataSource = "edgar" | "cninfo" | "hkexnews" | "f10";

export const DATA_SOURCES: readonly DataSource[] = [
  "edgar",
  "cninfo",
  "hkexnews",
  "f10",
];

export interface FilingCheckCandidate {
  companyId: string;
  slug: string;
  name: string;
  market: DataMarket;
  source: DataSource;
  /** Raw security ticker; used by the financials job and logs. */
  ticker: string;
  /** Adapter code: CIK-backed ticker (US), numeric ticker (A/HK). */
  code: string;
  cik?: string;
  lastCheckedAt: Date | null;
  cursor: string | null;
  nextDueAt: Date | null;
}

export interface PlanFilingChecksOptions {
  now?: Date;
  limit?: number;
  companyIds?: Set<string>;
  sources?: Set<string>;
}

const US_EXCHANGES = new Set(["NASDAQ", "NYSE", "AMEX", "CBOE"]);
const A_EXCHANGES = new Set(["SSE", "SZSE"]);
const HK_EXCHANGES = new Set(["HKEX"]);

/** Prefer the security that is mirrored in `company_ids` as a ticker. */
function tickerKeys(company: EntityCompany): Set<string> {
  return new Set(
    company.identifiers
      .filter((identifier) => identifier.idType === "ticker")
      .map((identifier) => normalizeTicker(identifier.idValue)),
  );
}

function normalizeTicker(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/\.(HK|SZ|SH|SS)$/i, "")
    .replace(/-/g, ".");
}

function exchangeRank(exchange: string, market: DataMarket): number {
  const value = exchange.toUpperCase();
  if (market === "A") return value === "SSE" || value === "SZSE" ? 0 : 1;
  if (market === "HK") return value === "HKEX" ? 0 : 1;
  return value === "NASDAQ" || value === "NYSE" ? 0 : 1;
}

function pickSecurity(
  company: EntityCompany,
  exchanges: Set<string>,
  market: DataMarket,
): { ticker: string; exchange: string } | null {
  const known = tickerKeys(company);
  const matches = company.securities.filter((security) =>
    exchanges.has(security.exchange.toUpperCase()),
  );
  if (matches.length === 0) return null;
  matches.sort((left, right) => {
    const leftKnown = known.has(normalizeTicker(left.ticker)) ? 0 : 1;
    const rightKnown = known.has(normalizeTicker(right.ticker)) ? 0 : 1;
    if (leftKnown !== rightKnown) return leftKnown - rightKnown;
    const rank =
      exchangeRank(left.exchange, market) - exchangeRank(right.exchange, market);
    if (rank !== 0) return rank;
    return left.ticker.localeCompare(right.ticker);
  });
  return matches[0]!;
}

function cikOf(company: EntityCompany): string | undefined {
  return company.identifiers
    .find((identifier) => identifier.idType === "cik")
    ?.idValue.trim();
}

function numericCode(ticker: string, pad = 0): string | null {
  const digits = ticker.replace(/\D/g, "");
  if (!digits) return null;
  return pad > 0 ? digits.padStart(pad, "0") : digits;
}

/** All official + fallback candidates for one company. */
export function candidatesForCompany(
  company: EntityCompany,
): FilingCheckCandidate[] {
  if (company.isFixture || company.coverageTier === "stub") return [];
  const out: FilingCheckCandidate[] = [];

  const us = pickSecurity(company, US_EXCHANGES, "US");
  const cik = cikOf(company);
  if (us && cik) {
    out.push({
      companyId: company.id,
      slug: company.slug,
      name: company.displayName,
      market: "US",
      source: "edgar",
      ticker: us.ticker,
      code: us.ticker,
      cik,
      lastCheckedAt: null,
      cursor: null,
      nextDueAt: null,
    });
  }

  const a = pickSecurity(company, A_EXCHANGES, "A");
  if (a) {
    const code = numericCode(a.ticker);
    if (code) {
      out.push({
        companyId: company.id,
        slug: company.slug,
        name: company.displayName,
        market: "A",
        source: "cninfo",
        ticker: a.ticker,
        code,
        lastCheckedAt: null,
        cursor: null,
        nextDueAt: null,
      });
    }
  }

  const hk = pickSecurity(company, HK_EXCHANGES, "HK");
  if (hk) {
    const code = numericCode(hk.ticker, 5);
    if (code) {
      out.push({
        companyId: company.id,
        slug: company.slug,
        name: company.displayName,
        market: "HK",
        source: "hkexnews",
        ticker: hk.ticker,
        code,
        lastCheckedAt: null,
        cursor: null,
        nextDueAt: null,
      });
    }
  }

  // Fallback only when no official feed exists (e.g. BSE-only A-share).
  if (out.length === 0) {
    const bse = pickSecurity(company, new Set(["BSE"]), "A");
    if (bse) {
      const code = numericCode(bse.ticker);
      if (code) {
        out.push({
          companyId: company.id,
          slug: company.slug,
          name: company.displayName,
          market: "A",
          source: "f10",
          ticker: bse.ticker,
          code,
          lastCheckedAt: null,
          cursor: null,
          nextDueAt: null,
        });
      }
    }
  }

  return out;
}

export function planFilingChecks(
  companies: EntityCompany[],
  states: Map<string, FilingStateSnapshot>,
  options: PlanFilingChecksOptions = {},
): FilingCheckCandidate[] {
  const now = options.now ?? new Date();
  const limit =
    options.limit && Number.isFinite(options.limit) && options.limit > 0
      ? Math.floor(options.limit)
      : 500;
  const out: FilingCheckCandidate[] = [];
  for (const company of companies) {
    if (options.companyIds && !options.companyIds.has(company.id)) continue;
    for (const candidate of candidatesForCompany(company)) {
      if (options.sources && !options.sources.has(candidate.source)) continue;
      const state = states.get(`${company.id}:${candidate.source}`);
      const nextDueAt = state?.nextDueAt ?? null;
      if (nextDueAt && nextDueAt.getTime() > now.getTime()) continue;
      out.push({
        ...candidate,
        lastCheckedAt: state?.lastCheckedAt ?? null,
        cursor: state?.cursor ?? null,
        nextDueAt,
      });
    }
  }
  out.sort((left, right) => {
    const due =
      (left.nextDueAt?.getTime() ?? 0) - (right.nextDueAt?.getTime() ?? 0);
    if (due !== 0) return due;
    const company = left.companyId.localeCompare(right.companyId);
    if (company !== 0) return company;
    return left.source.localeCompare(right.source);
  });
  return out.slice(0, limit);
}

/**
 * Discovery window for one check. Cold start uses `coldDays`; steady state
 * looks back to the previous successful check plus two days, capped so a long
 * outage still re-reads a bounded index.
 */
export function dataCheckWindow(
  lastCheckedAt: Date | null,
  now: Date,
  options: { coldDays: number; maxDays: number },
): { sinceDays: number; since: Date } {
  const dayMs = 86_400_000;
  let sinceDays: number;
  if (!lastCheckedAt) {
    sinceDays = Math.max(1, options.coldDays);
  } else {
    const elapsed = Math.max(0, now.getTime() - lastCheckedAt.getTime());
    sinceDays = Math.min(
      Math.max(1, options.maxDays),
      Math.max(2, Math.ceil(elapsed / dayMs) + 2),
    );
  }
  return {
    sinceDays,
    since: new Date(now.getTime() - sinceDays * dayMs),
  };
}

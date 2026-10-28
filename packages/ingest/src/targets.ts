import type { Market } from "@occ/core";

export interface IngestTarget {
  /** Stable dedupe key: `US:AAPL`, `A:600519`, `HK:00700`. */
  key: string;
  ticker: string;
  /** Human/company name used when the section has no usable heading. */
  name: string;
  market: Market;
  code?: string;
  exchange?: string;
  country?: string;
  website?: string | null;
  coverageTier?: "index_member" | "ai_watchlist" | "discovered" | "stub";
  indexCode?: string;
  indexAsOf?: string;
}

export interface ParsedTicker {
  key: string;
  ticker: string;
  market: Market;
  code: string;
}

/**
 * Parse `AAPL`, `AAPL:US`, `600519`, `600519:A`, `00700`, `02513.HK`, `BRK.B`.
 * Mirrors the worker's ticker conventions so CLI and backfill agree on keys.
 */
export function parseTicker(raw: string, defaultMarket: Market = "US"): ParsedTicker | null {
  let value = raw.trim();
  if (!value) return null;

  let explicitMarket: string | undefined;
  if (value.includes(":")) {
    const [left, right] = value.split(":");
    value = left!.trim();
    explicitMarket = right?.trim().toUpperCase();
  }

  let market: Market;
  let code: string;
  let ticker: string;

  const hkSuffix = /^(.+)\.HK$/i.exec(value);
  const cnSuffix = /^(.+)\.(SH|SZ)$/i.exec(value);
  if (hkSuffix) {
    market = "HK";
    code = hkSuffix[1]!.padStart(5, "0");
    ticker = code;
  } else if (cnSuffix) {
    market = "A";
    code = cnSuffix[1]!;
    ticker = code;
  } else if (explicitMarket) {
    market = normalizeMarket(explicitMarket);
    code = normalizeCode(market, value);
    ticker = code;
  } else if (/^(SH|SZ)\d{6}$/i.test(value)) {
    market = "A";
    code = value.slice(2);
    ticker = code;
  } else if (/^\d{6}$/.test(value)) {
    market = "A";
    code = value;
    ticker = code;
  } else if (/^\d{1,5}$/.test(value)) {
    market = "HK";
    code = value.padStart(5, "0");
    ticker = code;
  } else {
    market = defaultMarket;
    code = value.toUpperCase();
    ticker = code;
  }

  if (!/^[A-Za-z0-9.-]+$/.test(code)) return null;
  return { key: `${market}:${code}`, ticker, market, code };
}

export function exchangeForMarket(market: Market, code: string): string {
  if (market === "HK") return "HKEX";
  if (market === "A") return /^(6|9)/.test(code) ? "SSE" : "SZSE";
  return "NASDAQ";
}

export function countryForMarket(market: Market): string {
  if (market === "HK") return "HK";
  if (market === "A") return "CN";
  return "US";
}

export function currencyForMarket(market: Market): string {
  if (market === "HK") return "HKD";
  if (market === "A") return "CNY";
  return "USD";
}

/** External ticker id value: `AAPL`, `00700.HK`, `600519.SH`. */
export function tickerIdValue(target: Pick<IngestTarget, "market" | "ticker" | "code" | "exchange">): string {
  if (target.market === "HK") return `${target.code ?? target.ticker}.HK`;
  if (target.market === "A") {
    const exchange = target.exchange ?? exchangeForMarket("A", target.code ?? target.ticker);
    return `${target.code ?? target.ticker}.${exchange === "SSE" ? "SH" : "SZ"}`;
  }
  return target.ticker;
}

function normalizeMarket(value: string): Market {
  if (value === "A" || value === "HK" || value === "US") return value;
  throw new Error(`unknown market ${value}; use A, HK or US`);
}

function normalizeCode(market: Market, value: string): string {
  if (market === "HK") return value.replace(/^0*/, "").padStart(5, "0");
  if (market === "A") return value.replace(/^(SH|SZ)/i, "");
  return value.toUpperCase();
}

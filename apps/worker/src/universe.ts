import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { primaryConstituents, loadIndexSnapshot } from "@occ/ingest";
import { parse as parseYaml } from "yaml";

import type { CoverageTier } from "@occ/core";
import type { Market } from "@occ/sources-eastmoney-f10";

import { config } from "./config.js";

export interface CompanyTarget {
  /** Stable dedupe key: `US:AAPL`, `A:600519`, `HK:00700`, or `NAME:<slug>`. */
  key: string;
  ticker: string;
  name: string;
  market?: Market;
  code?: string;
  exchange?: string;
  focus?: string;
  priority: number;
  source: "mag7" | "ai-watchlist" | "index" | "explicit";
  coverageTier?: CoverageTier;
  indexCode?: string;
  indexAsOf?: string;
}

const PRIORITY = {
  ai: 100,
  index: 70,
  mag7: 60,
  explicit: 50,
} as const;

interface Mag7Entry {
  ticker: string;
  company: string;
  focus?: string;
}

export async function loadMag7Targets(): Promise<CompanyTarget[]> {
  const modulePath = path.join(config.repoRoot, "phase0", "lib", "companies.mjs");
  const module = (await import(pathToFileURL(modulePath).href)) as {
    COMPANIES: Mag7Entry[];
  };
  return module.COMPANIES.map((entry) => ({
    key: `US:${entry.ticker}`,
    ticker: entry.ticker,
    name: entry.company,
    market: "US",
    code: entry.ticker,
    focus: entry.focus,
    priority: PRIORITY.mag7,
    source: "mag7",
    coverageTier: "index_member",
  }));
}

interface WatchlistEntry {
  name: string;
  status?: string;
  identifiers?: Array<{ type?: string; value?: string }>;
}

export async function loadAiWatchlistTargets(): Promise<CompanyTarget[]> {
  const doc = parseYaml(fs.readFileSync(config.universeFile, "utf8")) as {
    ai_watchlist?: WatchlistEntry[];
  };
  const targets: CompanyTarget[] = [];
  for (const entry of doc.ai_watchlist ?? []) {
    const identifier = (entry.identifiers ?? []).find(
      (item) => item.type === "ticker" && item.value,
    );
    const base: CompanyTarget = {
      key: `NAME:${slug(entry.name)}`,
      ticker: entry.name,
      name: entry.name,
      priority: PRIORITY.ai,
      source: "ai-watchlist",
      coverageTier: "ai_watchlist",
    };
    if (identifier?.value) {
      const parsed = parseTicker(identifier.value);
      if (parsed) {
        targets.push({
          ...base,
          key: parsed.key,
          ticker: parsed.ticker,
          market: parsed.market,
          code: parsed.code,
        });
        continue;
      }
    }
    targets.push(base);
  }
  return targets;
}

/** Index universes map to a validated snapshot under `config/indices`. */
const INDEX_UNIVERSES: Record<
  string,
  { file: string; market: Market; exchange: string; coverage: CoverageTier }
> = {
  ndx: {
    file: "ndx.yaml",
    market: "US",
    exchange: "NASDAQ",
    coverage: "index_member",
  },
  nasdaq100: {
    file: "ndx.yaml",
    market: "US",
    exchange: "NASDAQ",
    coverage: "index_member",
  },
  hsi: {
    file: "hsi.yaml",
    market: "HK",
    exchange: "HKEX",
    coverage: "index_member",
  },
  hangsen: {
    file: "hsi.yaml",
    market: "HK",
    exchange: "HKEX",
    coverage: "index_member",
  },
  cyb50: {
    file: "cyb50.yaml",
    market: "A",
    exchange: "SZSE",
    coverage: "index_member",
  },
  chinext50: {
    file: "cyb50.yaml",
    market: "A",
    exchange: "SZSE",
    coverage: "index_member",
  },
};

/** Primary listings from an index snapshot (`config/indices/<universe>.yaml`). */
export async function loadIndexTargets(universe: string): Promise<CompanyTarget[]> {
  const spec = INDEX_UNIVERSES[universe];
  if (!spec) {
    throw new Error(
      `unknown index universe ${universe}; use ${Object.keys(INDEX_UNIVERSES).join(", ")}`,
    );
  }
  const snapshot = loadIndexSnapshot(path.join(config.indicesDir, spec.file));
  return primaryConstituents(snapshot).map((entry) => {
    const code = normalizeCodeForMarket(spec.market, entry.ticker);
    return {
      key: `${spec.market}:${code}`,
      ticker: code,
      name: entry.name,
      market: spec.market,
      code,
      exchange: entry.exchange || spec.exchange,
      priority: PRIORITY.index,
      source: "index" as const,
      coverageTier: spec.coverage,
      indexCode: snapshot.index.code,
      indexAsOf: snapshot.index.as_of,
    };
  });
}

export interface ParsedTicker {
  key: string;
  ticker: string;
  market: Market;
  code: string;
}

/** Parse `AAPL`, `AAPL:US`, `600519`, `600519:A`, `00700`, `02513.HK`, `BRK.B`. */
export function parseTicker(raw: string): ParsedTicker | null {
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
    code = normalizeCodeForMarket(market, value);
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
    market = "US";
    code = value.toUpperCase();
    ticker = code;
  }

  if (!/^[A-Za-z0-9.-]+$/.test(code)) return null;

  return {
    key: `${market}:${code}`,
    ticker,
    market,
    code,
  };
}

function normalizeMarket(value: string): Market {
  if (value === "A" || value === "HK" || value === "US") return value;
  throw new Error(`unknown market ${value}; use A, HK or US`);
}

function normalizeCodeForMarket(market: Market, value: string): string {
  if (market === "HK") return value.replace(/^0*/, "").padStart(5, "0");
  if (market === "A") return value.replace(/^(SH|SZ)/i, "");
  return value.toUpperCase();
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export interface ResolveOptions {
  universe?: string;
  tickers?: string;
  /** Comma-separated keys/tickers to drop after universe expansion. */
  exclude?: string;
  limit?: number;
  shard?: { index: number; count: number };
  requireF10?: boolean;
}

export async function resolveTargets(
  options: ResolveOptions,
): Promise<CompanyTarget[]> {
  const known = new Map<string, CompanyTarget>();

  const universe = options.universe?.toLowerCase();
  if (universe) {
    if (universe === "mag7") {
      for (const target of await loadMag7Targets()) known.set(target.key, target);
    } else if (universe === "ai" || universe === "ai-watchlist") {
      for (const target of await loadAiWatchlistTargets()) known.set(target.key, target);
    } else if (universe in INDEX_UNIVERSES) {
      for (const target of await loadIndexTargets(universe)) {
        known.set(target.key, target);
      }
    } else {
      throw new Error(
        `unknown universe ${options.universe}; use mag7, ai-watchlist, ndx, hsi or cyb50`,
      );
    }
  }

  for (const raw of (options.tickers ?? "").split(",")) {
    const parsed = parseTicker(raw);
    if (!parsed) continue;
    const existing = known.get(parsed.key);
    if (existing) {
      known.set(parsed.key, {
        ...existing,
        priority: Math.max(existing.priority, PRIORITY.explicit),
        source: "explicit",
      });
      continue;
    }
    known.set(parsed.key, {
      key: parsed.key,
      ticker: parsed.ticker,
      name: parsed.ticker,
      market: parsed.market,
      code: parsed.code,
      priority: PRIORITY.explicit,
      source: "explicit",
    });
  }

  let targets = [...known.values()];
  const excluded = new Set<string>();
  for (const raw of (options.exclude ?? "").split(",")) {
    const value = raw.trim();
    if (!value) continue;
    const parsed = parseTicker(value);
    if (parsed) excluded.add(parsed.key);
    excluded.add(value);
  }
  if (excluded.size > 0) {
    targets = targets.filter(
      (target) =>
        !excluded.has(target.key) &&
        !excluded.has(target.ticker) &&
        !excluded.has(target.code ?? ""),
    );
  }
  if (options.requireF10) {
    targets = targets.filter((target) => target.market && target.code);
  }
  if (options.shard) {
    targets = filterShard(targets, options.shard.index, options.shard.count);
  }
  targets.sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key));
  if (options.limit && options.limit > 0) targets = targets.slice(0, options.limit);
  return targets;
}

export function filterShard(
  targets: CompanyTarget[],
  index: number,
  count: number,
): CompanyTarget[] {
  if (count <= 0 || index < 0 || index >= count) {
    throw new Error(`invalid shard ${index}/${count}`);
  }
  return targets.filter(
    (target) => shardOf(target.key, count) === index,
  );
}

export function shardOf(key: string, count: number): number {
  const digest = createHash("sha256").update(key).digest();
  return digest.readUInt32BE(0) % count;
}

import fs from "node:fs";
import path from "node:path";

import type {
  EdgarCompanyFacts,
  EdgarSubmissions,
} from "@occ/extract";

import { config, ensureDir } from "../config.js";

/**
 * Minimal SEC EDGAR client with an on-disk cache and the required politeness
 * rules: a declared User-Agent with contact info and <=10 requests/second.
 *
 * JSON is cached under `.occ/edgar/` so repeated financials runs are offline
 * and idempotent. `--force` bypasses the cache.
 */

const TICKER_MAP_TTL_MS = 7 * 86_400_000;
const MIN_REQUEST_INTERVAL_MS = 110;

let gate: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

interface TickerEntry {
  cik: string;
  title?: string;
}

export interface EdgarResolution {
  cik: string;
  title?: string;
}

export async function resolveEdgarCik(
  ticker: string,
  force = false,
): Promise<EdgarResolution | null> {
  const map = await loadTickerMap(force);
  const normalized = ticker.trim().toUpperCase();
  return map.get(normalized) ?? map.get(normalized.replace(/\./g, "-")) ?? null;
}

export async function fetchEdgarCompanyFacts(
  cik: string,
  force = false,
): Promise<EdgarCompanyFacts> {
  const file = path.join(config.edgarDir, cik, "companyfacts.json");
  const cached = readCache<EdgarCompanyFacts>(
    file,
    config.edgarCacheTtlMs,
    force,
  );
  if (cached) return cached;
  const payload = (await fetchJson(
    `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`,
  )) as EdgarCompanyFacts;
  writeCache(file, payload);
  return payload;
}

export async function fetchEdgarSubmissions(
  cik: string,
  force = false,
): Promise<EdgarSubmissions> {
  const file = path.join(config.edgarDir, cik, "submissions.json");
  const cached = readCache<EdgarSubmissions>(
    file,
    config.edgarCacheTtlMs,
    force,
  );
  if (cached) return cached;
  const payload = (await fetchJson(
    `https://data.sec.gov/submissions/CIK${cik}.json`,
  )) as EdgarSubmissions;
  writeCache(file, payload);
  return payload;
}

async function loadTickerMap(force: boolean): Promise<Map<string, TickerEntry>> {
  const file = path.join(config.edgarDir, "company_tickers.json");
  const cached = readCache<Record<string, { cik_str: number; ticker: string; title?: string }>>(
    file,
    TICKER_MAP_TTL_MS,
    force,
  );
  const payload =
    cached ??
    ((await fetchJson("https://www.sec.gov/files/company_tickers.json")) as Record<
      string,
      { cik_str: number; ticker: string; title?: string }
    >);
  if (!cached) writeCache(file, payload);
  const map = new Map<string, TickerEntry>();
  for (const entry of Object.values(payload)) {
    if (!entry?.ticker || entry.cik_str === undefined) continue;
    map.set(entry.ticker.toUpperCase(), {
      cik: String(entry.cik_str).padStart(10, "0"),
      ...(entry.title ? { title: entry.title } : {}),
    });
  }
  return map;
}

function readCache<T>(file: string, ttlMs: number, force: boolean): T | null {
  if (force) return null;
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > ttlMs) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeCache(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

function userAgent(): string {
  const agent = config.edgarUserAgent.trim();
  if (!agent.includes("@")) {
    throw new Error(
      "OCC_EDGAR_USER_AGENT must name a contact (e.g. " +
        "'OpenCorpCheck/0.1 (contact: you@example.com)'); " +
        "SEC rejects automated requests without one",
    );
  }
  return agent;
}

async function fetchJson(url: string): Promise<unknown> {
  const agent = userAgent();
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await rateLimited(() =>
        fetch(url, {
          headers: {
            "User-Agent": agent,
            Accept: "application/json",
          },
        }),
      );
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1_000
          : 500 * 2 ** attempt;
        await sleep(waitMs);
        lastError = new Error(`SEC responded ${response.status} for ${url}`);
        continue;
      }
      if (!response.ok) {
        throw new Error(`SEC responded ${response.status} for ${url}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(500 * 2 ** attempt);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`SEC request failed: ${url}`);
}

function rateLimited<T>(fn: () => Promise<T>): Promise<T> {
  const result = gate.then(async () => {
    const wait = Math.max(
      0,
      MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt),
    );
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return fn();
  });
  gate = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

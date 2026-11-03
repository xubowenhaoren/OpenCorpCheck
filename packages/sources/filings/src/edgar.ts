import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_FILING_USER_AGENT,
  type FilingFetchOptions,
  type FilingItem,
} from "./types.js";
import { cleanText, startOfDay, isoDate } from "./text.js";

/**
 * SEC EDGAR filing index adapter (P1.4).
 *
 * The submissions JSON is the same official endpoint the financials pipeline
 * already uses. This adapter only discovers filing-level events; it does not
 * re-parse XBRL. Routine ownership/noise forms (Form 3/4/5, 144, 13F, N-PORT)
 * are excluded so the company timeline stays readable.
 */

export interface EdgarRecentFilings {
  accessionNumber?: string[];
  filingDate?: string[];
  reportDate?: string[];
  acceptanceDateTime?: string[];
  form?: string[];
  items?: string[];
  primaryDocument?: string[];
  primaryDocDescription?: string[];
  size?: number[];
  isXBRL?: number[];
  isInlineXBRL?: number[];
  core_type?: string[];
  act?: string[];
  fileNumber?: string[];
  filmNumber?: string[];
}

export interface EdgarSubmissionsPayload {
  cik?: string | number;
  name?: string;
  filings?: {
    recent?: EdgarRecentFilings;
  };
}

export interface ParseEdgarOptions {
  cik?: string;
  since?: string | Date;
  limit?: number;
  forms?: ReadonlySet<string>;
}

const DEFAULT_FORM_PREFIXES = [
  "8-K",
  "10-K",
  "10-Q",
  "20-F",
  "40-F",
  "6-K",
  "11-K",
  "DEF 14A",
  "DEFA14A",
  "PRE 14A",
  "SC 13D",
  "SC 13G",
  "S-1",
  "S-3",
  "S-4",
  "S-8",
  "F-1",
  "F-3",
  "424B",
  "25-NSE",
  "ARS",
];

/** Announcement-like forms only; amendments inherit their base form. */
export function isAnnouncementForm(form: string): boolean {
  const value = form.trim().toUpperCase();
  if (!value) return false;
  return DEFAULT_FORM_PREFIXES.some((prefix) => value.startsWith(prefix));
}

export function normalizeCik(value: string | number): string {
  return String(value).replace(/\D/g, "").padStart(10, "0");
}

export function edgarFilingUrl(
  cik: string,
  accession: string,
  primaryDocument?: string,
): string {
  const directory = `https://www.sec.gov/Archives/edgar/data/${Number(normalizeCik(cik))}/${accession.replace(/-/g, "")}/`;
  return primaryDocument ? `${directory}${primaryDocument}` : directory;
}

export function parseEdgarFilings(
  payload: EdgarSubmissionsPayload,
  options: ParseEdgarOptions = {},
): FilingItem[] {
  const recent = payload.filings?.recent;
  if (!recent) return [];
  const cik = normalizeCik(options.cik ?? payload.cik ?? "0");
  const since = options.since
    ? isoDate(options.since instanceof Date ? options.since : startOfDay(options.since))
    : undefined;
  const limit = options.limit && options.limit > 0 ? options.limit : undefined;
  const forms = options.forms;
  const rows = Math.max(
    recent.accessionNumber?.length ?? 0,
    recent.form?.length ?? 0,
  );
  const items: FilingItem[] = [];

  for (let index = 0; index < rows; index += 1) {
    const form = cleanText(recent.form?.[index]).toUpperCase();
    if (!form) continue;
    if (forms ? !forms.has(form) : !isAnnouncementForm(form)) continue;
    const filingDate = (recent.filingDate?.[index] ?? "").slice(0, 10);
    if (since && filingDate && filingDate < since) continue;
    const accession = (recent.accessionNumber?.[index] ?? "").trim();
    if (!accession) continue;
    const primaryDocument = (recent.primaryDocument?.[index] ?? "").trim();
    const description = cleanText(recent.primaryDocDescription?.[index]);
    const itemCodes = cleanText(recent.items?.[index]);
    const reportDate = (recent.reportDate?.[index] ?? "").trim();
    const accepted = (recent.acceptanceDateTime?.[index] ?? "").trim();
    const url = edgarFilingUrl(cik, accession, primaryDocument || undefined);
    const titleParts = [form];
    if (description && description.toUpperCase() !== form) titleParts.push(description);
    if (itemCodes) titleParts.push(`items ${itemCodes}`);
    items.push({
      source: "edgar",
      market: "US",
      externalId: accession,
      title: titleParts.join(" · "),
      url,
      ...(primaryDocument.toLowerCase().endsWith(".pdf") ? { pdfUrl: url } : {}),
      form,
      category: "SEC filing",
      publishedAt: accepted || (filingDate ? `${filingDate}T00:00:00.000Z` : undefined),
      ...(reportDate ? { periodEnd: reportDate } : {}),
      language: "en",
      trustTier: "official",
      metadata: {
        source: "sec-edgar-submissions",
        cik,
        accession,
        filingDate,
        reportDate: reportDate || null,
        acceptanceDateTime: accepted || null,
        items: itemCodes || null,
        primaryDocument: primaryDocument || null,
        primaryDocDescription: description || null,
        size: recent.size?.[index] ?? null,
        isXBRL: recent.isXBRL?.[index] ?? null,
        isInlineXBRL: recent.isInlineXBRL?.[index] ?? null,
        coreType: recent.core_type?.[index] ?? null,
        act: recent.act?.[index] ?? null,
        fileNumber: recent.fileNumber?.[index] ?? null,
        filmNumber: recent.filmNumber?.[index] ?? null,
      },
    });
    if (limit && items.length >= limit) break;
  }

  return items;
}

export interface FetchEdgarFilingsOptions extends FilingFetchOptions, ParseEdgarOptions {
  /** Cache root, normally `OCC_EDGAR_DIR` (`.occ/edgar`). */
  edgarDir: string;
  /** Cache TTL in ms; defaults to 24 h. */
  ttlMs?: number;
  force?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_REQUEST_INTERVAL_MS = 110;
let gate: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

export async function fetchEdgarFilings(
  cik: string,
  options: FetchEdgarFilingsOptions,
): Promise<{ items: FilingItem[]; fetched: boolean; cacheFile: string }> {
  const normalized = normalizeCik(cik);
  const cacheFile = path.join(options.edgarDir, normalized, "submissions.json");
  const cached = readCache(cacheFile, options.ttlMs ?? 86_400_000, Boolean(options.force));
  let payload: EdgarSubmissionsPayload;
  let fetched = false;
  if (cached) {
    payload = cached;
  } else {
    payload = (await fetchEdgarSubmissionsJson(normalized, options)) as EdgarSubmissionsPayload;
    writeCache(cacheFile, payload);
    fetched = true;
  }
  return {
    items: parseEdgarFilings(payload, { ...options, cik: normalized }),
    fetched,
    cacheFile,
  };
}

export async function fetchEdgarSubmissionsJson(
  cik: string,
  options: FilingFetchOptions = {},
): Promise<unknown> {
  const agent = (options.userAgent ?? DEFAULT_FILING_USER_AGENT).trim();
  if (!agent.includes("@")) {
    throw new Error(
      "OCC_EDGAR_USER_AGENT must name a contact (e.g. 'Name/1.0 (you@example.com)')",
    );
  }
  const url = `https://data.sec.gov/submissions/CIK${normalizeCik(cik)}.json`;
  const fetchImpl = options.fetchImpl ?? fetch;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await rateLimited(() =>
        fetchImpl(url, {
          headers: { "user-agent": agent, accept: "application/json" },
          signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        }),
      );
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
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

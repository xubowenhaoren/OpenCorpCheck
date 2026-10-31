import type { Market } from "@occ/core";

import type { UniverseCompany } from "./prompt.js";

/**
 * Structured shareholder/investment extraction from Eastmoney F10 tables.
 *
 * The LLM relation pass reads the profile's `关键关系` chapter; this pass reads
 * the structured shareholder tables that the profile usually omits. Only
 * counterparties already in our company universe become edges — out-of-universe
 * shareholders are counted and reported, never invented as companies.
 */

export interface F10Table {
  caption?: string;
  headers: string[];
  rows: string[][];
}

export interface F10Page {
  page?: string;
  label?: string;
  url: string;
  text?: string;
  tables: F10Table[];
  meta?: { fetched_at?: string };
}

export interface F10Shareholder {
  name: string;
  shares?: string;
  percent?: number;
  asOf?: string;
  quote: string;
  sourceUrl: string;
  page: string;
}

export interface F10RelationDraft {
  srcCompanyId: string;
  dstCompanyId: string;
  type: "owns" | "invests_in";
  quote: string;
  sourceUrl: string;
  confidence: number;
  validFrom?: string;
}

export interface F10RelationResult {
  relations: F10RelationDraft[];
  shareholders: F10Shareholder[];
  unmatched: F10Shareholder[];
  dropped: number;
}

const NAME_HEADERS = [
  "持股人",
  "股东名称",
  "直接/间接持股方",
  "直接间接持股方",
  "被投资公司",
  "公司名称",
  "机构名称",
];

const INBOUND_PAGES = new Set(["MajorShareholder", "gdyj", "gbgd"]);

export function isOwnershipPage(page: string): boolean {
  return INBOUND_PAGES.has(page);
}

/** Parse shareholder rows from one F10 page (HK/A/US table shapes). */
export function parseF10Shareholders(
  page: F10Page,
  market: Market,
): F10Shareholder[] {
  const rows: F10Shareholder[] = [];
  const pageDate = pageDateOf(page);
  for (const table of page.tables) {
    const headers = table.headers.map(normalizeHeader);
    if (headers.length < 2) continue;
    const nameIdx = headers.findIndex((header) =>
      NAME_HEADERS.some((candidate) => header === normalizeHeader(candidate)),
    );
    const percentIdx = headers.findIndex(
      (header) => header.includes("占比") || header.includes("持股比例"),
    );
    if (nameIdx === -1 || percentIdx === -1) continue;
    const sharesIdx = headers.findIndex(
      (header) => header.includes("权益股份") || header.includes("持股数"),
    );

    for (const row of table.rows) {
      if (row.length <= Math.max(nameIdx, percentIdx)) continue;
      const rawName = cleanName(row[nameIdx] ?? "");
      if (!rawName || isHeaderLike(rawName)) continue;
      const percent = parsePercent(row[percentIdx]);
      if (percent === undefined) continue;
      const quote = [
        `${table.headers[nameIdx] ?? "股东"}: ${rawName}`,
        `${table.headers[percentIdx] ?? "占比"}: ${row[percentIdx]}`,
        ...(sharesIdx >= 0 && row[sharesIdx]
          ? [`${table.headers[sharesIdx]}: ${row[sharesIdx]}`]
          : []),
      ].join(" | ");
      rows.push({
        name: rawName,
        ...(sharesIdx >= 0 && row[sharesIdx] ? { shares: row[sharesIdx] } : {}),
        percent,
        ...(pageDate ? { asOf: pageDate } : {}),
        quote: quote.slice(0, 1_000),
        sourceUrl: page.url,
        page: page.page ?? page.label ?? market,
      });
    }
  }
  return dedupeShareholders(rows);
}

/** Build directed edges from a shareholder table into the profiled company. */
export function buildF10Relations(input: {
  page: F10Page;
  market: Market;
  selfCompanyId: string;
  universe: UniverseCompany[];
  minPercent?: number;
}): F10RelationResult {
  const minPercent = input.minPercent ?? 0.5;
  const shareholders = parseF10Shareholders(input.page, input.market);
  const relations: F10RelationDraft[] = [];
  const unmatched: F10Shareholder[] = [];
  let dropped = 0;

  for (const shareholder of shareholders) {
    if ((shareholder.percent ?? 0) < minPercent) {
      dropped += 1;
      continue;
    }
    const target = resolveShareholder(shareholder.name, input.universe);
    if (!target || target.id === input.selfCompanyId) {
      unmatched.push(shareholder);
      continue;
    }
    const type = (shareholder.percent ?? 0) >= 50 ? "owns" : "invests_in";
    relations.push({
      srcCompanyId: target.id,
      dstCompanyId: input.selfCompanyId,
      type,
      quote: shareholder.quote,
      sourceUrl: shareholder.sourceUrl,
      confidence: 0.9,
      ...(shareholder.asOf ? { validFrom: shareholder.asOf } : {}),
    });
  }

  return {
    relations: dedupeRelations(relations),
    shareholders,
    unmatched,
    dropped,
  };
}

/** Resolve a shareholder legal name to an in-universe company. */
export function resolveShareholder(
  rawName: string,
  universe: UniverseCompany[],
): UniverseCompany | undefined {
  const needle = normalizeName(rawName);
  if (!needle) return undefined;
  for (const company of universe) {
    for (const name of company.names) {
      if (normalizeName(name) === needle) return company;
    }
    if (normalizeName(company.ticker) === needle) return company;
  }
  return undefined;
}

const SUFFIXES = [
  "股份有限公司",
  "有限责任公司",
  "集团有限公司",
  "控股有限公司",
  "有限公司",
  "集团",
  "控股",
  "公司",
  "incorporated",
  "corporation",
  "holdings",
  "limited",
  "company",
  "group",
  "corp",
  "inc",
  "ltd",
  "plc",
  "co",
];

function normalizeName(value: string): string {
  let text = value
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[.,，。()（）\-_/·]/g, "");
  for (const suffix of SUFFIXES) {
    if (text.endsWith(suffix)) {
      text = text.slice(0, -suffix.length);
      break;
    }
  }
  return text;
}

function normalizeHeader(value: string): string {
  return value.replace(/\s+/g, "").replace(/[()（）]/g, "");
}

function cleanName(value: string): string {
  return value
    .replace(/^(直|间)\s+/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isHeaderLike(value: string): boolean {
  return value === "股东名称" || value === "持股人" || value === "被投资公司";
}

function parsePercent(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.replace(/,/g, "").match(/(-?\d+(?:\.\d+)?)\s*%/);
  if (!match) return undefined;
  const number = Number(match[1]);
  return Number.isFinite(number) ? number : undefined;
}

function pageDateOf(page: F10Page): string | undefined {
  const dates = (page.text ?? "").match(/20\d{2}-\d{2}-\d{2}/g) ?? [];
  if (dates.length > 0) return dates.sort().at(-1);
  const fetched = page.meta?.fetched_at;
  if (fetched && /^\d{4}-\d{2}-\d{2}/.test(fetched)) return fetched.slice(0, 10);
  return undefined;
}

function dedupeShareholders(rows: F10Shareholder[]): F10Shareholder[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${normalizeName(row.name)}|${row.percent ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeRelations(rows: F10RelationDraft[]): F10RelationDraft[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.srcCompanyId}|${row.dstCompanyId}|${row.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

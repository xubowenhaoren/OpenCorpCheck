import type { Market } from "./types.js";
import {
  normalizeDomain,
  normalizeIsin,
  normalizeUscc,
} from "./text.js";

export interface F10ProfileTable {
  caption?: string;
  headers?: string[];
  rows?: string[][];
}

/** Minimal shape of one cached F10 profile page. */
export interface F10ProfilePage {
  page?: string;
  label?: string;
  url: string;
  text?: string;
  tables?: F10ProfileTable[];
  meta?: { fetched_at?: string };
}

export interface F10CompanyProfile {
  market: Market;
  page: string;
  url: string;
  fetchedAt?: string;
  companyName?: string;
  englishName?: string;
  /** A-share 所属东财行业, HK/US 所属行业. */
  industry?: string;
  /** A-share 所属证监会行业 only. */
  industryCsrc?: string;
  isin?: string;
  uscc?: string;
  website?: string;
  domain?: string;
  /** A-share listing code of a dual-listed company. */
  aCode?: string;
  /** H-share listing code of a dual-listed company. */
  hCode?: string;
  email?: string;
  /** Every non-empty key/value pair, for provenance/debugging. */
  fields: Record<string, string>;
}

const EMPTY_VALUES = new Set(["--", "-", "—", "暂无", "无", "N/A", "n/a"]);

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || EMPTY_VALUES.has(text)) return undefined;
  return text;
}

/**
 * Turn any table row into pairwise label/value fields. F10 renders two keys
 * per row (`A股代码 | 600519 | A股简称 | 贵州茅台`), and some rows are single
 * cells. Odd tails and captions are ignored.
 */
function collectFields(tables: F10ProfileTable[] | undefined): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const table of tables ?? []) {
    for (const row of table.rows ?? []) {
      const cells = row.map(clean);
      for (let index = 0; index + 1 < cells.length; index += 2) {
        const key = cells[index];
        const value = cells[index + 1];
        if (key && value && !(key in fields)) fields[key] = value;
      }
    }
  }
  return fields;
}

function textField(text: string | undefined, label: string): string | undefined {
  if (!text) return undefined;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}[^\\S\\n]*\\t([^\\t\\n]+)`).exec(text);
  return clean(match?.[1]);
}

function firstField(
  fields: Record<string, string>,
  text: string | undefined,
  labels: string[],
): string | undefined {
  for (const label of labels) {
    const value = fields[label] ?? textField(text, label);
    if (value) return value;
  }
  return undefined;
}

function digits(value: string | undefined, length?: number): string | undefined {
  if (!value) return undefined;
  const match = /\d+/.exec(value);
  if (!match) return undefined;
  const code = match[0];
  if (length !== undefined && code.length !== length) return undefined;
  return code;
}

/**
 * Parse the F10 company-profile page.
 *
 * - A-share: `gsgk` (公司概况) → 所属东财行业, 所属证监会行业, 工商登记 (USCC),
 *   公司网址, H股代码 (cross-listing).
 * - HK: `CompanyProfile` (公司概况) → 所属行业, ISIN, 公司网址.
 * - US: `gsgk` → 所属行业, ISIN, 公司网址.
 *
 * Values that fail validation are dropped rather than stored as-is.
 */
export function parseF10CompanyProfile(input: {
  market: Market;
  page: F10ProfilePage;
}): F10CompanyProfile {
  const { market, page } = input;
  const fields = collectFields(page.tables);
  const text = page.text;

  const companyName = firstField(fields, text, ["公司名称", "证券简称"]);
  const englishName = firstField(fields, text, ["英文名称"]);
  const industry =
    market === "A"
      ? firstField(fields, text, ["所属东财行业", "所属行业"])
      : firstField(fields, text, ["所属行业"]);
  const industryCsrc =
    market === "A"
      ? firstField(fields, text, ["所属证监会行业"])
      : undefined;
  const isin = normalizeIsin(
    firstField(fields, text, ["ISIN（国际证券识别编码）", "ISIN"]) ??
      /\bISIN[^\t\n]*\t([A-Z]{2}[A-Z0-9]{9}[0-9])/.exec(text ?? "")?.[1],
  );
  const uscc = normalizeUscc(
    firstField(fields, text, ["工商登记", "统一社会信用代码"]),
  );
  const website = firstField(fields, text, ["公司网址"]);
  const email = firstField(fields, text, ["电子信箱", "E-MAIL", "电邮地址"]);
  const aCode = digits(firstField(fields, text, ["A股代码"]), 6);
  const hCode = digits(firstField(fields, text, ["H股代码"]), 5);

  const profile: F10CompanyProfile = {
    market,
    page: page.page ?? (market === "HK" ? "CompanyProfile" : "gsgk"),
    url: page.url,
    fields,
    ...(page.meta?.fetched_at ? { fetchedAt: page.meta.fetched_at } : {}),
    ...(companyName ? { companyName } : {}),
    ...(englishName ? { englishName } : {}),
    ...(industry ? { industry } : {}),
    ...(industryCsrc ? { industryCsrc } : {}),
    ...(isin ? { isin } : {}),
    ...(uscc ? { uscc } : {}),
    ...(website ? { website } : {}),
    ...(email ? { email } : {}),
    ...(aCode ? { aCode } : {}),
    ...(hCode ? { hCode } : {}),
  };
  const domain = normalizeDomain(website);
  if (domain) profile.domain = domain;
  return profile;
}

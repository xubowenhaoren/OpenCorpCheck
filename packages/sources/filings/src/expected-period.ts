import { periodicReportKind, type PeriodicPeriodKind } from "./periodic.js";
import type { FilingSource } from "./types.js";

/**
 * Expected statement period for a periodic report (P1.5 follow-up).
 *
 * The daily check detects a periodic report, but A/HK structured financials
 * (F10) can lag the announcement. To verify that the expected period actually
 * landed without asking an LLM, we derive the period end deterministically:
 *
 * 1. the adapter's `periodEnd` (EDGAR `reportDate`);
 * 2. an explicit date in the title/category (`... ended 30 June 2026`,
 *    `截至2025年12月31日止年度`);
 * 3. a CNINFO title with a year + quarter/half/year (`2026年第三季度报告`);
 * 4. a deterministic fallback from the period kind and filing date.
 *
 * Returns `YYYY-MM-DD`, or `null` when the filing is not periodic.
 */
export interface ExpectedPeriodInput {
  source: FilingSource | string;
  form?: string | null;
  title?: string | null;
  category?: string | null;
  periodEnd?: string | null;
  publishedAt?: string | null;
}

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const QUARTER_END: Record<string, string> = {
  一: "03-31",
  1: "03-31",
  二: "06-30",
  2: "06-30",
  三: "09-30",
  3: "09-30",
  四: "12-31",
  4: "12-31",
};

function isoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function normalizePeriodEnd(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!match) return null;
  return isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

/** Explicit `30 June 2026` / `2025年12月31日` in an announcement title. */
function explicitDate(text: string): string | null {
  const en =
    /(?:ended|ending|as at|at)\s+(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?\s+(\d{4})/i.exec(
      text,
    );
  if (en) {
    const month = MONTHS[en[2]!.toLowerCase()];
    if (month) {
      const date = isoDate(Number(en[3]), month, Number(en[1]));
      if (date) return date;
    }
  }
  const cn =
    /(?:截至|止)\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(text);
  if (cn) {
    const date = isoDate(Number(cn[1]), Number(cn[2]), Number(cn[3]));
    if (date) return date;
  }
  return null;
}

/** Chinese title structure: `2026年第三季度报告` / `2025年半年度报告`. */
function chinesePeriod(text: string): { kind: PeriodicPeriodKind; end: string } | null {
  const quarter =
    /(20\d{2})\s*年\s*(?:第\s*)?([一二三四1-4])\s*(?:季度|季报)/.exec(text);
  if (quarter) {
    const end = QUARTER_END[quarter[2]!];
    if (end) return { kind: "quarter", end: `${quarter[1]}-${end}` };
  }
  const half = /(20\d{2})\s*年\s*(?:半年度|半年报|中期)/.exec(text);
  if (half) return { kind: "half", end: `${half[1]}-06-30` };
  const annual = /(20\d{2})\s*年\s*(?:年度|年报|全年)/.exec(text);
  if (annual) return { kind: "annual", end: `${annual[1]}-12-31` };
  return null;
}

function yearFromText(text: string): number | null {
  const fy = /\bFY\s*(20\d{2})\b/i.exec(text);
  if (fy) return Number(fy[1]);
  const year = /\b(20\d{2})\b/.exec(text);
  return year ? Number(year[1]) : null;
}

/**
 * Fallback for titles without a period (e.g. `ANNOUNCEMENT OF INTERIM
 * RESULTS`). A/HK issuers mostly use a December year-end; this is a bounded
 * heuristic used only for verification, never shown as a reported number.
 */
function fallbackPeriod(kind: PeriodicPeriodKind, filedAt: Date): string {
  const year = filedAt.getUTCFullYear();
  const month = filedAt.getUTCMonth() + 1;
  if (kind === "half") {
    return isoDate(month >= 7 ? year : year - 1, 6, 30)!;
  }
  if (kind === "quarter") {
    if (month <= 3) return isoDate(year - 1, 12, 31)!;
    if (month <= 6) return isoDate(year, 3, 31)!;
    if (month <= 9) return isoDate(year, 6, 30)!;
    return isoDate(year, 9, 30)!;
  }
  return isoDate(year - 1, 12, 31)!;
}

export function expectedPeriodEnd(input: ExpectedPeriodInput): string | null {
  const kind = periodicReportKind({
    source: input.source as FilingSource,
    ...(input.form ? { form: input.form } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.category ? { category: input.category } : {}),
  });
  if (!kind) return null;

  const direct = normalizePeriodEnd(input.periodEnd);
  if (direct) return direct;

  const text = `${input.title ?? ""} ${input.category ?? ""}`.trim();
  const explicit = explicitDate(text);
  if (explicit) return explicit;

  const chinese = chinesePeriod(text);
  if (chinese) return chinese.end;

  const year = yearFromText(text);
  if (year) {
    if (kind === "annual") return isoDate(year, 12, 31);
    if (kind === "half") return isoDate(year, 6, 30);
    // A bare year in a quarterly title is ambiguous; the filing-date
    // fallback below picks the most recent completed quarter instead.
  }

  const filedAt = input.publishedAt ? new Date(input.publishedAt) : new Date();
  return fallbackPeriod(
    kind,
    Number.isNaN(filedAt.getTime()) ? new Date() : filedAt,
  );
}

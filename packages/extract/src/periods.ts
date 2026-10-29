import type { PeriodKind } from "@occ/core";

export interface FiscalYearEnd {
  month: number;
  day: number;
  /** Explicit `FY2025 截至 YYYY-MM-DD` mappings. */
  explicitByYear: Map<number, string>;
  inferred: boolean;
}

export interface PeriodInfo {
  kind: PeriodKind;
  fiscalYear?: number;
  fiscalQuarter?: number;
  periodStart?: string;
  periodEnd: string;
  label: string;
  confidence: number;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function endOfMonth(year: number, month: number): string {
  const normalized = ((month - 1) % 12 + 12) % 12 + 1;
  const normalizedYear = year + Math.floor((month - 1) / 12);
  return iso(normalizedYear, normalized, daysInMonth(normalizedYear, normalized));
}

function shiftDate(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/** Parse the `财年` row of the company snapshot. */
export function parseFiscalYearEnd(snapshotText: string): FiscalYearEnd {
  const explicitByYear = new Map<number, string>();
  for (const match of snapshotText.matchAll(
    /FY\s*(\d{4})\s*(?:止于|截至|结束于|结束日期为)?\s*(\d{4})-(\d{2})-(\d{2})/g,
  )) {
    explicitByYear.set(Number(match[1]), `${match[2]}-${match[3]}-${match[4]}`);
  }

  const fiscalRow =
    snapshotText
      .split("\n")
      .find((line) => /^\|\s*财年\s*\|/.test(line.trim())) ?? "";

  let month = 12;
  let day = 31;
  let inferred = true;

  const lastWeekend = /(\d{1,2})\s*月最后一个周[六日]/.exec(fiscalRow);
  const monthRange = /(\d{1,2})\s*月\s*[—–-]\s*次年\s*(\d{1,2})\s*月/.exec(
    fiscalRow,
  );
  const dayPairs = [...fiscalRow.matchAll(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)];

  if (lastWeekend) {
    month = Number(lastWeekend[1]);
    day = daysInMonth(2025, month); // approximate; explicit dates win when present
    inferred = true;
  } else if (dayPairs.length > 0) {
    const last = dayPairs[dayPairs.length - 1]!;
    month = Number(last[1]);
    day = Number(last[2]);
    inferred = false;
  } else if (monthRange) {
    month = Number(monthRange[2]);
    day = daysInMonth(2025, month);
  } else if (/自然年|12\s*月\s*31\s*日/.test(fiscalRow)) {
    month = 12;
    day = 31;
    inferred = false;
  }

  return { month, day, explicitByYear, inferred };
}

function annualPeriod(year: number, fye: FiscalYearEnd): PeriodInfo {
  const explicit = fye.explicitByYear.get(year);
  const periodEnd =
    explicit ??
    iso(year, fye.month, Math.min(fye.day, daysInMonth(year, fye.month)));
  return {
    kind: "annual",
    fiscalYear: year,
    periodStart: shiftDate(periodEnd, -364),
    periodEnd,
    label: explicit ? `FY${year}` : `FY${year}（按财年结束日推算）`,
    confidence: explicit ? 1 : fye.inferred ? 0.6 : 0.8,
  };
}

function fiscalQuarterEnd(
  year: number,
  quarter: number,
  fye: FiscalYearEnd,
): string {
  const endMonth = fye.month - (4 - quarter) * 3;
  return endOfMonth(year, endMonth);
}

function calendarQuarterEnd(year: number, quarter: number): string {
  return endOfMonth(year, quarter * 3);
}

/**
 * Parse the period header of a financial table.
 *
 * Handles `FY2023`, `2023A`, `2026Q2`, `Q3 FY2026`, `2026H1`,
 * `H1 2026（六个月）`, `TTM 2026/6`, and explicit `截至 YYYY-MM-DD` dates.
 */
export function parsePeriodLabel(
  label: string,
  fye: FiscalYearEnd,
  fallbackEnd?: string,
): PeriodInfo | null {
  const raw = label.replace(/\s+/g, " ").trim();
  if (!raw) return null;

  const explicit = /(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (explicit) {
    const periodEnd = explicit[0];
    return {
      kind: /季度|Q[1-4]/i.test(raw) ? "quarter" : /半年|H[12]/i.test(raw) ? "half" : "annual",
      periodEnd,
      label: raw,
      confidence: 1,
    };
  }

  const ttm = /TTM\s*(\d{4})\s*[/-]\s*(\d{1,2})/i.exec(raw);
  if (ttm) {
    return {
      kind: "ttm",
      periodEnd: endOfMonth(Number(ttm[1]), Number(ttm[2])),
      label: raw,
      confidence: 0.9,
    };
  }
  if (/最新\s*12\s*个月|最近\s*12\s*个月/i.test(raw) && fallbackEnd) {
    return { kind: "ttm", periodEnd: fallbackEnd, label: raw, confidence: 0.6 };
  }

  const quarterEither = /Q([1-4])\s*(?:FY)?\s*(\d{4})/i.exec(raw);
  if (quarterEither) {
    const quarter = Number(quarterEither[1]);
    const year = Number(quarterEither[2]);
    const fiscal = /FY/i.test(raw);
    const periodEnd = fiscal
      ? fiscalQuarterEnd(year, quarter, fye)
      : calendarQuarterEnd(year, quarter);
    return {
      kind: "quarter",
      fiscalYear: year,
      fiscalQuarter: quarter,
      periodStart: shiftDate(periodEnd, -90),
      periodEnd,
      label: raw,
      confidence: fiscal ? (fye.inferred ? 0.6 : 0.75) : 0.85,
    };
  }

  const calendarQuarter = /(\d{4})\s*Q([1-4])/i.exec(raw);
  if (calendarQuarter) {
    const year = Number(calendarQuarter[1]);
    const quarter = Number(calendarQuarter[2]);
    const periodEnd = calendarQuarterEnd(year, quarter);
    return {
      kind: "quarter",
      fiscalYear: year,
      fiscalQuarter: quarter,
      periodStart: shiftDate(periodEnd, -90),
      periodEnd,
      label: raw,
      confidence: 0.85,
    };
  }

  const half = /(\d{4})\s*H([12])/i.exec(raw) ?? /H([12])\s*(\d{4})/i.exec(raw);
  if (half) {
    const firstIsYear = /^\d{4}$/.test(half[1]!);
    const year = Number(firstIsYear ? half[1] : half[2]);
    const halfNumber = Number(firstIsYear ? half[2] : half[1]);
    const periodEnd = endOfMonth(year, halfNumber * 6);
    return {
      kind: "half",
      fiscalYear: year,
      periodStart: shiftDate(periodEnd, -181),
      periodEnd,
      label: raw,
      confidence: 0.85,
    };
  }

  const annual = /FY\s*(\d{4})/i.exec(raw) ?? /(\d{4})\s*A?(?:\s*年度)?$/.exec(raw);
  if (annual) {
    return annualPeriod(Number(annual[1]), fye);
  }

  return null;
}

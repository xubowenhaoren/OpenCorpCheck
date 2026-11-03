import type { FilingItem, FilingSource } from "./types.js";

/**
 * Deterministic periodic-report classification (P1.5).
 *
 * Detection never asks an LLM: a new filing triggers the financials pipeline
 * only when its form/title is unambiguously an annual, interim or quarterly
 * report. Announcements such as profit warnings, board-meeting dates,
 * clarification notices and report summaries are deliberately excluded.
 */

export type PeriodicPeriodKind = "annual" | "half" | "quarter";

export interface PeriodicInput {
  source: FilingSource;
  form?: string;
  title?: string;
  category?: string;
}

/** Base form with an amendment suffix removed (`10-K/A` → `10-K`). */
export function baseFilingForm(form: string | undefined): string {
  return (form ?? "").trim().toUpperCase().replace(/\/(A|T)$/, "");
}

export function edgarPeriodicKind(
  form: string | undefined,
): PeriodicPeriodKind | null {
  switch (baseFilingForm(form)) {
    case "10-K":
    case "20-F":
    case "40-F":
      return "annual";
    case "10-Q":
      return "quarter";
    default:
      // 8-K/6-K can carry results but are not guaranteed periodic reports;
      // treating them as periodic would re-run financials on every update.
      return null;
  }
}

const CNINFO_NON_REPORT =
  /摘要|英文版|英文|English|业绩说明会|说明会|业绩预告|业绩快报|预告|快报|问询|回复|提示性公告|停牌|复牌|澄清|更正公告的更正|预约披露/;

export function cninfoPeriodicKind(input: {
  title?: string;
  form?: string;
}): PeriodicPeriodKind | null {
  const title = (input.title ?? "").trim();
  if (title && CNINFO_NON_REPORT.test(title)) return null;
  if (/半年度报告|半年报|中期报告|中期业绩/.test(title)) return "half";
  if (/年度报告|年报|年度业绩|全年业绩/.test(title)) return "annual";
  if (/季度报告|季报|第一季度|第三季度|一季度|三季度/.test(title)) {
    return "quarter";
  }
  switch ((input.form ?? "").trim()) {
    case "年报":
      return "annual";
    case "半年报":
      return "half";
    case "季报":
      return "quarter";
    default:
      return null;
  }
}

const HKEX_NON_REPORT =
  /board meeting|date of board meeting|profit warning|profit alert|positive profit alert|clarification|suspension|change of|appointment|resignation|月报表|月報表|翌日披露|next day disclosure|董事会会议|盈利警告|正面盈利预告|澄清|停牌|复牌|委任|辞任|股东周年大会|股东特别大会|agm|egm/i;

export function hkexPeriodicKind(input: {
  title?: string;
  category?: string;
}): PeriodicPeriodKind | null {
  const text = `${input.title ?? ""} ${input.category ?? ""}`.trim();
  if (!text) return null;
  if (HKEX_NON_REPORT.test(text)) return null;
  if (
    /interim results|interim report|half.?year results|中期业绩|中期報告|中期报告|半年业绩|半年報告|半年报/i.test(
      text,
    )
  ) {
    return "half";
  }
  if (
    /quarterly results|quarterly report|first quarter|third quarter|nine months|季度业绩|季度報告|季度报告|第一季度|第三季度|首季业绩/i.test(
      text,
    )
  ) {
    return "quarter";
  }
  if (
    /annual results|final results|annual report|year.?end results|年度业绩|年度業績|全年业绩|全年業績|年度报告|年度報告|年报|年報/i.test(
      text,
    )
  ) {
    return "annual";
  }
  return null;
}

export function periodicReportKind(
  input: PeriodicInput,
): PeriodicPeriodKind | null {
  switch (input.source) {
    case "edgar":
      return edgarPeriodicKind(input.form);
    case "cninfo":
      return cninfoPeriodicKind({ title: input.title, form: input.form });
    case "hkexnews":
      return hkexPeriodicKind({ title: input.title, category: input.category });
    default:
      return null;
  }
}

export function isPeriodicReport(input: PeriodicInput): boolean {
  return periodicReportKind(input) !== null;
}

/** Convenience wrapper for a discovered `FilingItem`. */
export function filingPeriodicKind(
  item: Pick<FilingItem, "source" | "form" | "title" | "category">,
): PeriodicPeriodKind | null {
  return periodicReportKind({
    source: item.source,
    ...(item.form ? { form: item.form } : {}),
    ...(item.title ? { title: item.title } : {}),
    ...(item.category ? { category: item.category } : {}),
  });
}

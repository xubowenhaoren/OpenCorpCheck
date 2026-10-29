import type { Market, PeriodKind } from "@occ/core";
import { financialFactId } from "@occ/db";
import type { SectionChapter } from "@occ/ingest";

import { citationRefs, parseMarkdownTables, stripCitations } from "./markdown-table.js";
import {
  parseFiscalYearEnd,
  parsePeriodLabel,
  type FiscalYearEnd,
} from "./periods.js";
import { parseNumericCell, parseUnitContext } from "./units.js";

export interface FinancialDraft {
  id: string;
  companyId: string;
  statement: string;
  item: string;
  periodKind: PeriodKind;
  periodLabel: string;
  periodStart?: string;
  periodEnd: string;
  fiscalYear?: number;
  fiscalQuarter?: number;
  value: number;
  unit: string;
  currency?: string;
  quote: string;
  method: string;
  confidence: number;
  sourceRefs: number[];
  sourceRef?: number;
}

interface Metric {
  test: RegExp;
  statement: string;
  item: string;
  kind?: "percent" | "per_share";
}

const METRICS: Metric[] = [
  { test: /归母净利润|净利润（归母）|净利润\(归母\)|归母净利/, statement: "income", item: "net_income_attributable" },
  { test: /营业总收入|营业收入|营收|^收入$/, statement: "income", item: "revenue" },
  { test: /毛利率/, statement: "income", item: "gross_margin", kind: "percent" },
  { test: /营业利润/, statement: "income", item: "operating_income" },
  { test: /净利润/, statement: "income", item: "net_income" },
  { test: /每股收益|EPS/i, statement: "per_share", item: "eps", kind: "per_share" },
  { test: /经营现金流|经营活动现金流/, statement: "cash_flow", item: "operating_cash_flow" },
  { test: /资本开支|Capex/i, statement: "cash_flow", item: "capex" },
  { test: /自由现金流/, statement: "cash_flow", item: "free_cash_flow" },
];

function metricFor(label: string): Metric | null {
  const clean = stripCitations(label).replace(/[*＊]/g, "").trim();
  return METRICS.find((metric) => metric.test.test(clean)) ?? null;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
}

/**
 * Parse the `财务表现` chapter. Returns one row per metric × period; missing
 * cells (`未验证`, `未单列`) are skipped instead of becoming zero.
 */
export function extractFinancials(input: {
  companyId: string;
  chapter: SectionChapter;
  market: Market;
  fye?: FiscalYearEnd;
  dataCutoff?: string;
}): FinancialDraft[] {
  const fye = input.fye ?? parseFiscalYearEnd(input.chapter.text);
  const tables = parseMarkdownTables(input.chapter.text);
  const table = tables.find(
    (candidate) =>
      candidate.headers.length >= 3 &&
      /指标|项目|科目/.test(candidate.headers[0] ?? ""),
  );
  if (!table) return [];

  const unitContext = parseUnitContext(
    input.chapter.section,
    input.chapter.text,
    input.market,
  );
  const chapterRefs = citationRefs(input.chapter.text);
  const periods = table.headers.slice(1);
  const drafts: FinancialDraft[] = [];

  for (const [rowIndex, row] of table.rows.entries()) {
    const metric = metricFor(row[0] ?? "");
    if (!metric) continue;
    const rowRefs = citationRefs(row.join(" "));
    const quote = table.rawRows[rowIndex] ?? row.join(" | ");

    for (const [columnIndex, label] of periods.entries()) {
      const cell = row[columnIndex + 1];
      const parsed = parseNumericCell(cell);
      if (!parsed) continue;
      const period = parsePeriodLabel(label, fye, input.dataCutoff);
      if (!period) continue;

      const isPercent = metric.kind === "percent" || parsed.percent;
      const isPerShare = metric.kind === "per_share";
      const scale = isPercent || isPerShare ? 1 : unitContext.scale;
      const refs =
        parsed.refs.length > 0
          ? parsed.refs
          : rowRefs.length > 0
            ? rowRefs
            : chapterRefs;
      const base =
        parsed.refs.length > 0
          ? 0.95
          : rowRefs.length > 0
            ? 0.85
            : chapterRefs.length > 0
              ? 0.8
              : unitContext.inferred
                ? 0.6
                : 0.7;
      const confidence = clamp(
        Math.min(base, period.confidence + 0.05) * (parsed.computed ? 0.8 : 1),
      );

      const scaledValue = isPercent || isPerShare
        ? Math.round(parsed.value * 1e6) / 1e6
        : Math.round(parsed.value * scale * 100) / 100;

      drafts.push({
        id: financialFactId({
          companyId: input.companyId,
          statement: metric.statement,
          item: metric.item,
          periodEnd: period.periodEnd,
          periodKind: period.kind,
        }),
        companyId: input.companyId,
        statement: metric.statement,
        item: metric.item,
        periodKind: period.kind,
        periodLabel: period.label,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        fiscalYear: period.fiscalYear,
        fiscalQuarter: period.fiscalQuarter,
        value: scaledValue,
        unit: isPercent ? "percent" : "currency",
        currency: isPercent ? undefined : unitContext.currency,
        quote,
        method: "deterministic_table_v1",
        confidence,
        sourceRefs: refs,
        sourceRef: refs[0],
      });
    }
  }

  return drafts;
}

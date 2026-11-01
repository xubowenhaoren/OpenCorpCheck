import type { Market, PeriodKind } from "@occ/core";

import type { F10Table } from "../relations/f10.js";
import {
  addDays,
  capFinancialFacts,
  computeDerivedFacts,
  daysBetween,
  financialItemSpecs,
  fiscalQuarterFor,
  fiscalYearFor,
  normalizeDate,
  normalizeFinancialLabel,
  normalizeMonthDay,
  parseF10Number,
  periodKindFromDuration,
  type CanonicalFinancialFact,
  type CanonicalStatement,
  type ItemSpec,
} from "./canonical.js";

/** Minimal shape of one scraped F10 page (see `F10Page`). */
export interface F10FinancialPage {
  page?: string;
  label?: string;
  url: string;
  tables: F10Table[];
  meta?: { fetched_at?: string };
}

export interface F10FinancialParseResult {
  facts: CanonicalFinancialFact[];
  currency: string;
  periods: number;
  tables: number;
  warnings: string[];
}

const MARKET_CURRENCY: Record<Market, string> = {
  A: "CNY",
  HK: "HKD",
  US: "USD",
};

const CURRENCY_WORDS: Array<[RegExp, string]> = [
  [/美元|USD/i, "USD"],
  [/港元|港币|HKD/i, "HKD"],
  [/人民币|CNY|RMB/i, "CNY"],
  [/欧元|EUR/i, "EUR"],
  [/日元|JPY/i, "JPY"],
  [/英镑|GBP/i, "GBP"],
];

interface Column {
  index: number;
  end: string;
  start: string;
  kind: PeriodKind;
  label: string;
  fiscalYear?: number;
  fiscalQuarter?: number;
  currency: string;
}

interface MetaRows {
  start?: string[];
  end?: string[];
  type?: string[];
  yearEnd?: string[];
  currency?: string[];
}

/**
 * Parse an Eastmoney F10 financial-statement page (`cwfx` for A/US,
 * `NewFinancialAnalysis` for HK) into canonical facts.
 *
 * A-share pages split a table's sticky header and its body into two DOM
 * tables, so `coalesceF10Tables` reattaches the header before parsing.
 */
export function parseF10Financials(input: {
  page: F10FinancialPage;
  market: Market;
}): F10FinancialParseResult {
  const warnings: string[] = [];
  const tables = coalesceF10Tables(input.page.tables).filter(isDataTable);
  if (tables.length === 0) {
    return {
      facts: [],
      currency: MARKET_CURRENCY[input.market],
      periods: 0,
      tables: 0,
      warnings: ["no financial tables rendered"],
    };
  }

  const candidates = tables
    .map((table) => ({ table, statement: classifyTable(table, input.market) }))
    .filter(
      (entry): entry is { table: F10Table; statement: CanonicalStatement } =>
        entry.statement !== null,
    )
    .sort(
      (a, b) =>
        scoreTable(b.table, input.market, b.statement) -
          scoreTable(a.table, input.market, a.statement) ||
        b.table.rows.length - a.table.rows.length,
    );

  const facts = new Map<string, CanonicalFinancialFact>();
  const periodKeys = new Set<string>();
  let currency = MARKET_CURRENCY[input.market];

  for (const { table, statement } of candidates) {
    const columns = buildColumns(table, input.market, input.page.meta?.fetched_at);
    if (columns.length === 0) continue;
    for (const column of columns) {
      periodKeys.add(`${column.end}|${column.kind}`);
      currency = column.currency || currency;
    }
    const parsed = parseStatementTable({
      table,
      statement,
      columns,
      market: input.market,
      sourceUrl: input.page.url,
      sourceTitle: `东方财富 F10 ${input.page.label ?? input.page.page ?? "财务分析"}`,
    });
    for (const fact of parsed) {
      const key = `${fact.statement}|${fact.item}|${fact.periodEnd}|${fact.periodKind}`;
      if (!facts.has(key)) facts.set(key, fact);
    }
  }

  const direct = [...facts.values()];
  const derived = computeDerivedFacts(direct, {
    url: input.page.url,
    title: `东方财富 F10 ${input.page.label ?? input.page.page ?? "财务分析"}`,
  });
  const capped = capFinancialFacts([...direct, ...derived]);
  if (capped.length === 0) {
    warnings.push("financial tables had no canonical values");
  }

  return {
    facts: capped.sort(
      (a, b) =>
        a.periodEnd.localeCompare(b.periodEnd) ||
        a.statement.localeCompare(b.statement) ||
        a.item.localeCompare(b.item),
    ),
    currency,
    periods: periodKeys.size,
    tables: candidates.length,
    warnings,
  };
}

/** Reattach a sticky header table to the following body table (A-share DOM). */
export function coalesceF10Tables(tables: F10Table[]): F10Table[] {
  const output: F10Table[] = [];
  let pendingHeader: string[] | null = null;
  for (const table of tables) {
    const headers = table.headers ?? [];
    const hasDate = headers.some((value) => normalizeDate(value) !== null);
    const emptyBody = table.rows.every((row) =>
      row.every((cell) => !cell || !cell.trim()),
    );
    if (hasDate && emptyBody) {
      pendingHeader = headers;
      continue;
    }
    if (!hasDate && pendingHeader) {
      output.push({ ...table, headers: pendingHeader });
      pendingHeader = null;
      continue;
    }
    output.push(table);
  }
  return output;
}

function isDataTable(table: F10Table): boolean {
  if (table.rows.length === 0) return false;
  // The percentage-statement table repeats `数值 | 占比` columns and cannot be
  // aligned to one period per header; skip it rather than mis-scale values.
  const percentageLayout = table.rows.some((row) =>
    row.slice(1).some((cell) => /^(数值|占比)$/.test((cell ?? "").trim())),
  );
  return !percentageLayout;
}

function classifyTable(
  table: F10Table,
  market: Market,
): CanonicalStatement | null {
  let best: { statement: CanonicalStatement; score: number } | null = null;
  for (const statement of ["income", "balance", "cash_flow"] as const) {
    const score = scoreTable(table, market, statement);
    if (score > 0 && (!best || score > best.score)) {
      best = { statement, score };
    }
  }
  return best?.statement ?? null;
}

function scoreTable(
  table: F10Table,
  market: Market,
  statement: CanonicalStatement,
): number {
  const labels = new Set(
    table.rows.map((row) => normalizeFinancialLabel(row[0] ?? "")),
  );
  return financialItemSpecs(market)
    .filter((spec) => spec.statement === statement)
    .filter((spec) => specMatchesLabelSet(spec, labels))
    .length;
}

function specMatchesLabelSet(spec: ItemSpec, labels: Set<string>): boolean {
  const candidates = [...(spec.labels ?? []), ...(spec.sum ?? [])].map(
    normalizeFinancialLabel,
  );
  return candidates.some((label) => labels.has(label));
}

function rowLabel(row: string[] | undefined): string {
  return normalizeFinancialLabel(row?.[0] ?? "");
}

function findRow(table: F10Table, label: string): string[] | undefined {
  const normalized = normalizeFinancialLabel(label);
  return table.rows.find((row) => rowLabel(row) === normalized);
}

function cell(row: string[] | undefined, index: number): string | undefined {
  return row?.[index];
}

function buildColumns(
  table: F10Table,
  market: Market,
  fetchedAt: string | undefined,
): Column[] {
  const meta: MetaRows = {
    ...(findRow(table, "报表起始日") ? { start: findRow(table, "报表起始日")! } : {}),
    ...(findRow(table, "报表截止日") ? { end: findRow(table, "报表截止日")! } : {}),
    ...(findRow(table, "财报类型") ? { type: findRow(table, "财报类型")! } : {}),
    ...(findRow(table, "年结日") ? { yearEnd: findRow(table, "年结日")! } : {}),
    ...(findRow(table, "币种") ? { currency: findRow(table, "币种")! } : {}),
  };
  const fallbackDate =
    normalizeDate(meta.end?.[1]) ??
    (fetchedAt && /^\d{4}-\d{2}-\d{2}/.test(fetchedAt)
      ? fetchedAt.slice(0, 10)
      : null);
  // HK income/cash-flow tables repeat the *start* date in their sticky header;
  // the matching end date sits in the `报表截止日` body row.
  const headerIsStart =
    normalizeFinancialLabel(table.headers[0] ?? "") === "报表起始日";

  const columns: Column[] = [];
  for (let index = 1; index < table.headers.length; index += 1) {
    const headerDate = normalizeDate(table.headers[index]);
    const end = headerIsStart
      ? (normalizeDate(cell(meta.end, index)) ?? fallbackDate ?? headerDate)
      : (headerDate ?? fallbackDate);
    if (!end) continue;
    const start = normalizeDate(cell(meta.start, index));
    const type = cell(meta.type, index)?.trim();
    const yearEnd = normalizeMonthDay(cell(meta.yearEnd, index));
    const currency =
      currencyFromText(cell(meta.currency, index)) ?? MARKET_CURRENCY[market];
    const period = buildPeriod({
      market,
      end,
      ...(start ? { start } : {}),
      ...(type ? { type } : {}),
      ...(yearEnd ? { yearEnd } : {}),
    });
    if (!period) continue;
    columns.push({
      index,
      end,
      start:
        start ??
        derivedPeriodStart(end, period.kind, period.fiscalQuarter),
      kind: period.kind,
      label: period.label,
      ...(period.fiscalYear !== undefined
        ? { fiscalYear: period.fiscalYear }
        : {}),
      ...(period.fiscalQuarter !== undefined
        ? { fiscalQuarter: period.fiscalQuarter }
        : {}),
      currency,
    });
  }
  return columns;
}

function currencyFromText(raw: string | undefined): string | null {
  if (!raw) return null;
  for (const [pattern, code] of CURRENCY_WORDS) {
    if (pattern.test(raw)) return code;
  }
  return null;
}

function buildPeriod(input: {
  market: Market;
  end: string;
  start?: string;
  type?: string;
  yearEnd?: { month: number; day: number };
}): {
  kind: PeriodKind;
  label: string;
  fiscalYear?: number;
  fiscalQuarter?: number;
} | null {
  const yearEnd = input.yearEnd ?? { month: 12, day: 31 };
  const fiscalYear = fiscalYearFor(input.end, yearEnd);
  const start = input.start;

  if (input.market === "US" && input.type) {
    if (/年报|年度/.test(input.type)) {
      return { kind: "annual", label: `FY${fiscalYear}`, fiscalYear };
    }
    if (/一季|一季度/.test(input.type)) {
      return {
        kind: "quarter",
        label: `${fiscalYear}Q1`,
        fiscalYear,
        fiscalQuarter: 1,
      };
    }
    if (/中报|半年/.test(input.type)) {
      return {
        kind: "half",
        label: `${fiscalYear}H1`,
        fiscalYear,
        fiscalQuarter: 2,
      };
    }
    if (/三季|三季度/.test(input.type)) {
      return {
        kind: "quarter",
        label: `${fiscalYear}Q3`,
        fiscalYear,
        fiscalQuarter: 3,
      };
    }
  }

  if (start) {
    const duration = periodKindFromDuration(daysBetween(start, input.end));
    if (duration) {
      const quarter = fiscalQuarterFor(start, input.end);
      return {
        kind: duration.kind,
        label:
          duration.kind === "annual"
            ? `FY${fiscalYear}`
            : duration.kind === "half"
              ? `${fiscalYear}H1`
              : `${fiscalYear}Q${quarter}`,
        fiscalYear,
        ...(duration.kind === "quarter" || duration.kind === "half"
          ? { fiscalQuarter: quarter }
          : {}),
      };
    }
  }

  // Month-based fallback for pages without a report-type or start row
  // (A-share statement headers, HK balance sheets). Classify relative to the
  // fiscal year so a March/June year-end is not forced into a calendar quarter.
  const anniversary = `${input.end.slice(0, 4)}-${String(yearEnd.month).padStart(2, "0")}-${String(yearEnd.day).padStart(2, "0")}`;
  const anniversaryOffset =
    Math.abs(
      Date.parse(`${input.end}T00:00:00Z`) -
        Date.parse(`${anniversary}T00:00:00Z`),
    ) / 86_400_000;
  if (anniversaryOffset <= 7) {
    return { kind: "annual", label: `FY${fiscalYear}`, fiscalYear };
  }
  const yearStart = addDays(
    `${fiscalYear - 1}-${String(yearEnd.month).padStart(2, "0")}-${String(yearEnd.day).padStart(2, "0")}`,
    1,
  );
  const quarter = fiscalQuarterFor(yearStart, input.end);
  if (quarter === 4) {
    return { kind: "annual", label: `FY${fiscalYear}`, fiscalYear };
  }
  if (quarter === 2) {
    return {
      kind: "half",
      label: `${fiscalYear}H1`,
      fiscalYear,
      fiscalQuarter: 2,
    };
  }
  return {
    kind: "quarter",
    label: `${fiscalYear}Q${quarter}`,
    fiscalYear,
    fiscalQuarter: quarter,
  };
}

function parseStatementTable(input: {
  table: F10Table;
  statement: CanonicalStatement;
  columns: Column[];
  market: Market;
  sourceUrl: string;
  sourceTitle: string;
}): CanonicalFinancialFact[] {
  const facts: CanonicalFinancialFact[] = [];
  const specs = financialItemSpecs(input.market).filter(
    (spec) => spec.statement === input.statement,
  );

  for (const spec of specs) {
    const selection = selectRows(input.table, spec);
    if (!selection) continue;

    for (const column of input.columns) {
      const numeric: Array<{ label: string; raw: string; value: number }> = [];
      for (const row of selection.rows) {
        const raw = cell(row, column.index);
        const parsed = parseF10Number(raw);
        if (!parsed) continue;
        numeric.push({ label: (row[0] ?? "").trim(), raw: raw!, value: parsed.value });
      }
      if (numeric.length === 0) continue;

      const value = selection.sum
        ? numeric.reduce((sum, entry) => sum + entry.value, 0)
        : numeric[0]!.value;
      const finalValue = spec.abs ? Math.abs(value) : value;
      const quoted = selection.sum ? numeric : [numeric[0]!];
      const quote = quoted
        .map((entry) => `${entry.label}: ${entry.raw}`)
        .join(" + ")
        .slice(0, 1_000);

      facts.push({
        statement: spec.statement,
        item: spec.item,
        periodKind: column.kind,
        periodLabel: column.label,
        ...(column.start ? { periodStart: column.start } : {}),
        periodEnd: column.end,
        ...(column.fiscalYear !== undefined
          ? { fiscalYear: column.fiscalYear }
          : {}),
        ...(column.fiscalQuarter !== undefined
          ? { fiscalQuarter: column.fiscalQuarter }
          : {}),
        value: finalValue,
        unit: spec.unit,
        ...(spec.unit === "currency" || spec.unit === "currency_per_share"
          ? { currency: column.currency }
          : {}),
        quote,
        confidence: 0.95,
        sourceUrl: input.sourceUrl,
        sourceTitle: input.sourceTitle,
      });
    }
  }
  return facts;
}

function selectRows(
  table: F10Table,
  spec: ItemSpec,
): { rows: string[][]; sum: boolean } | null {
  if (spec.sum && spec.sum.length > 0) {
    const wanted = new Set(spec.sum.map(normalizeFinancialLabel));
    const rows = table.rows.filter((row) => wanted.has(rowLabel(row)));
    if (rows.length > 0 && hasAnyValue(rows)) {
      return { rows, sum: true };
    }
  }
  for (const label of spec.labels ?? []) {
    const normalized = normalizeFinancialLabel(label);
    const rows = table.rows.filter((row) => rowLabel(row) === normalized);
    if (rows.length > 0 && hasAnyValue(rows)) {
      return { rows, sum: false };
    }
  }
  if (spec.match) {
    const rows = table.rows.filter((row) => {
      const label = rowLabel(row);
      if (!spec.match!.include.test(label)) return false;
      if (spec.match!.exclude?.test(label)) return false;
      return true;
    });
    if (rows.length > 0 && hasAnyValue(rows)) {
      return { rows, sum: Boolean(spec.sumMatched) };
    }
  }
  return null;
}

function hasAnyValue(rows: string[][]): boolean {
  return rows.some((row) =>
    row.slice(1).some((value) => parseF10Number(value) !== null),
  );
}

/** Fiscal-year start (or 90-day window) when the page omits a start row. */
export function derivedPeriodStart(
  end: string,
  kind: PeriodKind,
  fiscalQuarter?: number,
): string {
  if (kind === "annual") return addDays(end, -364);
  if (kind === "half") return addDays(end, -181);
  if (fiscalQuarter === 3) return addDays(end, -273);
  return addDays(end, -90);
}

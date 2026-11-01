import type { Market, PeriodKind } from "@occ/core";

/**
 * Canonical financial-statement model shared by the F10 `cwfx` parser and the
 * SEC EDGAR XBRL parser.
 *
 * One fact is one `(statement, item, period)` cell in native currency units.
 * Values are never scaled to millions; `unit`/`currency` carry the meaning.
 */

export type CanonicalStatement = "income" | "balance" | "cash_flow";
export type CanonicalUnit = "currency" | "percent" | "currency_per_share";

export interface CanonicalFinancialFact {
  statement: CanonicalStatement;
  item: string;
  periodKind: PeriodKind;
  periodLabel: string;
  periodStart?: string;
  periodEnd: string;
  fiscalYear?: number;
  fiscalQuarter?: number;
  value: number;
  unit: CanonicalUnit;
  currency?: string;
  quote: string;
  confidence: number;
  /** Filing / F10 page this cell came from. */
  sourceUrl?: string;
  sourceTitle?: string;
}

export interface SourcedFinancialFact extends CanonicalFinancialFact {
  /** `xbrl` (SEC filing), `f10` (Eastmoney), or a legacy profile method. */
  method: string;
}

export interface ItemSpec {
  statement: CanonicalStatement;
  item: string;
  /** Exact labels; the first label present in a table wins. */
  labels?: string[];
  /** Rows to sum into one value (e.g. current + non-current debt). */
  sum?: string[];
  unit: CanonicalUnit;
  /** Store the magnitude (capex is reported as a negative cash outflow). */
  abs?: boolean;
  /**
   * Fallback label matcher for tables that use a one-off wording (common in HK
   * cash-flow tables). Exact labels win first; this runs only when none match.
   */
  match?: { include: RegExp; exclude?: RegExp };
  /** Sum every matching row (capex components) instead of taking the first. */
  sumMatched?: boolean;
}

const CURRENCY: CanonicalUnit = "currency";
const PERCENT: CanonicalUnit = "percent";
const PER_SHARE: CanonicalUnit = "currency_per_share";

/**
 * Market-specific label maps for the ~20 canonical items in the v1 scope.
 *
 * F10 tables mix simplified and traditional Chinese and use different line
 * names per market (e.g. HK `营业额`, US `营业收入`), so the same item has a
 * small ordered list of accepted labels.
 */
export function financialItemSpecs(market: Market): ItemSpec[] {
  const revenueLabels =
    market === "HK"
      ? [
          "营业额",
          "营业总收入",
          "总收入",
          "营业收入",
          "营运收入合计",
          "营运收入",
          "主营收入",
          "收入",
        ]
      : ["营业总收入", "营业收入", "主营收入", "收入"];

  const sga: ItemSpec =
    market === "A"
      ? {
          statement: "income",
          item: "selling_general_admin",
          sum: ["销售费用", "管理费用"],
          labels: ["销售及管理费用"],
          unit: CURRENCY,
        }
      : market === "HK"
        ? {
            statement: "income",
            item: "selling_general_admin",
            sum: [
              "销售及市场推广开支",
              "销售及市场推广费用",
              "一般及行政开支",
              "一般及行政费",
              "一般及行政费用",
              "销售费用",
              "市场推广开支",
            ],
            labels: ["销售及管理费用"],
            unit: CURRENCY,
          }
        : {
            statement: "income",
            item: "selling_general_admin",
            labels: ["营销费用", "销售及管理费用", "销售和营销费用"],
            unit: CURRENCY,
          };

  const capex: ItemSpec =
    market === "A"
      ? {
          statement: "cash_flow",
          item: "capex",
          labels: ["购建固定资产、无形资产和其他长期资产支付的现金"],
          unit: CURRENCY,
          abs: true,
        }
      : market === "HK"
        ? {
            statement: "cash_flow",
            item: "capex",
            sum: [
              "购买物业、设备及器材、在建工程与投资物业的付款╱预付款项",
              "购买物业、设备及器材、在建工程与投资物业的付款/预付款项",
              "购买物业、设备及器材、在建工程与投资物业的付款／预付款项",
              "购建无形资产及其他资产",
              "购买物业、厂房和设备,无形资产,勘探及评估资产,在建工程和其他非流动资产支付的款项",
              "购买物业、厂房和设备，无形资产，勘探及评估资产，在建工程和其他非流动资产支付的款项",
              "购置固定资产、其他无形资产等非流动资产所付款项",
              "购买物业、厂房及设备",
              "购置物业、厂房及设备",
              "购置固定资产",
            ],
            labels: ["购买物业、设备及器材"],
            unit: CURRENCY,
            abs: true,
            match: {
              include: /^(购置|购买|购建)(?=.*(物业|厂房|固定资产|设备|器材|机器))/,
              exclude: /(收购|附属|子公司|按金)/,
            },
            sumMatched: true,
          }
        : {
            statement: "cash_flow",
            item: "capex",
            sum: ["购买固定资产", "购建无形资产及其他资产"],
            labels: ["购买固定资产"],
            unit: CURRENCY,
            abs: true,
          };

  const totalDebt: ItemSpec =
    market === "A"
      ? {
          statement: "balance",
          item: "total_debt",
          sum: [
            "短期借款",
            "一年内到期的非流动负债",
            "长期借款",
            "应付债券",
            "租赁负债",
          ],
          unit: CURRENCY,
        }
      : market === "HK"
        ? {
            statement: "balance",
            item: "total_debt",
            sum: [
              "借款",
              "租赁负债",
              "债券",
              "应付债券",
              "一年内到期的债券",
              "短期借款",
              "长期借款",
              "银行及其他借款",
              "银行借款",
              "其他借款",
            ],
            unit: CURRENCY,
          }
        : {
            statement: "balance",
            item: "total_debt",
            sum: ["短期债务", "长期负债"],
            unit: CURRENCY,
          };

  return [
    // Income statement
    {
      statement: "income",
      item: "revenue",
      labels: revenueLabels,
      unit: CURRENCY,
    },
    {
      statement: "income",
      item: "cost_of_revenue",
      labels: ["营业成本", "主营成本", "收入成本", "经营成本", "营业成本合计"],
      unit: CURRENCY,
    },
    {
      statement: "income",
      item: "gross_profit",
      labels: ["毛利", "毛利润"],
      unit: CURRENCY,
    },
    {
      statement: "income",
      item: "gross_margin",
      labels: ["毛利率", "销售毛利率"],
      unit: PERCENT,
    },
    {
      statement: "income",
      item: "research_and_development",
      labels: ["研发费用", "研发开支", "研究及开发费用"],
      unit: CURRENCY,
    },
    sga,
    {
      statement: "income",
      item: "operating_income",
      labels: ["营业利润", "经营盈利", "经营溢利", "经营利润", "营运利润"],
      unit: CURRENCY,
    },
    {
      statement: "income",
      item: "net_income",
      labels: [
        "净利润",
        "除税后溢利:盈利",
        "除税后溢利盈利",
        "除税后溢利:利潤",
        "除税后溢利利潤",
        "除税后溢利:利润",
        "除税后溢利利润",
        "除税后溢利:本年利潤",
        "除税后溢利本年利潤",
        "除税后溢利:本年利润",
        "除税后溢利本年利润",
        "持续经营业务税后利润",
        "持续经营净利润",
      ],
      unit: CURRENCY,
    },
    {
      statement: "income",
      item: "net_income_attributable",
      labels: [
        "归属于母公司股东的净利润",
        "归属于普通股股东净利润",
        "归属于母公司股东净利润",
        "除税后溢利:本公司權益持有人",
        "除税后溢利本公司權益持有人",
        "除税后溢利:公司普通股股東",
        "除税后溢利公司普通股股東",
        "除税后溢利:公司普通股股东",
        "除税后溢利公司普通股股东",
        "除税后溢利:本公司所有者",
        "除税后溢利本公司所有者",
        "除税后溢利:本公司所有者應佔",
        "除税后溢利本公司所有者應佔",
        "除税后溢利:本公司股東",
        "除税后溢利本公司股東",
        "除税后溢利:本公司股东",
        "除税后溢利本公司股东",
        "本公司权益持有人应占溢利",
        "归属净利润",
        "归母净利润",
      ],
      unit: CURRENCY,
    },
    {
      statement: "income",
      item: "eps_diluted",
      labels: [
        "摊薄每股收益-普通股",
        "稀释每股收益-普通股",
        "摊薄每股收益",
        "稀释每股收益",
        "稀释每股收益(元)",
        "每股摊薄盈利",
        "每股摊薄收益",
        "每股盈利-摊薄",
        "每股盈利摊薄",
        "摊薄后每股盈利",
        "摊薄",
        "稀释",
      ],
      unit: PER_SHARE,
    },

    // Balance sheet
    {
      statement: "balance",
      item: "cash_and_equivalents",
      labels: [
        "货币资金",
        "现金及现金等价物",
        "现金及银行结余",
        "现金及于中央银行之结余",
        "银行结余及现金",
        "现金及等同现金项目",
        "现金及等同现金",
        "现金及银行存款",
        "库存现金",
      ],
      unit: CURRENCY,
    },
    {
      statement: "balance",
      item: "total_assets",
      labels: [
        "资产总计",
        "资产总额",
        "资产总值",
        "资产合计",
        "总资产",
        "负债和股东权益总计",
        "负债及股东权益总计",
      ],
      unit: CURRENCY,
    },
    {
      statement: "balance",
      item: "total_liabilities",
      labels: ["负债合计", "负债总额", "负债总计", "总负债"],
      unit: CURRENCY,
    },
    {
      statement: "balance",
      item: "total_equity",
      labels: [
        "股东权益合计",
        "股东权益总额",
        "权益总额",
        "权益合计",
        "本公司股东应占权益",
        "归属于本公司所有者的权益",
        "归属于母公司所有者的权益",
        "净资产",
        "所有者权益合计",
        "总权益",
        "本公司权益持有人应占权益",
      ],
      unit: CURRENCY,
    },
    totalDebt,

    // Cash flow
    {
      statement: "cash_flow",
      item: "operating_cash_flow",
      labels: [
        "经营活动产生的现金流量净额",
        "经营活动所得现金流量净额",
        "经营活动现金流量净额",
        "经营活动现金净流入",
        "经营活动现金净流出",
        "经营活动所得现金净额",
        "经营业务现金净额",
        "经营业务现金流入净额",
        "经营活动流入的现金净额",
        "营业活动产生之现金净额",
        "来自经营业务之现金净额",
        "经营业务所得现金净额",
      ],
      unit: CURRENCY,
      match: {
        include: /^(经营活动|经营业务|营业活动)(?=.*现金)(?=.*(净额|净流入|净流出))/,
        exclude: /(税前|其他项目|平衡项目|小计)/,
      },
    },
    capex,
    {
      statement: "cash_flow",
      item: "investing_cash_flow",
      labels: [
        "投资活动产生的现金流量净额",
        "投资活动耗用现金流量净额",
        "投资活动现金流量净额",
        "投资活动现金净流出",
        "投资活动现金净流入",
        "投资活动所得现金净额",
        "投资活动所用现金净额",
        "投资业务现金流出净额",
        "投资业务现金流入净额",
        "投资活动流出的现金净额",
        "用于投资业务之现金净额",
      ],
      unit: CURRENCY,
      match: {
        include: /^(投资活动|投资业务|来自投资活动)(?=.*现金)(?=.*(净额|净流入|净流出))/,
        exclude: /(其他|小计|融资前)/,
      },
    },
    {
      statement: "cash_flow",
      item: "financing_cash_flow",
      labels: [
        "筹资活动产生的现金流量净额",
        "融资活动耗用现金流量净额",
        "筹资活动现金流量净额",
        "融资活动现金净流出",
        "融资活动现金净流入",
        "融资活动所得现金净额",
        "融资活动所用现金净额",
        "融资业务现金流出净额",
        "融资业务现金流入净额",
        "融资活动流出的现金净额",
        "用于融资活动之现金净额",
      ],
      unit: CURRENCY,
      match: {
        include: /^(融资活动|融资业务|筹资活动|用于融资)(?=.*现金)(?=.*(净额|净流入|净流出))/,
        exclude: /(融资前|融资业务前|小计|其他)/,
      },
    },
  ];
}

/** Normalize a row label: drop spaces, footnote markers and `(元)/(%)` suffixes. */
export function normalizeFinancialLabel(raw: string): string {
  return raw
    .replace(/[\s　]+/g, "")
    .replace(/[*＊]/g, "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/^其中[:：]?/, "")
    .replace(/^[一二三四五六七八九十]+、/, "")
    .replace(/[:：]/g, "")
    .trim();
}

export interface ParsedNumber {
  value: number;
  percent: boolean;
}

const MISSING_VALUE = /^(--|—|–|-|n\/?a|不适用|null|无)$/i;

/**
 * Parse a F10 numeric cell such as `499.3亿`, `9800万`, `2.159万亿`,
 * `-620.9亿`, `51.53`, `49.07%`, `--`.
 *
 * Chinese magnitude suffixes are expanded to native units; values without a
 * suffix are kept as-is (per-share and percentage cells are usually bare).
 */
export function parseF10Number(raw: string | undefined): ParsedNumber | null {
  if (raw === undefined) return null;
  let text = raw
    .replace(/[\s　]+/g, "")
    .replace(/[,，]/g, "")
    .replace(/[%％]/g, "")
    .trim();
  if (!text || MISSING_VALUE.test(text)) return null;

  const percent = /[%％]/.test(raw);
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.startsWith("-") || text.startsWith("−")) {
    negative = true;
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    text = text.slice(1);
  }

  let multiplier = 1;
  const units: Array<[RegExp, number]> = [
    [/万亿/, 1e12],
    [/千亿/, 1e11],
    [/百亿/, 1e10],
    [/十亿/, 1e9],
    [/亿/, 1e8],
    [/百万/, 1e6],
    [/万/, 1e4],
    [/千/, 1e3],
  ];
  for (const [pattern, factor] of units) {
    if (pattern.test(text)) {
      multiplier = factor;
      text = text.replace(pattern, "");
      break;
    }
  }
  // Drop trailing currency / unit words, e.g. `1.2亿港元`, `12元`.
  text = text.replace(/(人民币|港元|港币|美元|欧元|日元|英镑|美元|元|股|次|倍|天)/g, "");
  if (!/^[-+]?\d+(?:\.\d+)?$/.test(text)) return null;
  const numeric = Number.parseFloat(text);
  if (!Number.isFinite(numeric)) return null;
  const scaled = (negative ? -numeric : numeric) * multiplier;
  return {
    // Keep cell arithmetic stable (e.g. 4161.61亿 must not become
    // 416160999999.99994); two decimals is well below a yuan cent.
    value: Math.round(scaled * 100) / 100,
    percent,
  };
}

export function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Accept `2026-06-27`, `26-06-27`, `2026/06/27`, `20260627` and `9-26`. */
export function normalizeDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const text = raw.trim().replace(/\//g, "-").replace(/\./g, "-");
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (match) {
    return isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  match = /^(\d{2})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (match) {
    return isoDate(2000 + Number(match[1]), Number(match[2]), Number(match[3]));
  }
  match = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (match) {
    return isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  return null;
}

/** `9-26` / `12-31` fiscal year-end (month, day) without a year. */
export function normalizeMonthDay(
  raw: string | undefined,
): { month: number; day: number } | null {
  if (!raw) return null;
  const match = /^(\d{1,2})[-/](\d{1,2})$/.exec(raw.trim());
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

export function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function daysBetween(start: string, end: string): number {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

/**
 * Fiscal year containing `end`, given a month/day fiscal year-end. A 52/53-week
 * filer can end a few days after the nominal anniversary; allow one week.
 */
export function fiscalYearFor(
  end: string,
  fiscalYearEnd: { month: number; day: number },
): number {
  const [year, month, day] = end.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const endUtc = Date.UTC(year, month - 1, day);
  const anniversary = Date.UTC(
    year,
    fiscalYearEnd.month - 1,
    fiscalYearEnd.day,
  );
  return endUtc <= anniversary + 7 * 86_400_000 ? year : year + 1;
}

/** Quarter number (1–4) for a period ending `end` inside a fiscal year that
 * starts at `start`. Uses complete months so 52/53-week ends classify right. */
export function fiscalQuarterFor(
  start: string,
  end: string,
): number {
  const [sy, sm, sd] = start.split("-").map(Number) as [number, number, number];
  const [ey, em, ed] = end.split("-").map(Number) as [number, number, number];
  const months = (ey - sy) * 12 + (em - sm) + (ed >= sd ? 0 : -1);
  return Math.min(4, Math.max(1, Math.ceil(months / 3)));
}

/** Classify a reported duration; unknown ranges are dropped. */
export function periodKindFromDuration(
  days: number,
): { kind: PeriodKind; fiscalQuarter?: number } | null {
  if (days >= 340 && days <= 385) return { kind: "annual" };
  if (days >= 245 && days <= 290) return { kind: "quarter", fiscalQuarter: 3 };
  if (days >= 150 && days <= 200) return { kind: "half", fiscalQuarter: 2 };
  if (days >= 70 && days <= 110) return { kind: "quarter", fiscalQuarter: 1 };
  return null;
}

export interface ComparisonStats {
  compared: number;
  differing: number;
  maxDiffPct: number;
  samples: Array<{
    item: string;
    periodEnd: string;
    periodKind: string;
    higher: string;
    lower: string;
    higherValue: number;
    lowerValue: number;
    diffPct: number;
  }>;
}

/**
 * Merge facts from several sources. `order` lists methods from highest to
 * lowest precedence (e.g. `["xbrl", "f10"]`). The first source that reports a
 * key wins; lower-precedence values are only compared for logging.
 */
export function mergeFinancialSources(
  sources: Array<{ method: string; facts: CanonicalFinancialFact[] }>,
  order: string[],
): { facts: SourcedFinancialFact[]; comparison: ComparisonStats } {
  const rank = new Map(order.map((method, index) => [method, index]));
  const winners = new Map<string, SourcedFinancialFact>();
  const comparison: ComparisonStats = {
    compared: 0,
    differing: 0,
    maxDiffPct: 0,
    samples: [],
  };

  for (const source of sources) {
    for (const fact of source.facts) {
      const key = factKey(fact);
      const existing = winners.get(key);
      if (!existing) {
        winners.set(key, { ...fact, method: source.method });
        continue;
      }
      const existingRank = rank.get(existing.method) ?? 99;
      const incomingRank = rank.get(source.method) ?? 99;
      // F10 reports cumulative YTD columns while EDGAR can report a true
      // single quarter for the same period end. Comparing those is noise; a
      // 52/53-week filer can also shift a period start by a few days, and a
      // US-listed foreign issuer may be converted to USD by F10.
      const sameCurrency =
        !existing.currency ||
        !fact.currency ||
        existing.currency === fact.currency;
      if (sameCurrency && samePeriodWindow(existing.periodStart, fact.periodStart)) {
        const diff = relativeDiff(existing.value, fact.value);
        comparison.compared += 1;
        if (diff > 0.01) {
          comparison.differing += 1;
          comparison.maxDiffPct = Math.max(
            comparison.maxDiffPct,
            Math.round(diff * 10_000) / 100,
          );
          if (comparison.samples.length < 8) {
            comparison.samples.push({
              item: fact.item,
              periodEnd: fact.periodEnd,
              periodKind: fact.periodKind,
              higher: existing.method,
              lower: source.method,
              higherValue: existing.value,
              lowerValue: fact.value,
              diffPct: Math.round(diff * 10_000) / 100,
            });
          }
        }
      }
      if (incomingRank < existingRank) {
        winners.set(key, { ...fact, method: source.method });
      }
    }
  }

  return { facts: [...winners.values()], comparison };
}

export function factKey(fact: CanonicalFinancialFact): string {
  return `${fact.statement}|${fact.item}|${fact.periodEnd}|${fact.periodKind}`;
}

function relativeDiff(a: number, b: number): number {
  const denominator = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / denominator;
}

/** Both missing, equal, or within one week (52/53-week fiscal calendars). */
function samePeriodWindow(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a === b) return true;
  const start = Date.parse(`${a}T00:00:00Z`);
  const end = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  return Math.abs(start - end) <= 7 * 86_400_000;
}

/**
 * Derived cells the source does not report directly: gross profit, gross
 * margin, total liabilities and free cash flow.
 *
 * Every derived fact starts its quote with `计算：`; the UI uses that marker to
 * show a `推导` badge and must never present these as reported lines.
 */
export function computeDerivedFacts(
  facts: CanonicalFinancialFact[],
  source: { url?: string; title?: string },
): CanonicalFinancialFact[] {
  const byKey = new Map<string, CanonicalFinancialFact>();
  for (const fact of facts) {
    byKey.set(`${fact.item}|${fact.periodEnd}|${fact.periodKind}`, fact);
  }
  const derived: CanonicalFinancialFact[] = [];

  const emit = (input: {
    base: CanonicalFinancialFact;
    statement: CanonicalStatement;
    item: string;
    value: number;
    unit: CanonicalUnit;
    quote: string;
    confidence: number;
  }): void => {
    const { base } = input;
    const key = `${input.item}|${base.periodEnd}|${base.periodKind}`;
    if (byKey.has(key)) return;
    const entry: CanonicalFinancialFact = {
      statement: input.statement,
      item: input.item,
      periodKind: base.periodKind,
      periodLabel: base.periodLabel,
      ...(base.periodStart ? { periodStart: base.periodStart } : {}),
      periodEnd: base.periodEnd,
      ...(base.fiscalYear !== undefined ? { fiscalYear: base.fiscalYear } : {}),
      ...(base.fiscalQuarter !== undefined
        ? { fiscalQuarter: base.fiscalQuarter }
        : {}),
      value: input.value,
      unit: input.unit,
      ...(input.unit !== "percent" && base.currency
        ? { currency: base.currency }
        : {}),
      quote: input.quote,
      confidence: input.confidence,
      ...(base.sourceUrl ?? source.url
        ? { sourceUrl: base.sourceUrl ?? source.url }
        : {}),
      ...(base.sourceTitle ?? source.title
        ? { sourceTitle: base.sourceTitle ?? source.title }
        : {}),
    };
    byKey.set(key, entry);
    derived.push(entry);
  };

  // Gross profit, when both lines exist (many US GAAP filers never tag it).
  for (const fact of facts) {
    if (fact.item !== "revenue") continue;
    const cost = byKey.get(`cost_of_revenue|${fact.periodEnd}|${fact.periodKind}`);
    if (!cost) continue;
    const value = Math.round((fact.value - cost.value) * 100) / 100;
    if (!Number.isFinite(value)) continue;
    emit({
      base: fact,
      statement: "income",
      item: "gross_profit",
      value,
      unit: "currency",
      quote: `计算：营业收入 - 营业成本（${fact.value} - ${cost.value}）`,
      confidence: 0.85,
    });
  }

  // Gross margin from either a reported or a derived gross profit.
  for (const fact of byKey.values()) {
    if (fact.item !== "gross_profit") continue;
    const revenue = byKey.get(`revenue|${fact.periodEnd}|${fact.periodKind}`);
    if (!revenue || revenue.value === 0) continue;
    const margin = (fact.value / revenue.value) * 100;
    if (!Number.isFinite(margin)) continue;
    emit({
      base: fact,
      statement: "income",
      item: "gross_margin",
      value: Math.round(margin * 100) / 100,
      unit: "percent",
      quote: `计算：毛利润 ÷ 营业收入 × 100（${fact.value} ÷ ${revenue.value}）`,
      confidence: 0.9,
    });
  }

  // Total liabilities: assets - equity when the taxonomy omits the subtotal.
  for (const fact of facts) {
    if (fact.item !== "total_assets") continue;
    const equity = byKey.get(`total_equity|${fact.periodEnd}|${fact.periodKind}`);
    if (!equity) continue;
    const value = Math.round((fact.value - equity.value) * 100) / 100;
    if (!Number.isFinite(value)) continue;
    emit({
      base: fact,
      statement: "balance",
      item: "total_liabilities",
      value,
      unit: "currency",
      quote: `计算：总资产 - 股东权益（${fact.value} - ${equity.value}）`,
      confidence: 0.85,
    });
  }

  // Free cash flow from operating cash flow and capex.
  for (const fact of byKey.values()) {
    if (fact.item !== "operating_cash_flow") continue;
    const capex = byKey.get(`capex|${fact.periodEnd}|${fact.periodKind}`);
    if (!capex) continue;
    const value = Math.round((fact.value - Math.abs(capex.value)) * 100) / 100;
    emit({
      base: fact,
      statement: "cash_flow",
      item: "free_cash_flow",
      value,
      unit: "currency",
      quote: `计算：经营活动现金流净额 - 资本开支（${fact.value} - ${Math.abs(capex.value)}）`,
      confidence: 0.9,
    });
  }
  return derived;
}

/** Keep the latest N periods per item/kind; both parsers share this cap. */
export function capFinancialFacts(
  facts: CanonicalFinancialFact[],
  limits: { annual?: number; quarter?: number; half?: number } = {},
): CanonicalFinancialFact[] {
  const annual = limits.annual ?? 5;
  const quarter = limits.quarter ?? 8;
  const half = limits.half ?? 4;
  const grouped = new Map<string, CanonicalFinancialFact[]>();
  for (const fact of facts) {
    const key = `${fact.statement}|${fact.item}|${fact.periodKind}`;
    const list = grouped.get(key);
    if (list) list.push(fact);
    else grouped.set(key, [fact]);
  }
  const result: CanonicalFinancialFact[] = [];
  for (const list of grouped.values()) {
    list.sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
    const kind = list[0]?.periodKind;
    const limit =
      kind === "annual" ? annual : kind === "half" ? half : quarter;
    result.push(...list.slice(0, limit));
  }
  return result;
}

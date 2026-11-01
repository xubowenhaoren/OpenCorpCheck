import type {
  CompanyFactView,
  FinancialFactView,
  PeriodKind,
  RelationStatus,
  RelationType,
} from "@occ/core";

export type Lang = "zh" | "en";

const CURRENCY_LABEL: Record<string, { zh: string; en: string }> = {
  USD: { zh: "美元", en: "USD" },
  CNY: { zh: "元", en: "CNY" },
  HKD: { zh: "港元", en: "HKD" },
  EUR: { zh: "欧元", en: "EUR" },
  JPY: { zh: "日元", en: "JPY" },
  GBP: { zh: "英镑", en: "GBP" },
  KRW: { zh: "韩元", en: "KRW" },
};

const FIN_ITEM_LABEL: Record<string, { zh: string; en: string }> = {
  revenue: { zh: "营业收入", en: "Revenue" },
  cost_of_revenue: { zh: "营业成本", en: "Cost of revenue" },
  gross_profit: { zh: "毛利润", en: "Gross profit" },
  gross_margin: { zh: "毛利率", en: "Gross margin" },
  research_and_development: { zh: "研发费用", en: "R&D" },
  selling_general_admin: { zh: "销售及管理费用", en: "SG&A" },
  operating_income: { zh: "营业利润", en: "Operating income" },
  net_income: { zh: "净利润", en: "Net income" },
  net_income_attributable: { zh: "归母净利润", en: "Net income attributable" },
  eps: { zh: "每股收益", en: "EPS" },
  eps_diluted: { zh: "稀释每股收益", en: "Diluted EPS" },
  cash_and_equivalents: { zh: "货币资金", en: "Cash & equivalents" },
  total_assets: { zh: "总资产", en: "Total assets" },
  total_liabilities: { zh: "总负债", en: "Total liabilities" },
  total_equity: { zh: "股东权益", en: "Total equity" },
  total_debt: { zh: "总债务", en: "Total debt" },
  operating_cash_flow: { zh: "经营现金流", en: "Operating cash flow" },
  capex: { zh: "资本开支", en: "Capex" },
  free_cash_flow: { zh: "自由现金流", en: "Free cash flow" },
  investing_cash_flow: { zh: "投资现金流", en: "Investing cash flow" },
  financing_cash_flow: { zh: "筹资现金流", en: "Financing cash flow" },
};

export const FIN_ITEM_ORDER = [
  // Income statement
  "revenue",
  "cost_of_revenue",
  "gross_profit",
  "gross_margin",
  "research_and_development",
  "selling_general_admin",
  "operating_income",
  "net_income",
  "net_income_attributable",
  "eps_diluted",
  "eps",
  // Balance sheet
  "cash_and_equivalents",
  "total_assets",
  "total_liabilities",
  "total_equity",
  "total_debt",
  // Cash flow
  "operating_cash_flow",
  "capex",
  "free_cash_flow",
  "investing_cash_flow",
  "financing_cash_flow",
];

const STATEMENT_LABEL: Record<string, { zh: string; en: string }> = {
  income: { zh: "利润表", en: "Income statement" },
  cash_flow: { zh: "现金流量表", en: "Cash flow" },
  per_share: { zh: "每股指标", en: "Per share" },
  balance: { zh: "资产负债表", en: "Balance sheet" },
};

const RELATION_LABEL: Record<RelationType, { zh: string; en: string }> = {
  invests_in: { zh: "投资", en: "Invests in" },
  owns: { zh: "控股", en: "Owns" },
  parent_of: { zh: "母公司", en: "Parent of" },
  supplies: { zh: "供应", en: "Supplies" },
  buys_from: { zh: "采购", en: "Buys from" },
  competes_with: { zh: "竞争", en: "Competes with" },
  partners_with: { zh: "合作", en: "Partners with" },
  joint_venture_with: { zh: "合资", en: "Joint venture" },
  licenses_to: { zh: "授权", en: "Licenses to" },
  licenses_from: { zh: "被授权", en: "Licenses from" },
  other: { zh: "其他", en: "Other" },
};

export type RelationCategory =
  | "investment"
  | "supply"
  | "competition"
  | "partnership"
  | "other";

const RELATION_CATEGORY: Record<RelationType, RelationCategory> = {
  invests_in: "investment",
  owns: "investment",
  parent_of: "investment",
  supplies: "supply",
  buys_from: "supply",
  competes_with: "competition",
  partners_with: "partnership",
  joint_venture_with: "partnership",
  licenses_to: "partnership",
  licenses_from: "partnership",
  other: "other",
};

const CATEGORY_LABEL: Record<RelationCategory, { zh: string; en: string }> = {
  investment: { zh: "投资股权", en: "Investment" },
  supply: { zh: "供应链", en: "Supply chain" },
  competition: { zh: "竞争", en: "Competition" },
  partnership: { zh: "合作", en: "Partnership" },
  other: { zh: "其他", en: "Other" },
};

const STATUS_LABEL: Record<RelationStatus, { zh: string; en: string }> = {
  verified: { zh: "已核实", en: "Verified" },
  inferred: { zh: "待核实", en: "Unreviewed" },
  reported: { zh: "媒体报道", en: "Reported" },
  rejected: { zh: "已拒绝", en: "Rejected" },
};

const TRUST_LABEL: Record<string, { zh: string; en: string }> = {
  filing: { zh: "财报 / 公告", en: "Filing" },
  secondary: { zh: "二手资料", en: "Secondary" },
  media: { zh: "媒体", en: "Media" },
  news: { zh: "新闻", en: "News" },
  proposal: { zh: "提议", en: "Proposal" },
  fixture: { zh: "测试数据", en: "Fixture" },
  other: { zh: "其他", en: "Other" },
};

export function financialItemLabel(item: string, lang: Lang = "zh"): string {
  const known = FIN_ITEM_LABEL[item];
  if (known) return known[lang];
  return item.replace(/_/g, " ");
}

export type FinancialSourceKind = "sec" | "f10" | "profile" | "other";

const SEC_FORM = /\b(10-K|10-Q|20-F|40-F|8-K)\b/;

/**
 * A cell the parser calculated (e.g. `gross_profit = revenue - cost`) is
 * marked with a `计算：` quote. It must never be shown as a reported line.
 */
export function isDerivedFact(fact: FinancialFactView): boolean {
  return (fact.quote ?? "").replace(/^\s+/, "").startsWith("计算：");
}

export function financialSourceKind(
  fact: FinancialFactView,
): FinancialSourceKind {
  if (fact.method === "xbrl") return "sec";
  if (fact.method === "f10") return "f10";
  if (fact.method === "deterministic_table_v1" || fact.method === "llm_web") {
    return "profile";
  }
  return "other";
}

/** Filing form from the EDGAR source title (`SEC 10-K filed 2025-10-31`). */
export function financialSourceForm(fact: FinancialFactView): string | undefined {
  return SEC_FORM.exec(fact.source?.title ?? "")?.[1];
}

export function financialSourceLabel(
  fact: FinancialFactView,
  lang: Lang = "zh",
): string {
  switch (financialSourceKind(fact)) {
    case "sec": {
      const form = financialSourceForm(fact);
      return form ? `SEC ${form}` : "SEC EDGAR";
    }
    case "f10":
      return lang === "zh" ? "东方财富 F10" : "Eastmoney F10";
    case "profile":
      return lang === "zh" ? "研究资料" : "Research profile";
    default:
      return trustLabel(fact.source?.trustTier, lang);
  }
}

/**
 * A/HK 三季报 columns are year-to-date, not single quarters; US 10-Q facts are
 * true quarters. Any "quarter" spanning more than four months is cumulative.
 */
export function isCumulativePeriod(fact: FinancialFactView): boolean {
  if (fact.periodKind !== "quarter" || !fact.periodStart) return false;
  const start = Date.parse(`${fact.periodStart}T00:00:00Z`);
  const end = Date.parse(`${fact.periodEnd}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  return Math.round((end - start) / 86_400_000) >= 130;
}

export function statementLabel(statement: string, lang: Lang = "zh"): string {
  return STATEMENT_LABEL[statement]?.[lang] ?? statement;
}

export function relationTypeLabel(type: string, lang: Lang = "zh"): string {
  return RELATION_LABEL[type as RelationType]?.[lang] ?? type;
}

export function relationCategory(type: string): RelationCategory {
  return RELATION_CATEGORY[type as RelationType] ?? "other";
}

export function categoryLabel(
  category: RelationCategory,
  lang: Lang = "zh",
): string {
  return CATEGORY_LABEL[category][lang];
}

export function statusLabel(status: string, lang: Lang = "zh"): string {
  return STATUS_LABEL[status as RelationStatus]?.[lang] ?? status;
}

export function trustLabel(tier: string | undefined, lang: Lang = "zh"): string {
  if (!tier) return TRUST_LABEL.other[lang];
  return TRUST_LABEL[tier]?.[lang] ?? tier;
}

export function periodKindLabel(kind: PeriodKind, lang: Lang = "zh"): string {
  const map: Record<PeriodKind, { zh: string; en: string }> = {
    annual: { zh: "年度", en: "Annual" },
    quarter: { zh: "季度", en: "Quarter" },
    half: { zh: "半年度", en: "Half year" },
    ttm: { zh: "TTM", en: "TTM" },
  };
  return map[kind]?.[lang] ?? kind;
}

export function formatNumber(value: number, lang: Lang = "zh"): string {
  return new Intl.NumberFormat(lang === "zh" ? "zh-CN" : "en-US", {
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatCount(value: number, lang: Lang = "zh"): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (lang === "en") {
    if (abs >= 1e9) return `${formatNumber(value / 1e9, lang)}B`;
    if (abs >= 1e6) return `${formatNumber(value / 1e6, lang)}M`;
    if (abs >= 1e3) return `${formatNumber(value / 1e3, lang)}K`;
    return formatNumber(value, lang);
  }
  if (abs >= 1e8) return `${formatNumber(value / 1e8, lang)} 亿`;
  if (abs >= 1e4) return `${formatNumber(value / 1e4, lang)} 万`;
  return formatNumber(value, lang);
}

export function formatMoney(
  value: number,
  currency: string | undefined,
  lang: Lang = "zh",
): string {
  if (!Number.isFinite(value)) return "—";
  const code = (currency ?? "").toUpperCase();
  const unit = CURRENCY_LABEL[code]?.[lang] ?? code;
  const abs = Math.abs(value);
  if (lang === "en") {
    if (abs >= 1e12) return `${formatNumber(value / 1e12, lang)}T ${unit}`;
    if (abs >= 1e9) return `${formatNumber(value / 1e9, lang)}B ${unit}`;
    if (abs >= 1e6) return `${formatNumber(value / 1e6, lang)}M ${unit}`;
    return `${formatNumber(value, lang)} ${unit}`.trim();
  }
  if (abs >= 1e12) return `${formatNumber(value / 1e12, lang)} 万亿${unit}`;
  if (abs >= 1e8) return `${formatNumber(value / 1e8, lang)} 亿${unit}`;
  if (abs >= 1e4) return `${formatNumber(value / 1e4, lang)} 万${unit}`;
  return `${formatNumber(value, lang)} ${unit}`.trim();
}

export function formatPercent(value: number, lang: Lang = "zh"): string {
  if (!Number.isFinite(value)) return "—";
  return `${formatNumber(value, lang)}%`;
}

export function formatFinancialValue(
  fact: FinancialFactView,
  lang: Lang = "zh",
): string {
  const value = Number(fact.value);
  if (!Number.isFinite(value)) return "—";
  if (fact.unit === "percent") return formatPercent(value, lang);
  if (fact.unit === "currency") return formatMoney(value, fact.currency, lang);
  if (fact.unit === "shares" || fact.unit === "count") return formatCount(value, lang);
  return formatNumber(value, lang);
}

export function formatDate(value: string | undefined, lang: Lang = "zh"): string {
  if (!value) return "—";
  if (
    /^\d{4}-\d{2}-\d{2}$/.test(value) ||
    /T00:00:00(?:\.000)?Z$/.test(value)
  ) {
    const [year, month, day] = value.slice(0, 10).split("-");
    return lang === "zh" ? `${year}/${month}/${day}` : `${month}/${day}/${year}`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Prefer a compact FY/Q label over the raw "最新季度 Q3 FY2026" text. */
export function periodLabel(fact: FinancialFactView): string {
  const raw = fact.periodLabel ?? "";
  const match = raw.match(
    /Q[1-4]\s*FY\d{4}|FY\d{4}\s*Q[1-4]|\d{4}Q[1-4]|\d{4}\s*H[12]|FY\d{4}|TTM[^）)]*/,
  );
  if (match) return match[0].replace(/\s+/g, " ");
  return fact.periodEnd?.slice(0, 7) ?? "";
}

export function periodKey(fact: FinancialFactView): string {
  // Same natural key as `financial_facts_uq`: one column per period, even
  // when a profile label and a filing label disagree.
  return `${fact.periodEnd}|${fact.periodKind}`;
}

export function factText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.name === "string") return record.name;
    if (typeof record.value === "string") return record.value;
    return JSON.stringify(value);
  }
  return String(value);
}

export function factNumber(
  value: unknown,
  key: "count" | "share" | "revenue" | "value" = "count",
): number | undefined {
  if (typeof value === "number") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const raw = record[key];
    if (typeof raw === "number") return raw;
    if (typeof raw === "string") {
      const parsed = Number(raw.replace(/,/g, ""));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

export function factByPredicate(
  facts: CompanyFactView[],
  predicate: string,
): CompanyFactView | undefined {
  return facts.find((fact) => fact.predicate === predicate);
}

export function latestFact(
  facts: FinancialFactView[],
  item: string,
  kind?: PeriodKind,
): FinancialFactView | undefined {
  return facts
    .filter((fact) => fact.item === item && (!kind || fact.periodKind === kind))
    .sort(
      (a, b) =>
        b.periodEnd.localeCompare(a.periodEnd) ||
        (b.confidence ?? 0) - (a.confidence ?? 0),
    )[0];
}

export function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const id = key(item);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result;
}

export function formatConfidence(value: number | undefined): string {
  if (value === undefined) return "";
  return `${Math.round(value * 100)}%`;
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

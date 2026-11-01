import type { PeriodKind } from "@occ/core";

import {
  addDays,
  capFinancialFacts,
  computeDerivedFacts,
  daysBetween,
  fiscalQuarterFor,
  fiscalYearFor,
  normalizeMonthDay,
  periodKindFromDuration,
  type CanonicalFinancialFact,
  type CanonicalStatement,
  type CanonicalUnit,
} from "./canonical.js";

/**
 * SEC EDGAR XBRL company-facts parser.
 *
 * Input is the public `companyfacts` JSON (plus `submissions` for filing URLs).
 * This module is pure: it never fetches. The worker caches the JSON under
 * `.occ/edgar/<cik>/` and passes it here, which keeps fixture tests offline.
 */

export interface EdgarFactEntry {
  start?: string;
  end: string;
  val: number;
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
  accn?: string;
  frame?: string;
}

export interface EdgarConcept {
  label?: string;
  units: Record<string, EdgarFactEntry[]>;
}

export interface EdgarCompanyFacts {
  cik: number | string;
  entityName?: string;
  facts: Record<string, Record<string, EdgarConcept>>;
}

export interface EdgarSubmissionRecent {
  accessionNumber?: string[];
  form?: string[];
  filingDate?: string[];
  reportDate?: string[];
  primaryDocument?: string[];
}

export interface EdgarSubmissions {
  cik?: string;
  name?: string;
  filings?: {
    recent?: EdgarSubmissionRecent;
    files?: Array<{ name: string; filingCount?: number }>;
  };
}

export interface EdgarParseResult {
  facts: CanonicalFinancialFact[];
  cik: string;
  entityName?: string;
  currency: string;
  periods: number;
  warnings: string[];
}

const RELEVANT_FORMS = new Set([
  "10-K",
  "10-K/A",
  "10-Q",
  "10-Q/A",
  "20-F",
  "20-F/A",
  "40-F",
  "40-F/A",
]);

const ANNUAL_FORMS = new Set(["10-K", "10-K/A", "20-F", "20-F/A", "40-F", "40-F/A"]);

interface EdgarItemSpec {
  statement: CanonicalStatement;
  item: string;
  unit: CanonicalUnit;
  /** Ordered alternatives; the first alternative yielding facts wins. */
  alternatives: Array<{
    mode: "priority" | "sum";
    concepts: string[];
  }>;
}

function itemSpecs(): EdgarItemSpec[] {
  const one = (concepts: string[]): EdgarItemSpec["alternatives"] => [
    { mode: "priority", concepts },
  ];
  return [
    {
      statement: "income",
      item: "revenue",
      unit: "currency",
      alternatives: one([
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "RevenueFromContractWithCustomerIncludingAssessedTax",
        "Revenues",
        "SalesRevenueNet",
        "SalesRevenueGoodsNet",
        // IFRS (20-F / 40-F issuers)
        "Revenue",
        "RevenueFromContractsWithCustomers",
      ]),
    },
    {
      statement: "income",
      item: "cost_of_revenue",
      unit: "currency",
      alternatives: one([
        "CostOfRevenue",
        "CostOfGoodsAndServicesSold",
        "CostOfGoodsSold",
        "CostOfSales",
      ]),
    },
    {
      statement: "income",
      item: "gross_profit",
      unit: "currency",
      alternatives: one(["GrossProfit"]),
    },
    {
      statement: "income",
      item: "research_and_development",
      unit: "currency",
      alternatives: one([
        "ResearchAndDevelopmentExpense",
        "ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost",
      ]),
    },
    {
      statement: "income",
      item: "selling_general_admin",
      unit: "currency",
      alternatives: [
        { mode: "priority", concepts: ["SellingGeneralAndAdministrativeExpense"] },
        {
          mode: "sum",
          concepts: [
            "SellingAndMarketingExpense",
            "GeneralAndAdministrativeExpense",
          ],
        },
      ],
    },
    {
      statement: "income",
      item: "operating_income",
      unit: "currency",
      alternatives: one(["OperatingIncomeLoss", "ProfitLossFromOperatingActivities"]),
    },
    {
      statement: "income",
      item: "net_income",
      unit: "currency",
      alternatives: one(["NetIncomeLoss", "ProfitLoss"]),
    },
    {
      statement: "income",
      item: "net_income_attributable",
      unit: "currency",
      alternatives: one([
        "NetIncomeLossAvailableToCommonStockholdersBasic",
        "NetIncomeLoss",
        "ProfitLossAttributableToOwnersOfParent",
      ]),
    },
    {
      statement: "income",
      item: "eps_diluted",
      unit: "currency_per_share",
      alternatives: one([
        "EarningsPerShareDiluted",
        "EarningsPerShareBasicAndDiluted",
        "DilutedEarningsLossPerShare",
        "BasicAndDilutedEarningsLossPerShare",
      ]),
    },
    {
      statement: "balance",
      item: "cash_and_equivalents",
      unit: "currency",
      alternatives: one([
        "CashAndCashEquivalentsAtCarryingValue",
        "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
        "CashAndCashEquivalents",
      ]),
    },
    {
      statement: "balance",
      item: "total_assets",
      unit: "currency",
      alternatives: one(["Assets"]),
    },
    {
      statement: "balance",
      item: "total_liabilities",
      unit: "currency",
      alternatives: one(["Liabilities"]),
    },
    {
      statement: "balance",
      item: "total_equity",
      unit: "currency",
      // Total equity including NCI is what a balance sheet subtotal means;
      // total_liabilities = assets - total_equity is only exact with it.
      alternatives: one([
        "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
        "StockholdersEquity",
        "Equity",
        "EquityAttributableToOwnersOfParent",
      ]),
    },
    {
      statement: "balance",
      item: "total_debt",
      unit: "currency",
      alternatives: [
        {
          mode: "priority",
          concepts: [
            "LongTermDebt",
            "Borrowings",
            "ConvertibleDebt",
          ],
        },
        {
          mode: "sum",
          concepts: [
            "LongTermDebtNoncurrent",
            "LongTermDebtCurrent",
            "ShortTermBorrowings",
            "CommercialPaper",
            "ConvertibleDebtNoncurrent",
            "ConvertibleDebtCurrent",
            "ConvertibleLongTermNotesPayable",
            "ConvertibleNotesPayableCurrent",
            "LongtermBorrowings",
            "ShorttermBorrowings",
            "CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings",
          ],
        },
      ],
    },
    {
      statement: "cash_flow",
      item: "operating_cash_flow",
      unit: "currency",
      alternatives: one([
        "NetCashProvidedByUsedInOperatingActivities",
        "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
        "CashFlowsFromUsedInOperatingActivities",
      ]),
    },
    {
      statement: "cash_flow",
      item: "capex",
      unit: "currency",
      alternatives: one([
        "PaymentsToAcquirePropertyPlantAndEquipment",
        "PaymentsToAcquireProductiveAssets",
        "PaymentsForCapitalImprovements",
        "PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities",
      ]),
    },
    {
      statement: "cash_flow",
      item: "investing_cash_flow",
      unit: "currency",
      alternatives: one([
        "NetCashProvidedByUsedInInvestingActivities",
        "NetCashProvidedByUsedInInvestingActivitiesContinuingOperations",
        "CashFlowsFromUsedInInvestingActivities",
      ]),
    },
    {
      statement: "cash_flow",
      item: "financing_cash_flow",
      unit: "currency",
      alternatives: one([
        "NetCashProvidedByUsedInFinancingActivities",
        "NetCashProvidedByUsedInFinancingActivitiesContinuingOperations",
        "CashFlowsFromUsedInFinancingActivities",
      ]),
    },
  ];
}

interface FilingInfo {
  url: string;
  title: string;
  form: string;
  filed: string;
}

interface Candidate {
  conceptIndex: number;
  entry: EdgarFactEntry;
  duration: number;
  kind: PeriodKind;
  fiscalQuarter?: number;
  start?: string;
  currency?: string;
  unitKey: string;
}

export function parseEdgarFinancials(input: {
  companyFacts: EdgarCompanyFacts;
  submissions?: EdgarSubmissions;
}): EdgarParseResult {
  const warnings: string[] = [];
  const cik = String(input.companyFacts.cik ?? input.submissions?.cik ?? "")
    .replace(/^0+/, "")
    .padStart(10, "0");
  const facts = mergeTaxonomies(input.companyFacts.facts);
  if (Object.keys(facts).length === 0) {
    return {
      facts: [],
      cik,
      ...(input.companyFacts.entityName
        ? { entityName: input.companyFacts.entityName }
        : {}),
      currency: "USD",
      periods: 0,
      warnings: ["companyfacts has no us-gaap or ifrs-full facts"],
    };
  }

  const preferredCurrency = detectReportingCurrency(facts);
  const filings = buildFilingMap(input.submissions, cik);
  const fiscalYearEnd =
    deriveFiscalYearEnd(input.submissions, facts) ?? { month: 12, day: 31 };
  const fallbackUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;

  const all: CanonicalFinancialFact[] = [];
  const periodKeys = new Set<string>();
  let currency = preferredCurrency ?? "USD";

  for (const spec of itemSpecs()) {
    let produced: CanonicalFinancialFact[] | null = null;
    for (const alternative of spec.alternatives) {
      const result = buildFromAlternative({
        facts,
        concepts: alternative.concepts,
        mode: alternative.mode,
        spec,
        fiscalYearEnd,
        filings,
        fallbackUrl,
        ...(preferredCurrency ? { preferredCurrency } : {}),
      });
      if (result.facts.length > 0) {
        produced = result.facts;
        currency = result.currency ?? currency;
        break;
      }
    }
    if (!produced) continue;
    for (const fact of produced) {
      all.push(fact);
      periodKeys.add(`${fact.periodEnd}|${fact.periodKind}`);
    }
  }

  const derived = computeDerivedFacts(all, {
    url: fallbackUrl,
    title: "SEC EDGAR XBRL company facts",
  });
  const capped = capFinancialFacts([...all, ...derived]).map((fact) => ({
    ...fact,
    sourceTitle: fact.sourceTitle
      ? `${fact.sourceTitle} (CIK ${cik})`
      : `SEC EDGAR (CIK ${cik})`,
  }));
  if (capped.length === 0) warnings.push("no canonical XBRL facts matched");

  return {
    facts: capped.sort(
      (a, b) =>
        a.periodEnd.localeCompare(b.periodEnd) ||
        a.statement.localeCompare(b.statement) ||
        a.item.localeCompare(b.item),
    ),
    cik,
    ...(input.companyFacts.entityName
      ? { entityName: input.companyFacts.entityName }
      : {}),
    currency,
    periods: periodKeys.size,
    warnings,
  };
}

function buildFromAlternative(input: {
  facts: Record<string, EdgarConcept>;
  concepts: string[];
  mode: "priority" | "sum";
  spec: EdgarItemSpec;
  fiscalYearEnd: { month: number; day: number };
  filings: Map<string, FilingInfo>;
  fallbackUrl: string;
  preferredCurrency?: string;
}): { facts: CanonicalFinancialFact[]; currency?: string } {
  const perConcept = input.concepts.map((conceptName, index) =>
    collectConcept({
      concept: input.facts[conceptName],
      conceptIndex: index,
      unit: input.spec.unit,
      fiscalYearEnd: input.fiscalYearEnd,
      ...(input.preferredCurrency
        ? { preferredCurrency: input.preferredCurrency }
        : {}),
    }),
  );

  if (perConcept.every((entry) => entry.candidates.length === 0)) {
    return { facts: [] };
  }

  // Group by period key, then apply either priority (first concept) or sum.
  const grouped = new Map<
    string,
    Array<{ conceptIndex: number; candidate: Candidate; currency?: string }>
  >();
  for (const entry of perConcept) {
    for (const candidate of entry.candidates) {
      const key = `${candidate.entry.end}|${candidate.kind}`;
      const list = grouped.get(key);
      const value = {
        conceptIndex: candidate.conceptIndex,
        candidate,
        ...(entry.currency ? { currency: entry.currency } : {}),
      };
      if (list) list.push(value);
      else grouped.set(key, [value]);
    }
  }

  const facts: CanonicalFinancialFact[] = [];
  let currency: string | undefined;
  for (const list of grouped.values()) {
    list.sort(
      (a, b) =>
        a.conceptIndex - b.conceptIndex ||
        a.candidate.duration - b.candidate.duration ||
        (b.candidate.entry.filed ?? "").localeCompare(
          a.candidate.entry.filed ?? "",
        ),
    );
    const selected =
      input.mode === "priority"
        ? {
            base: list[0]!.candidate,
            value: list[0]!.candidate.entry.val,
            quote: undefined as string | undefined,
            currency: list[0]!.currency,
          }
        : sumCandidates(list);
    if (!selected) continue;
    const value =
      input.spec.unit === "currency" && input.spec.item === "capex"
        ? Math.abs(selected.value)
        : selected.value;
    currency = selected.currency ?? currency;
    facts.push(
      makeFact({
        spec: input.spec,
        entry: selected.base.entry,
        value,
        kind: selected.base.kind,
        duration: selected.base.duration,
        fiscalQuarter: selected.base.fiscalQuarter,
        start: selected.base.start,
        fiscalYearEnd: input.fiscalYearEnd,
        currency: selected.currency,
        filings: input.filings,
        fallbackUrl: input.fallbackUrl,
        quote: selected.quote,
      }),
    );
  }
  return { facts, ...(currency ? { currency } : {}) };
}

interface Collected {
  candidates: Candidate[];
  currency?: string;
}

function collectConcept(input: {
  concept: EdgarConcept | undefined;
  conceptIndex: number;
  unit: CanonicalUnit;
  fiscalYearEnd: { month: number; day: number };
  preferredCurrency?: string;
}): Collected {
  if (!input.concept?.units) return { candidates: [] };
  const unitEntry = pickUnit(
    input.concept.units,
    input.unit,
    input.preferredCurrency,
  );
  if (!unitEntry) return { candidates: [] };
  const candidates: Candidate[] = [];
  for (const entry of unitEntry.entries) {
    if (!entry || typeof entry.val !== "number") continue;
    if (!entry.end) continue;
    if (entry.form && !RELEVANT_FORMS.has(entry.form)) continue;
    const kind = classifyEntry(entry, input.fiscalYearEnd);
    if (!kind) continue;
    const duration = entry.start
      ? daysBetween(entry.start, entry.end)
      : 0;
    candidates.push({
      conceptIndex: input.conceptIndex,
      entry,
      duration,
      kind: kind.kind,
      ...(kind.fiscalQuarter !== undefined
        ? { fiscalQuarter: kind.fiscalQuarter }
        : {}),
      ...(entry.start ? { start: entry.start } : {}),
      ...(unitEntry.currency ? { currency: unitEntry.currency } : {}),
      unitKey: unitEntry.key,
    });
  }
  return {
    candidates,
    ...(unitEntry.currency ? { currency: unitEntry.currency } : {}),
  };
}

function pickUnit(
  units: Record<string, EdgarFactEntry[]>,
  unit: CanonicalUnit,
  preferredCurrency?: string,
): { key: string; entries: EdgarFactEntry[]; currency?: string } | null {
  const keys = Object.keys(units);
  const preferred = (key: string): number =>
    preferredCurrency && key.split("/")[0] === preferredCurrency ? 1 : 0;
  const ordered = [...keys].sort((a, b) => {
    if (unit === "currency_per_share") {
      return (
        preferred(b) - preferred(a) ||
        Number(b.includes("/shares")) - Number(a.includes("/shares")) ||
        Number(b.startsWith("USD")) - Number(a.startsWith("USD"))
      );
    }
    return (
      preferred(b) - preferred(a) ||
      Number(b === "USD") - Number(a === "USD")
    );
  });
  for (const key of ordered) {
    if (unit === "currency_per_share" && !key.includes("/shares")) continue;
    if (unit === "currency" && !/^[A-Z]{3}$/.test(key)) continue;
    if (unit === "percent") continue;
    const currency = key.split("/")[0];
    return {
      key,
      entries: units[key] ?? [],
      ...(currency && /^[A-Z]{3}$/.test(currency) ? { currency } : {}),
    };
  }
  return null;
}

/**
 * us-gaap wins concept-name collisions; ifrs-full fills the rest so 20-F/40-F
 * issuers (CCEP, Ferrovial, Thomson Reuters) parse through the same specs.
 */
function mergeTaxonomies(
  taxonomies: Record<string, Record<string, EdgarConcept>> | undefined,
): Record<string, EdgarConcept> {
  const usGaap = taxonomies?.["us-gaap"] ?? {};
  const ifrs = taxonomies?.["ifrs-full"] ?? {};
  if (Object.keys(usGaap).length === 0) return ifrs;
  return { ...ifrs, ...usGaap };
}

/**
 * The reporting currency, taken from the balance sheet's first unit. A filer
 * can tag the same concept in both EUR and USD (CCEP); mixing them across
 * items would make the statement unreadable.
 */
function detectReportingCurrency(
  facts: Record<string, EdgarConcept>,
): string | undefined {
  for (const concept of ["Assets", "Liabilities", "Equity", "Revenue"]) {
    const units = Object.keys(facts[concept]?.units ?? {});
    for (const key of units) {
      if (/^[A-Z]{3}$/.test(key)) return key;
    }
    for (const key of units) {
      const prefix = key.split("/")[0];
      if (prefix && /^[A-Z]{3}$/.test(prefix)) return prefix;
    }
  }
  return undefined;
}

function classifyEntry(
  entry: EdgarFactEntry,
  fiscalYearEnd: { month: number; day: number },
): { kind: PeriodKind; fiscalQuarter?: number } | null {
  if (entry.start) {
    const kind = periodKindFromDuration(daysBetween(entry.start, entry.end));
    if (!kind) return null;
    // The fact start is the quarter start, not the fiscal year start. Derive
    // the quarter from the fiscal year so a 90-day Q3 is not labelled Q1.
    const fy = fiscalYearFor(entry.end, fiscalYearEnd);
    const quarter = fiscalQuarterFor(
      fiscalYearStart(fy, fiscalYearEnd),
      entry.end,
    );
    if (kind.kind === "quarter") {
      return { kind: "quarter", fiscalQuarter: quarter };
    }
    if (kind.kind === "half") {
      return { kind: "half", fiscalQuarter: 2 };
    }
    return kind;
  }
  // Point-in-time balance facts appear as prior-year comparatives in later
  // filings, so the filing's `fp` is not trustworthy. Classify by the fact
  // date's position in the fiscal year instead.
  const fy = fiscalYearFor(entry.end, fiscalYearEnd);
  const anniversary = `${entry.end.slice(0, 4)}-${String(fiscalYearEnd.month).padStart(2, "0")}-${String(fiscalYearEnd.day).padStart(2, "0")}`;
  const offset =
    Math.abs(
      Date.parse(`${entry.end}T00:00:00Z`) -
        Date.parse(`${anniversary}T00:00:00Z`),
    ) / 86_400_000;
  if (offset <= 7) return { kind: "annual" };
  const fiscalQuarter = fiscalQuarterFor(
    fiscalYearStart(fy, fiscalYearEnd),
    entry.end,
  );
  if (fiscalQuarter === 4) return { kind: "annual" };
  if (fiscalQuarter === 2) {
    return { kind: "half", fiscalQuarter: 2 };
  }
  return { kind: "quarter", fiscalQuarter };
}

interface SelectedCandidate {
  base: Candidate;
  value: number;
  quote?: string;
  currency?: string;
}

function sumCandidates(
  list: Array<{ conceptIndex: number; candidate: Candidate; currency?: string }>,
): SelectedCandidate | null {
  const chosen = new Map<number, Candidate>();
  for (const item of list) {
    const existing = chosen.get(item.conceptIndex);
    if (
      !existing ||
      item.candidate.duration < existing.duration ||
      ((item.candidate.entry.filed ?? "") >
        (existing.entry.filed ?? "") &&
        item.candidate.duration === existing.duration)
    ) {
      chosen.set(item.conceptIndex, item.candidate);
    }
  }
  const candidates = [...chosen.values()];
  if (candidates.length === 0) return null;
  const base = candidates[0]!;
  const value = candidates.reduce((sum, item) => sum + item.entry.val, 0);
  const currency = candidates.find((item) => item.currency)?.currency;
  return {
    base,
    ...(currency ? { currency } : {}),
    value,
    quote: candidates
      .map((item) => `${item.unitKey}: ${item.entry.val}`)
      .join(" + "),
  };
}

function makeFact(input: {
  spec: EdgarItemSpec;
  entry: EdgarFactEntry;
  value: number;
  kind: PeriodKind;
  duration: number;
  fiscalQuarter?: number;
  start?: string;
  fiscalYearEnd: { month: number; day: number };
  currency?: string;
  filings: Map<string, FilingInfo>;
  fallbackUrl: string;
  quote?: string;
}): CanonicalFinancialFact {
  const fiscalYear = fiscalYearFor(input.entry.end, input.fiscalYearEnd);
  const quarter =
    input.kind === "quarter"
      ? (input.fiscalQuarter ?? fiscalQuarterFor(
          input.start ?? fiscalYearStart(fiscalYear, input.fiscalYearEnd),
          input.entry.end,
        ))
      : input.kind === "half"
        ? 2
        : undefined;
  const label =
    input.kind === "annual"
      ? `FY${fiscalYear}`
      : input.kind === "half"
        ? `${fiscalYear}H1`
        : `${fiscalYear}Q${quarter}`;
  const filing = input.entry.accn ? input.filings.get(input.entry.accn) : undefined;
  const sourceUrl = filing?.url ?? input.fallbackUrl;
  const sourceTitle =
    filing?.title ??
    `SEC ${input.entry.form ?? "XBRL"} ${input.entry.filed ?? input.entry.end}`;
  const quote =
    input.quote ??
    `${input.spec.item} ${input.entry.start ? `${input.entry.start}–` : ""}${input.entry.end}: ${input.entry.val} ${input.currency ?? ""} (${input.entry.form ?? "XBRL"})`.trim();
  return {
    statement: input.spec.statement,
    item: input.spec.item,
    periodKind: input.kind,
    periodLabel: label,
    ...(input.start ? { periodStart: input.start } : {}),
    periodEnd: input.entry.end,
    fiscalYear,
    ...(quarter !== undefined ? { fiscalQuarter: quarter } : {}),
    value: input.value,
    unit: input.spec.unit,
    ...(input.currency ? { currency: input.currency } : {}),
    quote: quote.slice(0, 1_000),
    confidence: 1,
    sourceUrl,
    sourceTitle,
  };
}

function fiscalYearStart(
  fiscalYear: number,
  fiscalYearEnd: { month: number; day: number },
): string {
  const end = `${fiscalYear - 1}-${String(fiscalYearEnd.month).padStart(2, "0")}-${String(fiscalYearEnd.day).padStart(2, "0")}`;
  return addDays(end, 1);
}

function buildFilingMap(
  submissions: EdgarSubmissions | undefined,
  cik: string,
): Map<string, FilingInfo> {
  const map = new Map<string, FilingInfo>();
  const recent = submissions?.filings?.recent;
  if (!recent?.accessionNumber) return map;
  const count = recent.accessionNumber.length;
  for (let index = 0; index < count; index += 1) {
    const form = recent.form?.[index] ?? "";
    if (!RELEVANT_FORMS.has(form)) continue;
    const accession = recent.accessionNumber[index];
    if (!accession) continue;
    const document = recent.primaryDocument?.[index] ?? "";
    const filed = recent.filingDate?.[index] ?? "";
    const url = document
      ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/${document}`
      : `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/`;
    map.set(accession, {
      url,
      title: `SEC ${form} filed ${filed}`,
      form,
      filed,
    });
  }
  return map;
}

function deriveFiscalYearEnd(
  submissions: EdgarSubmissions | undefined,
  facts: Record<string, EdgarConcept>,
): { month: number; day: number } | null {
  const recent = submissions?.filings?.recent;
  if (recent?.form && recent.reportDate) {
    let best: { filed: string; reportDate: string } | null = null;
    for (let index = 0; index < recent.form.length; index += 1) {
      const form = recent.form[index] ?? "";
      if (!ANNUAL_FORMS.has(form)) continue;
      const reportDate = recent.reportDate[index];
      if (!reportDate) continue;
      const filed = recent.filingDate?.[index] ?? "";
      if (!best || filed > best.filed) best = { filed, reportDate };
    }
    const parsed = normalizeMonthDay(best?.reportDate?.slice(5));
    if (parsed) return parsed;
  }
  // Fallback: the latest annual duration end month-day from any concept.
  let latest: string | null = null;
  for (const concept of Object.values(facts)) {
    for (const entries of Object.values(concept.units ?? {})) {
      for (const entry of entries) {
        if (!entry.start || !entry.end) continue;
        const duration = daysBetween(entry.start, entry.end);
        if (duration < 340 || duration > 385) continue;
        if (!latest || entry.end > latest) latest = entry.end;
      }
    }
  }
  return latest ? normalizeMonthDay(latest.slice(5)) : null;
}

/** Exported for unit tests: FYE derivation is the fragile part of XBRL. */
export { deriveFiscalYearEnd };

import fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  computeDerivedFacts,
  fiscalYearFor,
  mergeFinancialSources,
  parseF10Number,
  parseEdgarFinancials,
  parseF10Financials,
  type CanonicalFinancialFact,
} from "../src/financials/index.js";

function fixture<T>(name: string): T {
  const url = new URL(`./fixtures/financials/${name}`, import.meta.url);
  return JSON.parse(fs.readFileSync(url, "utf8")) as T;
}

function latest(
  facts: CanonicalFinancialFact[],
  item: string,
  kind: string,
): CanonicalFinancialFact | undefined {
  return facts
    .filter((fact) => fact.item === item && fact.periodKind === kind)
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
}

describe("F10 numeric cells", () => {
  it("expands Chinese magnitude suffixes to native units", () => {
    expect(parseF10Number("499.3亿")?.value).toBe(49_930_000_000);
    expect(parseF10Number("9800万")?.value).toBe(98_000_000);
    expect(parseF10Number("2.159万亿")?.value).toBe(2_159_000_000_000);
    expect(parseF10Number("-620.9亿")?.value).toBe(-62_090_000_000);
    expect(parseF10Number("51.5300")?.value).toBe(51.53);
  });

  it("keeps percentages and treats missing cells as null", () => {
    expect(parseF10Number("49.07%")).toEqual({ value: 49.07, percent: true });
    expect(parseF10Number("--")).toBeNull();
    expect(parseF10Number("0")?.value).toBe(0);
  });
});

describe("F10 cwfx parser", () => {
  it("parses the US page (annual + cumulative Q3)", () => {
    const page = fixture<Record<string, unknown>>("f10-us.json");
    const result = parseF10Financials({ page: page as never, market: "US" });
    expect(result.currency).toBe("USD");

    const revenue = latest(result.facts, "revenue", "annual");
    expect(revenue).toMatchObject({
      periodLabel: "FY2025",
      periodEnd: "2025-09-27",
      value: 416_161_000_000,
      currency: "USD",
    });
    expect(revenue?.sourceUrl).toContain("PC_USF10");

    const q3 = latest(result.facts, "revenue", "quarter");
    expect(q3).toMatchObject({
      periodLabel: "2026Q3",
      periodEnd: "2026-06-27",
      periodStart: "2025-09-27",
      value: 364_400_000_000,
    });

    expect(latest(result.facts, "total_debt", "annual")?.value).toBe(
      90_680_000_000,
    );
    expect(latest(result.facts, "capex", "annual")?.value).toBe(12_715_000_000);
    expect(latest(result.facts, "free_cash_flow", "annual")?.value).toBe(
      98_767_000_000,
    );
    expect(latest(result.facts, "gross_margin", "annual")?.value).toBeCloseTo(
      46.91,
      2,
    );
    expect(latest(result.facts, "eps_diluted", "annual")).toMatchObject({
      value: 7.46,
      unit: "currency_per_share",
    });
  });

  it("reattaches split sticky headers on A-share pages", () => {
    const page = fixture<Record<string, unknown>>("f10-a.json");
    const result = parseF10Financials({ page: page as never, market: "A" });
    expect(result.currency).toBe("CNY");

    expect(latest(result.facts, "revenue", "annual")).toMatchObject({
      periodLabel: "FY2025",
      periodEnd: "2025-12-31",
      value: 172_100_000_000,
    });
    expect(latest(result.facts, "total_assets", "annual")?.value).toBe(
      303_800_000_000,
    );
    // SG&A is the sum of 销售费用 + 管理费用.
    expect(latest(result.facts, "selling_general_admin", "annual")?.value).toBe(
      15_573_000_000,
    );
    expect(latest(result.facts, "gross_margin", "annual")?.value).toBe(91.18);
    expect(latest(result.facts, "capex", "annual")?.value).toBe(3_128_000_000);
    expect(latest(result.facts, "free_cash_flow", "annual")?.value).toBe(
      58_392_000_000,
    );
    // Both borrowing rows are `--`, so total debt is not fabricated as zero.
    expect(latest(result.facts, "total_debt", "annual")).toBeUndefined();
  });

  it("parses the HK page with start-date headers and duplicate debt rows", () => {
    const page = fixture<Record<string, unknown>>("f10-hk.json");
    const result = parseF10Financials({ page: page as never, market: "HK" });
    expect(result.currency).toBe("HKD");

    const annualRevenue = latest(result.facts, "revenue", "annual");
    expect(annualRevenue).toMatchObject({
      periodLabel: "FY2025",
      value: 743_700_000_000,
    });
    // HK prefers 营业额 (turnover) over 总收入.
    expect(annualRevenue?.quote).toContain("营业额");

    const h1 = latest(result.facts, "revenue", "half");
    expect(h1).toMatchObject({
      periodLabel: "2026H1",
      periodStart: "2026-01-01",
      periodEnd: "2026-06-30",
      value: 396_400_000_000,
    });

    expect(latest(result.facts, "net_income", "annual")?.value).toBe(
      229_800_000_000,
    );
    expect(latest(result.facts, "net_income_attributable", "annual")?.value).toBe(
      224_800_000_000,
    );
    // Current + non-current 借款 plus both lease rows.
    expect(latest(result.facts, "total_debt", "half")?.value).toBe(
      317_859_000_000,
    );
    expect(latest(result.facts, "capex", "annual")?.value).toBe(
      112_870_000_000,
    );
    expect(latest(result.facts, "capex", "half")?.value).toBe(11_550_000_000);
  });

  it("uses regex fallbacks for HK cash-flow wording variants", () => {
    const result = parseF10Financials({
      market: "HK",
      page: {
        page: "NewFinancialAnalysis",
        url: "https://emweb.eastmoney.com/pc_hkf10#/NewFinancialAnalysis",
        tables: [
          {
            headers: ["报表起始日", "25-01-01"],
            rows: [
              ["报表起始日", "25-01-01"],
              ["报表截止日", "25-12-31"],
              ["年结日", "12-31"],
              ["营运收入", "1.05万亿"],
              ["营运利润", "1489亿"],
            ],
          },
          {
            headers: ["报表起始日", "25-01-01"],
            rows: [
              ["报表起始日", "25-01-01"],
              ["报表截止日", "25-12-31"],
              ["年结日", "12-31"],
              ["经营业务现金流入净额", "2329亿"],
              ["投资业务现金流出净额", "-1904亿"],
              ["融资业务现金流出净额", "-1121亿"],
              ["购置固定资产、其他无形资产等非流动资产所付款项", "1570亿"],
            ],
          },
        ],
      },
    });
    expect(latest(result.facts, "revenue", "annual")?.value).toBe(
      1_050_000_000_000,
    );
    expect(latest(result.facts, "operating_income", "annual")?.value).toBe(
      148_900_000_000,
    );
    expect(latest(result.facts, "operating_cash_flow", "annual")?.value).toBe(
      232_900_000_000,
    );
    expect(latest(result.facts, "investing_cash_flow", "annual")?.value).toBe(
      -190_400_000_000,
    );
    expect(latest(result.facts, "financing_cash_flow", "annual")?.value).toBe(
      -112_100_000_000,
    );
    expect(latest(result.facts, "capex", "annual")?.value).toBe(
      157_000_000_000,
    );
  });

  it("maps bank-specific HK labels (HSBC shape)", () => {    const result = parseF10Financials({
      market: "HK",
      page: {
        page: "NewFinancialAnalysis",
        url: "https://emweb.eastmoney.com/pc_hkf10#/NewFinancialAnalysis",
        tables: [
          {
            headers: ["报表起始日", "25-01-01"],
            rows: [
              ["报表起始日", "25-01-01"],
              ["报表截止日", "25-12-31"],
              ["年结日", "12-31"],
              ["营业总收入(元)", "4528亿"],
              ["除税后溢利:利潤", "1626亿"],
              ["除税后溢利:公司普通股股東", "1483亿"],
              ["一般及行政开支", "840.6亿"],
              ["营业利润", "1968亿"],
            ],
          },
          {
            headers: ["截止日期", "25-12-31"],
            rows: [
              ["截止日期", "25-12-31"],
              ["年结日", "12-31"],
              ["现金及于中央银行之结余", "1.707万亿"],
              ["资产总值", "22.72万亿"],
              ["负债总额", "21.28万亿"],
              ["股东权益总额", "1.393万亿"],
            ],
          },
        ],
      },
    });

    expect(latest(result.facts, "revenue", "annual")?.value).toBe(
      452_800_000_000,
    );
    expect(latest(result.facts, "net_income", "annual")?.value).toBe(
      162_600_000_000,
    );
    expect(latest(result.facts, "net_income_attributable", "annual")?.value).toBe(
      148_300_000_000,
    );
    expect(latest(result.facts, "total_assets", "annual")?.value).toBe(
      22_720_000_000_000,
    );
    expect(latest(result.facts, "cash_and_equivalents", "annual")?.value).toBe(
      1_707_000_000_000,
    );
    expect(latest(result.facts, "total_equity", "annual")?.value).toBe(
      1_393_000_000_000,
    );
  });
});

describe("SEC EDGAR XBRL parser", () => {
  it("parses us-gaap company facts", () => {
    const companyFacts = fixture<Record<string, unknown>>(
      "edgar-companyfacts.json",
    );
    const submissions = fixture<Record<string, unknown>>(
      "edgar-submissions.json",
    );
    const result = parseEdgarFinancials({
      companyFacts: companyFacts as never,
      submissions: submissions as never,
    });

    const annual = latest(result.facts, "revenue", "annual");
    expect(annual).toMatchObject({
      periodLabel: "FY2025",
      periodEnd: "2025-09-27",
      value: 416_161_000_000,
      currency: "USD",
      periodStart: "2024-09-29",
    });
    expect(annual?.sourceUrl).toContain("000032019325000079");

    const quarter = latest(result.facts, "revenue", "quarter");
    expect(quarter).toMatchObject({
      periodLabel: "2026Q3",
      periodEnd: "2026-06-27",
      periodStart: "2026-03-29",
      value: 109_417_000_000,
    });

    expect(latest(result.facts, "total_assets", "annual")?.value).toBe(
      359_241_000_000,
    );
    expect(latest(result.facts, "total_assets", "quarter")?.value).toBe(
      383_266_000_000,
    );
    expect(latest(result.facts, "operating_cash_flow", "quarter")).toMatchObject(
      {
        periodStart: "2025-09-28",
        value: 116_996_000_000,
      },
    );
    expect(latest(result.facts, "total_debt", "annual")?.value).toBe(
      90_678_000_000,
    );
    expect(latest(result.facts, "eps_diluted", "annual")).toMatchObject({
      value: 7.46,
      unit: "currency_per_share",
    });
    expect(latest(result.facts, "gross_margin", "annual")?.value).toBeCloseTo(
      46.91,
      2,
    );
    expect(latest(result.facts, "free_cash_flow", "annual")?.value).toBe(
      98_767_000_000,
    );
  });

  it("parses ifrs-full 20-F facts, keeps EUR and derives missing subtotals", () => {
    const result = parseEdgarFinancials({
      companyFacts: fixture<Record<string, unknown>>(
        "edgar-ifrs-companyfacts.json",
      ) as never,
      submissions: fixture<Record<string, unknown>>(
        "edgar-ifrs-submissions.json",
      ) as never,
    });

    // Assets is EUR-only, so the dual-tagged revenue concept must not flip to USD.
    expect(result.currency).toBe("EUR");
    expect(latest(result.facts, "revenue", "annual")).toMatchObject({
      periodLabel: "FY2025",
      periodEnd: "2025-12-31",
      value: 21_000_000_000,
      currency: "EUR",
    });
    expect(latest(result.facts, "revenue", "annual")?.sourceUrl).toContain(
      "000165010726000010",
    );

    expect(latest(result.facts, "operating_income", "annual")?.value).toBe(
      2_000_000_000,
    );
    expect(latest(result.facts, "net_income", "annual")?.value).toBe(
      1_500_000_000,
    );
    expect(latest(result.facts, "net_income_attributable", "annual")?.value).toBe(
      1_400_000_000,
    );
    expect(latest(result.facts, "eps_diluted", "annual")?.value).toBe(3.07);
    expect(latest(result.facts, "total_equity", "annual")?.value).toBe(
      12_000_000_000,
    );
    expect(latest(result.facts, "total_debt", "annual")?.value).toBe(
      9_500_000_000,
    );
    expect(latest(result.facts, "capex", "annual")?.value).toBe(800_000_000);

    // GrossProfit and Liabilities are not tagged: both are derived, not faked.
    const grossProfit = latest(result.facts, "gross_profit", "annual");
    expect(grossProfit?.value).toBe(8_400_000_000);
    expect(grossProfit?.quote).toMatch(/^计算：/);
    expect(grossProfit?.confidence).toBeLessThan(1);
    expect(latest(result.facts, "gross_margin", "annual")?.value).toBe(40);

    const liabilities = latest(result.facts, "total_liabilities", "annual");
    expect(liabilities?.value).toBe(18_000_000_000);
    expect(liabilities?.quote).toMatch(/^计算：/);
    expect(liabilities?.confidence).toBeLessThan(1);

    expect(latest(result.facts, "free_cash_flow", "annual")?.value).toBe(
      1_700_000_000,
    );
  });

  it("derives gross profit and liabilities only when both inputs exist", () => {
    const base = {
      statement: "income" as const,
      periodKind: "annual" as const,
      periodLabel: "FY2025",
      periodEnd: "2025-12-31",
      value: 100,
      unit: "currency" as const,
      currency: "USD",
      quote: "",
      confidence: 1,
    };
    const derived = computeDerivedFacts(
      [
        { ...base, item: "revenue" },
        { ...base, item: "cost_of_revenue", value: 60 },
        { ...base, statement: "balance", item: "total_assets", value: 500 },
        { ...base, statement: "balance", item: "total_equity", value: 200 },
      ],
      { url: "https://example.test/filing" },
    );
    expect(derived.find((fact) => fact.item === "gross_profit")).toMatchObject({
      value: 40,
      unit: "currency",
      currency: "USD",
      sourceUrl: "https://example.test/filing",
    });
    expect(derived.find((fact) => fact.item === "gross_margin")?.value).toBe(40);
    expect(
      derived.find((fact) => fact.item === "total_liabilities"),
    ).toMatchObject({ value: 300, statement: "balance" });

    const incomplete = computeDerivedFacts(
      [
        { ...base, item: "revenue" },
        { ...base, statement: "balance", item: "total_assets", value: 500 },
      ],
      {},
    );
    expect(incomplete).toHaveLength(0);
  });

  it("derives the fiscal year end from the latest annual filing", () => {
    expect(fiscalYearFor("2025-12-27", { month: 9, day: 26 })).toBe(2026);
    expect(fiscalYearFor("2026-06-27", { month: 9, day: 26 })).toBe(2026);
    expect(fiscalYearFor("2025-09-27", { month: 9, day: 26 })).toBe(2025);
  });
});

describe("financial source precedence", () => {
  const base: CanonicalFinancialFact = {
    statement: "income",
    item: "revenue",
    periodKind: "annual",
    periodLabel: "FY2025",
    periodStart: "2024-09-29",
    periodEnd: "2025-09-27",
    value: 100,
    unit: "currency",
    currency: "USD",
    quote: "",
    confidence: 1,
  };

  it("keeps the higher-precedence value and counts a >1% difference", () => {
    const merged = mergeFinancialSources(
      [
        { method: "f10", facts: [{ ...base, value: 110 }] },
        { method: "xbrl", facts: [{ ...base, value: 100 }] },
      ],
      ["xbrl", "f10"],
    );
    expect(merged.facts).toHaveLength(1);
    expect(merged.facts[0]).toMatchObject({ method: "xbrl", value: 100 });
    expect(merged.comparison).toMatchObject({ compared: 1, differing: 1 });
  });

  it("lets a lower-precedence source fill items the higher one lacks", () => {
    const merged = mergeFinancialSources(
      [
        { method: "f10", facts: [{ ...base, item: "gross_margin", unit: "percent", value: 46.9 }] },
        { method: "xbrl", facts: [base] },
      ],
      ["xbrl", "f10"],
    );
    expect(merged.facts.map((fact) => fact.item).sort()).toEqual([
      "gross_margin",
      "revenue",
    ]);
  });

  it("does not compare a true quarter with a cumulative YTD column", () => {
    const merged = mergeFinancialSources(
      [
        {
          method: "f10",
          facts: [{ ...base, periodStart: "2024-09-01", value: 364 }],
        },
        {
          method: "xbrl",
          facts: [{ ...base, periodStart: "2026-03-29", value: 109 }],
        },
      ],
      ["xbrl", "f10"],
    );
    expect(merged.comparison.compared).toBe(0);
  });

  it("does not compare values reported in different currencies", () => {
    const merged = mergeFinancialSources(
      [
        { method: "f10", facts: [{ ...base, currency: "USD", value: 110 }] },
        { method: "xbrl", facts: [{ ...base, currency: "EUR", value: 100 }] },
      ],
      ["xbrl", "f10"],
    );
    expect(merged.facts[0]).toMatchObject({ method: "xbrl", currency: "EUR" });
    expect(merged.comparison.compared).toBe(0);
  });
});

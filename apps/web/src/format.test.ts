import { describe, expect, it } from "vitest";
import type { FinancialFactView } from "@occ/core";

import {
  FIN_ITEM_ORDER,
  financialItemLabel,
  financialSourceKind,
  financialSourceLabel,
  isCumulativePeriod,
  isDerivedFact,
} from "./format";

function fact(overrides: Partial<FinancialFactView> = {}): FinancialFactView {
  return {
    id: "f1",
    companyId: "c1",
    statement: "income",
    item: "revenue",
    periodKind: "annual",
    periodEnd: "2025-12-31",
    value: 100,
    unit: "currency",
    currency: "USD",
    method: "xbrl",
    sourceRefs: [],
    ...overrides,
  };
}

describe("financial cell labels", () => {
  it("labels every canonical item instead of raw snake_case", () => {
    for (const item of FIN_ITEM_ORDER) {
      const label = financialItemLabel(item, "zh");
      expect(label).not.toContain("_");
      expect(label.length).toBeGreaterThan(0);
      expect(financialItemLabel(item, "en")).not.toContain("_");
    }
  });

  it("marks calculated cells from the 计算： quote", () => {
    expect(isDerivedFact(fact({ quote: "计算：总资产 - 股东权益（1 - 2）" }))).toBe(
      true,
    );
    expect(isDerivedFact(fact({ quote: " Liabilities 2025-12-31: 1" }))).toBe(false);
    expect(isDerivedFact(fact({}))).toBe(false);
  });

  it("names the filing form, F10 and profile sources", () => {
    const sec = fact({
      source: {
        id: "1",
        url: "https://www.sec.gov/x",
        title: "SEC 10-K filed 2025-10-31",
        trustTier: "filing",
      },
    });
    expect(financialSourceKind(sec)).toBe("sec");
    expect(financialSourceLabel(sec, "zh")).toBe("SEC 10-K");

    const edgar = fact({
      source: { id: "2", url: "https://data.sec.gov/x", trustTier: "filing" },
    });
    expect(financialSourceLabel(edgar, "en")).toBe("SEC EDGAR");

    const f10 = fact({ method: "f10" });
    expect(financialSourceKind(f10)).toBe("f10");
    expect(financialSourceLabel(f10, "zh")).toBe("东方财富 F10");
    expect(financialSourceLabel(f10, "en")).toBe("Eastmoney F10");

    const profile = fact({ method: "deterministic_table_v1" });
    expect(financialSourceLabel(profile, "zh")).toBe("研究资料");
  });

  it("flags year-to-date quarters but not true quarters", () => {
    // A-share 三季报: cumulative from January.
    expect(
      isCumulativePeriod(
        fact({ periodKind: "quarter", periodStart: "2026-01-01", periodEnd: "2026-09-30" }),
      ),
    ).toBe(true);
    // US 10-Q: a ~90-day quarter.
    expect(
      isCumulativePeriod(
        fact({ periodKind: "quarter", periodStart: "2026-03-29", periodEnd: "2026-06-27" }),
      ),
    ).toBe(false);
    expect(
      isCumulativePeriod(
        fact({ periodKind: "annual", periodStart: "2025-01-01", periodEnd: "2025-12-31" }),
      ),
    ).toBe(false);
  });
});

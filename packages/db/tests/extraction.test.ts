import { describe, expect, it } from "vitest";

import {
  canonicalizeUrl,
  factId,
  financialFactId,
  relationId,
  reviewItemId,
  stableJson,
  trustTierForUrl,
} from "../src/repositories/extraction.js";

describe("deterministic extraction ids", () => {
  it("builds the same financial fact id for the same period", () => {
    const base = {
      companyId: "c_aapl",
      statement: "income",
      item: "revenue",
      periodEnd: "2025-09-27",
    };
    expect(financialFactId(base)).toBe(financialFactId({ ...base }));
    expect(financialFactId(base)).not.toBe(
      financialFactId({ ...base, item: "net_income" }),
    );
    // FY2026 and Q4 FY2026 can share a period end; periodKind keeps them apart.
    expect(financialFactId({ ...base, periodKind: "annual" })).not.toBe(
      financialFactId({ ...base, periodKind: "quarter" }),
    );
  });

  it("is insensitive to object key order in fact values", () => {
    const a = factId({
      companyId: "c",
      predicate: "market_cap",
      value: { value: 1, currency: "USD" },
    });
    const b = factId({
      companyId: "c",
      predicate: "market_cap",
      value: { currency: "USD", value: 1 },
    });
    expect(a).toBe(b);
    expect(stableJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(
      stableJson({ a: [2, { c: 4, d: 3 }], b: 1 }),
    );
  });

  it("changes the relation id when the quote changes", () => {
    const base = {
      srcCompanyId: "c_aapl",
      dstCompanyId: "c_googl",
      type: "buys_from",
      quote: "Google/Alphabet 是模型供应商",
    };
    expect(relationId(base)).toBe(relationId({ ...base }));
    expect(relationId(base)).not.toBe(relationId({ ...base, quote: "other" }));
  });

  it("derives a stable review id from the dedupe key", () => {
    expect(reviewItemId("relation:rel_1")).toBe(reviewItemId("relation:rel_1"));
    expect(reviewItemId("relation:rel_1")).not.toBe(
      reviewItemId("relation:rel_2"),
    );
  });
});

describe("citation normalization", () => {
  it("drops tracking params but keeps F10 fragments", () => {
    expect(
      canonicalizeUrl("https://example.com/a?utm_source=x&id=7&trk=abc#/cwfx"),
    ).toBe("https://example.com/a?id=7#/cwfx");
  });

  it("maps regulator, F10 and media domains to trust tiers", () => {
    expect(trustTierForUrl("https://www.sec.gov/Archives/x")).toBe("official");
    expect(trustTierForUrl("https://www.cninfo.com.cn/x")).toBe("official");
    expect(trustTierForUrl("https://stockanalysis.com/stocks/aapl/")).toBe(
      "secondary",
    );
    expect(trustTierForUrl("https://emweb.eastmoney.com/x")).toBe("secondary");
    expect(trustTierForUrl("https://www.thehindu.com/business/x")).toBe("media");
  });
});

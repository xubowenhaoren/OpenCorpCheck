import { describe, expect, it } from "vitest";

import {
  buildNameIndex,
  matchName,
  normalizeMatchName,
} from "../src/matching.js";

const companies = [
  {
    companyId: "c_blackrock",
    names: ["BlackRock, Inc.", "BLK"],
  },
  {
    companyId: "c_bny",
    names: ["Bank of New York Mellon Corp", "BNY"],
  },
  {
    companyId: "c_china_mobile",
    names: ["China Mobile", "中国移动"],
  },
  {
    companyId: "c_ambiguous_a",
    names: ["Shared Name Inc"],
  },
  {
    companyId: "c_ambiguous_b",
    names: ["Shared Name Corp"],
  },
];

describe("ownership name matching", () => {
  it("collapses legal suffixes and a leading article", () => {
    expect(normalizeMatchName("The Bank of New York Mellon Corporation")).toBe(
      "bankofnewyorkmellon",
    );
    expect(normalizeMatchName("JPMORGAN CHASE & CO")).toBe("jpmorganchaseand");
  });

  it("matches an exact normalized company name", () => {
    const index = buildNameIndex(companies);
    expect(
      matchName(index, "The Bank of New York Mellon Corporation"),
    ).toMatchObject({ companyId: "c_bny", ambiguous: false });
    expect(matchName(index, "BlackRock, Inc.")).toMatchObject({
      companyId: "c_blackrock",
      ambiguous: false,
    });
  });

  it("does not merge a parent group into the listed subsidiary", () => {
    const index = buildNameIndex(companies);
    expect(
      matchName(index, "China Mobile Communications Group Co., Ltd."),
    ).toEqual({ ambiguous: false });
    expect(matchName(index, "China Mobile (Hong Kong) Group Limited")).toEqual({
      ambiguous: false,
    });
  });

  it("reports a name shared by two companies as ambiguous", () => {
    const index = buildNameIndex(companies);
    expect(matchName(index, "Shared Name Limited")).toEqual({ ambiguous: true });
  });
});

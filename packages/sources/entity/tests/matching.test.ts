import { describe, expect, it } from "vitest";

import {
  isGleifResolution,
  matchGleifLei,
  type GleifRecord,
} from "../src/gleif.js";
import {
  isWikidataResolution,
  matchWikidataQid,
  type WikidataCandidate,
} from "../src/wikidata.js";

function record(overrides: Partial<GleifRecord> & { lei: string; legalName: string }): GleifRecord {
  return {
    otherNames: [],
    status: "ACTIVE",
    category: "GENERAL",
    ...overrides,
  };
}

describe("matchGleifLei", () => {
  it("accepts a unique exact legal-name match", () => {
    const result = matchGleifLei(
      [record({ lei: "HWUPKR0MPOU8FGXBT394", legalName: "Apple Inc.", country: "US" })],
      ["Apple Inc."],
    );
    expect(isGleifResolution(result)).toBe(true);
    if (isGleifResolution(result)) {
      expect(result.lei).toBe("HWUPKR0MPOU8FGXBT394");
      expect(result.rule).toBe("exact-legal-name");
    }
  });

  it("ignores branches and inactive records", () => {
    const result = matchGleifLei(
      [
        record({
          lei: "BRANCH0000000000001",
          legalName: "中国工商银行股份有限公司",
          category: "BRANCH",
        }),
        record({
          lei: "INACTIVE000000000002",
          legalName: "中国工商银行股份有限公司",
          status: "INACTIVE",
        }),
        record({
          lei: "5493002ERZU2K9PZDL40",
          legalName: "中国工商银行股份有限公司",
          country: "CN",
        }),
      ],
      ["中国工商银行股份有限公司"],
    );
    expect(isGleifResolution(result)).toBe(true);
    if (isGleifResolution(result)) {
      expect(result.lei).toBe("5493002ERZU2K9PZDL40");
    }
  });

  it("matches a registered other name", () => {
    const result = matchGleifLei(
      [
        record({
          lei: "5493006MHB84DD0ZWV18",
          legalName: "ALPHABET INC.",
          otherNames: ["Google Inc."],
          country: "US",
        }),
      ],
      ["Google Inc."],
    );
    expect(isGleifResolution(result)).toBe(true);
    if (isGleifResolution(result)) {
      expect(result.rule).toBe("exact-other-name");
    }
  });

  it("returns an ambiguity instead of guessing", () => {
    const result = matchGleifLei(
      [
        record({ lei: "AAAAAAAAAAAAAAAAAAAA", legalName: "Same Name Co", country: "US" }),
        record({ lei: "BBBBBBBBBBBBBBBBBBBB", legalName: "Same Name Co.", country: "US" }),
      ],
      ["Same Name Co"],
    );
    expect(result && "candidates" in result).toBe(true);
  });

  it("returns null when no exact name matches", () => {
    const result = matchGleifLei(
      [record({ lei: "CCCCCCCCCCCCCCCCCCCC", legalName: "Different Co", country: "US" })],
      ["Target Co"],
    );
    expect(result).toBeNull();
  });
});

describe("matchWikidataQid", () => {
  it("accepts a unique exact company label", () => {
    const result = matchWikidataQid(
      [
        {
          qid: "Q312",
          label: "Apple Inc.",
          description: "American multinational technology company",
        },
      ],
      ["Apple Inc."],
    );
    expect(isWikidataResolution(result)).toBe(true);
    if (isWikidataResolution(result)) expect(result.qid).toBe("Q312");
  });

  it("rejects an exact label that is not a company", () => {
    const result = matchWikidataQid(
      [{ qid: "Q89", label: "Apple", description: "fruit of the apple tree" }],
      ["Apple"],
    );
    expect(result).toBeNull();
    const withSuffix = matchWikidataQid(
      [{ qid: "Q89", label: "Apple", description: "fruit of the apple tree" }],
      ["Apple Inc."],
    );
    expect(withSuffix).toBeNull();
  });

  it("matches a label that drops the corporate suffix", () => {
    const result = matchWikidataQid(
      [{ qid: "Q165274", label: "Adobe", description: "American software company" }],
      ["Adobe Inc."],
    );
    expect(isWikidataResolution(result)).toBe(true);
    if (isWikidataResolution(result)) expect(result.qid).toBe("Q165274");
  });

  it("matches a label that drops Holdings", () => {
    const result = matchWikidataQid(
      [{ qid: "Q190464", label: "HSBC", description: "British bank" }],
      ["HSBC Holdings plc"],
    );
    expect(isWikidataResolution(result)).toBe(true);
    if (isWikidataResolution(result)) expect(result.qid).toBe("Q190464");
  });

  it("returns an ambiguity when two company items share the label", () => {
    const candidates: WikidataCandidate[] = [
      { qid: "Q1", label: "Example", description: "American company" },
      { qid: "Q2", label: "Example", description: "Chinese company" },
    ];
    const result = matchWikidataQid(candidates, ["Example"]);
    expect(result && "candidates" in result).toBe(true);
  });
});

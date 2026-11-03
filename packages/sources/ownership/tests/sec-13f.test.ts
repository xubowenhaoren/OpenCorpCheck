import { describe, expect, it } from "vitest";

import { buildNameIndex } from "../src/matching.js";
import {
  parseThirteenFCoverPages,
  parseThirteenFHoldings,
  parseThirteenFSubmissions,
  ThirteenFPlanner,
  toIsoDate,
} from "../src/sec-13f.js";

const submissionTsv = [
  "ACCESSION_NUMBER\tFILING_DATE\tSUBMISSIONTYPE\tCIK\tPERIODOFREPORT",
  "0000000001-26-000001\t14-FEB-2026\t13F-HR\t0000000001\t31-DEC-2025",
  "0000000001-26-000002\t15-MAY-2026\t13F-HR\t0000000001\t31-MAR-2026",
  "0000000002-26-000003\t15-MAY-2026\t13F-HR/A\t0000000002\t31-MAR-2026",
  "0000000003-26-000004\t15-MAY-2026\t13F-NT\t0000000003\t31-MAR-2026",
].join("\n");

const coverTsv = [
  "ACCESSION_NUMBER\tFILINGMANAGER_NAME",
  "0000000001-26-000001\tBlackRock, Inc.",
  "0000000001-26-000002\tBlackRock, Inc.",
  "0000000002-26-000003\tOther Manager LLC",
].join("\n");

const infoTsv = [
  "ACCESSION_NUMBER\tNAMEOFISSUER\tTITLEOFCLASS\tCUSIP\tVALUE\tSSHPRNAMT\tSSHPRNAMTTYPE\tPUTCALL",
  "0000000001-26-000001\tAPPLE INC\tCOM\t037833100\t1000\t100\tSH\t",
  "0000000001-26-000002\tAPPLE INC\tCOM\t037833100\t2000\t200\tSH\t",
  "0000000001-26-000002\tALPHABET INC\tCL A\t02079K305\t500\t50\tSH\t",
  "0000000001-26-000002\tALPHABET INC\tCL C\t02079K107\t300\t30\tSH\t",
  "0000000001-26-000002\tAPPLE INC\tCOM\t037833100\t9999\t999\tSH\tCALL",
  "0000000001-26-000002\tAPPLE INC\tNOTE\t037833100\t9999\t999\tPRN\t",
  "0000000002-26-000003\tAPPLE INC\tCOM\t037833100\t9999\t999\tSH\t",
].join("\n");

describe("13F parsing", () => {
  it("parses SEC dataset dates", () => {
    expect(toIsoDate("31-MAR-2026")).toBe("2026-03-31");
    expect(toIsoDate("2026-03-31")).toBe("2026-03-31");
    expect(toIsoDate("03/31/2026")).toBeNull();
  });

  it("resolves columns by header, not position", () => {
    expect(parseThirteenFSubmissions(submissionTsv)).toHaveLength(4);
    expect(parseThirteenFCoverPages(coverTsv).get("0000000001-26-000002")).toBe(
      "BlackRock, Inc.",
    );
    expect(parseThirteenFHoldings(infoTsv)).toHaveLength(7);
  });
});

describe("13F ownership planner", () => {
  function planner() {
    return new ThirteenFPlanner({
      filerByCik: new Map([["0000000001", "c_blackrock"]]),
      filerByName: buildNameIndex([
        { companyId: "c_blackrock", names: ["BlackRock, Inc."] },
      ]),
      issuerByCusip: new Map([
        ["037833100", "c_apple"],
        ["02079K305", "c_alphabet"],
        ["02079K107", "c_alphabet"],
      ]),
      issuerByName: buildNameIndex([
        { companyId: "c_apple", names: ["Apple Inc."] },
      ]),
    });
  }

  it("uses only 13F-HR, keeps the latest period, and sums share classes", () => {
    const plan = planner();
    const submissions = parseThirteenFSubmissions(submissionTsv);
    const covers = parseThirteenFCoverPages(coverTsv);
    for (const row of submissions) {
      if (row.submissionType !== "13F-HR") continue;
      plan.addFiling({
        accession: row.accession,
        cik: row.cik,
        period: row.period,
        filingDate: row.filingDate,
        managerName: covers.get(row.accession) ?? "",
      });
    }
    for (const row of parseThirteenFHoldings(infoTsv)) {
      plan.addHolding(row);
    }
    const result = plan.finish();
    expect(result.edges).toHaveLength(2);
    const apple = result.edges.find((edge) => edge.dstCompanyId === "c_apple")!;
    // Latest period only: the Q4 row (1000/100) is replaced, not summed.
    expect(apple.amount).toBe(2000);
    expect(apple.metadata.shares).toBe(200);
    expect(apple.validFrom).toBe("2026-03-31");
    expect(apple.quote).toContain("CUSIP 037833100");
    expect(apple.quote).toContain("accession 0000000001-26-000002");
    const alphabet = result.edges.find(
      (edge) => edge.dstCompanyId === "c_alphabet",
    )!;
    // Two share classes of one issuer aggregate into one edge.
    expect(alphabet.metadata.shares).toBe(80);
    expect(alphabet.amount).toBe(800);
    expect(result.stats.optionRows).toBe(1);
    expect(result.stats.nonShareRows).toBe(1);
    expect(result.stats.holders).toBe(1);
    expect(result.stats.filings).toBe(2);
    expect(result.stats.filingsMatched).toBe(2);
  });

  it("falls back to an exact manager name when the CIK is unknown", () => {
    const plan = planner();
    plan.addFiling({
      accession: "acc-name",
      cik: "9999999999",
      period: "30-JUN-2026",
      filingDate: "14-AUG-2026",
      managerName: "BlackRock, Inc.",
    });
    plan.addHolding({
      accession: "acc-name",
      issuerName: "APPLE INC",
      cusip: "037833100",
      value: 10,
      shares: 1,
      shareType: "SH",
      putCall: "",
    });
    const result = plan.finish();
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]!.metadata.holderMatchedBy).toBe("name");
    expect(result.edges[0]!.srcCompanyId).toBe("c_blackrock");
  });

  it("never creates an edge for an issuer outside the universe", () => {
    const plan = planner();
    plan.addFiling({
      accession: "acc",
      cik: "0000000001",
      period: "01-JAN-2026",
      filingDate: "2026-03-31",
      managerName: "BlackRock, Inc.",
    });
    plan.addHolding({
      accession: "acc",
      issuerName: "Unknown Corp",
      cusip: "999999999",
      value: 10,
      shares: 1,
      shareType: "SH",
      putCall: "",
    });
    const result = plan.finish();
    expect(result.edges).toHaveLength(0);
    expect(result.stats.unmatchedIssuerCusips).toBe(1);
  });
});

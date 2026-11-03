import { describe, expect, it } from "vitest";

import { buildNameIndex } from "../src/matching.js";
import {
  parseDionEventDate,
  parseDionLongPercent,
  parseDionLongShares,
  planDionOwnership,
  type DionNotice,
} from "../src/hkex-dion.js";

function index() {
  return buildNameIndex([
    { companyId: "c_blackrock", names: ["BlackRock, Inc."] },
    { companyId: "c_jpm", names: ["JPMorgan Chase & Co."] },
    { companyId: "c_mobile", names: ["China Mobile"] },
  ]);
}

describe("DION field parsing", () => {
  it("takes the long position from a multi-line cell", () => {
    expect(parseDionLongPercent("6.37(L)\n3.36(S)\n2.82(P)")).toBe(6.37);
    expect(parseDionLongShares("1,093,870,212(L)\n575,953,952(S)")).toBe(
      1_093_870_212,
    );
  });

  it("does not treat a short-only notice as ownership", () => {
    expect(parseDionLongPercent("3.36(S)")).toBeNull();
    expect(parseDionLongShares("575,953,952(S)")).toBeNull();
  });

  it("parses dd/mm/yyyy event dates", () => {
    expect(parseDionEventDate("28/10/2026")).toBe("2026-10-28");
    expect(parseDionEventDate("2026-10-28")).toBe("2026-10-28");
  });
});

describe("DION ownership planner", () => {
  const notices: DionNotice[] = [
    {
      serial: "CS20261031E00038",
      shareholder: "BlackRock, Inc.",
      percent: "6.76(L)\n0.08(S)",
      holdings: "503,702,863(L)\n6,255,900(S)",
      event_date: "28/10/2026",
      reason_code: "1314(L)",
      url: "https://di.hkex.com.hk/di/NSForm2.aspx?fn=CS20261031E00038",
    },
    {
      serial: "CS20261030E00037",
      shareholder: "BlackRock, Inc.",
      percent: "6.74(L)",
      holdings: "502,232,229(L)",
      event_date: "26/10/2026",
      reason_code: "1314(L)",
      url: "https://di.hkex.com.hk/di/NSForm2.aspx?fn=CS20261030E00037",
    },
    {
      serial: "CS20261030E00348",
      shareholder: "JPMorgan Chase & Co.",
      percent: "3.36(L)\n2.10(S)",
      holdings: "474,082,842(L)",
      event_date: "27/10/2026",
      reason_code: "14015(S)",
      url: "https://di.hkex.com.hk/di/NSForm2.aspx?fn=CS20261030E00348",
    },
    {
      serial: "CS20251203E00252",
      shareholder: "China Mobile Communications Group Co., Ltd.",
      percent: "68.99(L)",
      holdings: "14,932,483,842(L)",
      event_date: "02/12/2025",
      url: "https://di.hkex.com.hk/di/NSForm2.aspx?fn=CS20251203E00252",
    },
  ];

  it("keeps the latest notice per holder and never creates companies", () => {
    const plan = planDionOwnership({
      issuerCompanyId: "c_pingan",
      issuerCode: "02318",
      issuerName: "Ping An Insurance",
      notices,
      holderByName: index(),
    });
    expect(plan.edges).toHaveLength(2);
    const blackrock = plan.edges.find(
      (edge) => edge.srcCompanyId === "c_blackrock",
    )!;
    expect(blackrock.type).toBe("invests_in");
    expect(blackrock.quote).toContain("6.76%");
    expect(blackrock.quote).toContain("CS20261031E00038");
    expect(blackrock.metadata.percent).toBe(6.76);
    expect(blackrock.metadata.shares).toBe(503_702_863);
    expect(blackrock.validFrom).toBe("2026-10-28");
    const jpm = plan.edges.find((edge) => edge.srcCompanyId === "c_jpm")!;
    expect(jpm.quote).toContain("3.36%");
    // China Mobile Communications Group is a parent, not the listed company.
    expect(plan.stats.holdersUnmatched).toBe(1);
    expect(plan.stats.edges).toBe(2);
  });

  it("skips a holder that is the issuer itself", () => {
    const plan = planDionOwnership({
      issuerCompanyId: "c_blackrock",
      issuerCode: "00005",
      issuerName: "BlackRock",
      notices,
      holderByName: index(),
    });
    expect(plan.stats.selfNotices).toBe(2);
    expect(plan.edges.map((edge) => edge.srcCompanyId)).not.toContain(
      "c_blackrock",
    );
  });

  it("does not use the transaction size as the after-event position", () => {
    const plan = planDionOwnership({
      issuerCompanyId: "c_pingan",
      issuerCode: "02318",
      issuerName: "Ping An Insurance",
      notices: [
        {
          serial: "CS20261031E00099",
          shareholder: "BlackRock, Inc.",
          percent: "5.10(L)",
          shares: "100,000(L)",
          holdings: null,
          event_date: "30/10/2026",
        },
      ],
      holderByName: index(),
    });
    expect(plan.edges).toHaveLength(1);
    expect(plan.edges[0]!.metadata.shares).toBeNull();
  });
});

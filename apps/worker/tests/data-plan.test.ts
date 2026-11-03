import { describe, expect, it } from "vitest";

import type { EntityCompany, FilingStateSnapshot } from "@occ/db";

import {
  candidatesForCompany,
  dataCheckWindow,
  planFilingChecks,
} from "../src/data/plan.js";

function company(partial: Partial<EntityCompany>): EntityCompany {
  return {
    id: "US:AAPL",
    slug: "aapl",
    displayName: "Apple Inc.",
    legalName: "Apple Inc.",
    country: "US",
    coverageTier: "index_member",
    sector: "信息技术",
    profile: {},
    isFixture: false,
    securities: [],
    identifiers: [],
    aliases: [],
    aliasEntries: [],
    ...partial,
  };
}

function state(
  partial: Partial<FilingStateSnapshot> & {
    companyId: string;
    source: string;
  },
): FilingStateSnapshot {
  return {
    market: "US",
    code: null,
    cursor: null,
    lastCheckedAt: null,
    lastChangedAt: null,
    lastStatus: "never",
    nextDueAt: null,
    consecutiveFailures: 0,
    ...partial,
  };
}

describe("filing source candidates", () => {
  it("uses EDGAR for a US company with a CIK", () => {
    const out = candidatesForCompany(
      company({
        securities: [
          { ticker: "AAPL", exchange: "NASDAQ", currency: "USD" },
        ],
        identifiers: [{ idType: "cik", idValue: "0000320193" }],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source: "edgar",
      market: "US",
      ticker: "AAPL",
      code: "AAPL",
      cik: "0000320193",
    });
  });

  it("skips a US company with no CIK", () => {
    const out = candidatesForCompany(
      company({
        securities: [
          { ticker: "PRIV", exchange: "NYSE", currency: "USD" },
        ],
      }),
    );
    expect(out).toHaveLength(0);
  });

  it("uses CNINFO for SSE/SZSE and HKEXnews for HKEX", () => {
    const a = candidatesForCompany(
      company({
        id: "A:600519",
        coverageTier: "index_member",
        securities: [{ ticker: "600519", exchange: "SSE", currency: "CNY" }],
        identifiers: [{ idType: "ticker", idValue: "600519" }],
      }),
    );
    expect(a[0]).toMatchObject({
      source: "cninfo",
      market: "A",
      code: "600519",
    });

    const hk = candidatesForCompany(
      company({
        id: "HK:00700",
        securities: [{ ticker: "00700", exchange: "HKEX", currency: "HKD" }],
      }),
    );
    expect(hk[0]).toMatchObject({
      source: "hkexnews",
      market: "HK",
      code: "00700",
    });
  });

  it("keeps both legs of a dual-listed A/HK company", () => {
    const out = candidatesForCompany(
      company({
        id: "HK:02318",
        securities: [
          { ticker: "02318", exchange: "HKEX", currency: "HKD" },
          { ticker: "601318", exchange: "SSE", currency: "CNY" },
        ],
      }),
    );
    expect(out.map((entry) => entry.source).sort()).toEqual([
      "cninfo",
      "hkexnews",
    ]);
  });

  it("falls back to F10 only when no official feed exists", () => {
    const out = candidatesForCompany(
      company({
        id: "A:830799",
        securities: [{ ticker: "830799", exchange: "BSE", currency: "CNY" }],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source: "f10",
      market: "A",
      code: "830799",
    });
  });

  it("never plans a stub", () => {
    const out = candidatesForCompany(
      company({
        coverageTier: "stub",
        securities: [
          { ticker: "AAPL", exchange: "NASDAQ", currency: "USD" },
        ],
        identifiers: [{ idType: "cik", idValue: "0000320193" }],
      }),
    );
    expect(out).toHaveLength(0);
  });
});

describe("planFilingChecks", () => {
  const now = new Date("2026-11-03T08:00:00.000Z");
  const apple = company({
    id: "US:AAPL",
    securities: [
      { ticker: "AAPL", exchange: "NASDAQ", currency: "USD" },
    ],
    identifiers: [{ idType: "cik", idValue: "0000320193" }],
  });

  it("includes a company without state and excludes a live lease", () => {
    const due = planFilingChecks([apple], new Map(), { now });
    expect(due).toHaveLength(1);
    expect(due[0]?.source).toBe("edgar");

    const leased = new Map([
      [
        "US:AAPL:edgar",
        state({
          companyId: "US:AAPL",
          source: "edgar",
          nextDueAt: new Date("2026-11-03T08:30:00.000Z"),
        }),
      ],
    ]);
    expect(planFilingChecks([apple], leased, { now })).toHaveLength(0);
  });

  it("returns a past-due state and carries its cursor", () => {
    const due = planFilingChecks(
      [apple],
      new Map([
        [
          "US:AAPL:edgar",
          state({
            companyId: "US:AAPL",
            source: "edgar",
            cursor: "0000320193-26-000024",
            lastCheckedAt: new Date("2026-11-02T08:00:00.000Z"),
            nextDueAt: new Date("2026-11-03T07:00:00.000Z"),
          }),
        ],
      ]),
      { now },
    );
    expect(due).toHaveLength(1);
    expect(due[0]?.cursor).toBe("0000320193-26-000024");
  });

  it("honours company/source filters and the limit", () => {
    const dual = company({
      id: "HK:02318",
      securities: [
        { ticker: "02318", exchange: "HKEX", currency: "HKD" },
        { ticker: "601318", exchange: "SSE", currency: "CNY" },
      ],
    });
    const filtered = planFilingChecks([apple, dual], new Map(), {
      now,
      companyIds: new Set(["HK:02318"]),
      sources: new Set(["cninfo"]),
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.source).toBe("cninfo");

    expect(planFilingChecks([apple, dual], new Map(), { now, limit: 1 }))
      .toHaveLength(1);
  });
});

describe("dataCheckWindow", () => {
  const now = new Date("2026-11-03T08:00:00.000Z");
  const options = { coldDays: 30, maxDays: 30 };

  it("uses the cold window on the first check", () => {
    const window = dataCheckWindow(null, now, options);
    expect(window.sinceDays).toBe(30);
    expect(window.since.toISOString()).toBe("2026-10-04T08:00:00.000Z");
  });

  it("looks back to the previous check plus two days", () => {
    const oneHourAgo = new Date(now.getTime() - 3_600_000);
    expect(dataCheckWindow(oneHourAgo, now, options).sinceDays).toBe(3);
    const tenDaysAgo = new Date(now.getTime() - 10 * 86_400_000);
    expect(dataCheckWindow(tenDaysAgo, now, options).sinceDays).toBe(12);
  });

  it("caps a long outage at maxDays", () => {
    const old = new Date(now.getTime() - 100 * 86_400_000);
    expect(dataCheckWindow(old, now, options).sinceDays).toBe(30);
  });
});

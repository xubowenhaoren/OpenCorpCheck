import { describe, expect, it } from "vitest";

import {
  financialsPeriodCovered,
  financialsVerification,
} from "../src/data/verify.js";

const NOW = new Date("2026-11-03T12:00:00.000Z");

describe("financials verification (P1.5 follow-up)", () => {
  it("treats a 52/53-week period end as covered", () => {
    expect(financialsPeriodCovered("2026-09-30", "2026-09-26")).toBe(true);
    expect(financialsPeriodCovered("2026-12-31", "2026-12-27")).toBe(true);
  });

  it("does not accept the previous quarter", () => {
    expect(financialsPeriodCovered("2026-09-30", "2026-06-30")).toBe(false);
    expect(financialsPeriodCovered("2026-09-30", null)).toBe(false);
  });

  it("marks a covered expected period applied", () => {
    const result = financialsVerification({
      expectedPeriodEnd: "2026-09-30",
      maxPeriodEnd: "2026-09-30",
      attempts: 2,
      firstSeenAt: new Date("2026-11-01T12:00:00.000Z"),
      now: NOW,
      maxDays: 7,
    });
    expect(result).toMatchObject({
      status: "applied",
      covered: true,
      nextRetryAt: null,
      attempts: 2,
    });
  });

  it("backs off 1h, then 6h, then daily while F10 lags", () => {
    const base = {
      expectedPeriodEnd: "2026-09-30",
      maxPeriodEnd: "2026-06-30",
      firstSeenAt: new Date("2026-11-03T00:00:00.000Z"),
      now: NOW,
      maxDays: 7,
    };
    const first = financialsVerification({ ...base, attempts: 0 });
    expect(first.status).toBe("pending");
    expect(first.nextRetryAt?.toISOString()).toBe("2026-11-03T13:00:00.000Z");

    const second = financialsVerification({ ...base, attempts: 1 });
    expect(second.nextRetryAt?.toISOString()).toBe("2026-11-03T18:00:00.000Z");

    const third = financialsVerification({ ...base, attempts: 2 });
    expect(third.nextRetryAt?.toISOString()).toBe("2026-11-04T12:00:00.000Z");
  });

  it("gives up after maxDays instead of retrying forever", () => {
    const result = financialsVerification({
      expectedPeriodEnd: "2026-09-30",
      maxPeriodEnd: null,
      attempts: 9,
      firstSeenAt: new Date("2026-10-20T12:00:00.000Z"),
      now: NOW,
      maxDays: 7,
    });
    expect(result.status).toBe("failed");
    expect(result.nextRetryAt).toBeNull();
  });

  it("fails when the next retry would land past the deadline", () => {
    const result = financialsVerification({
      expectedPeriodEnd: "2026-09-30",
      maxPeriodEnd: null,
      attempts: 0,
      firstSeenAt: new Date("2026-11-02T20:00:00.000Z"),
      now: new Date("2026-11-03T19:30:00.000Z"),
      maxDays: 1,
    });
    expect(result.status).toBe("failed");
  });
});

import { describe, expect, it } from "vitest";

import type { FilingRefreshView } from "@occ/core";

import { filingStatus } from "./filing-status";

const t = (
  key: string,
  vars: Record<string, string | number> = {},
): string =>
  `${key}:${Object.entries(vars)
    .map(([name, value]) => `${name}=${value}`)
    .join(",")}`;

function view(partial: Partial<FilingRefreshView>): FilingRefreshView {
  return {
    lastStatus: "never",
    pending: false,
    consecutiveFailures: 0,
    sources: [],
    ...partial,
  };
}

describe("filingStatus", () => {
  it("returns null without refresh state", () => {
    expect(filingStatus(undefined, "zh", t)).toBeNull();
  });

  it("shows queued and retrying states, never success", () => {
    expect(
      filingStatus(view({ pending: true, lastStatus: "changed" }), "zh", t),
    ).toEqual({ text: "filing.pending:" });

    const failed = filingStatus(
      view({ lastStatus: "failed", pending: true, consecutiveFailures: 3 }),
      "zh",
      t,
    );
    expect(failed?.warn).toBe(true);
    expect(failed?.text).toContain("filing.retrying:count=3");

    const paused = filingStatus(
      view({ lastStatus: "paused", consecutiveFailures: 6 }),
      "en",
      t,
    );
    expect(paused?.warn).toBe(true);
  });

  it("shows the newest periodic report and update time", () => {
    const status = filingStatus(
      view({
        lastStatus: "changed",
        latest: {
          id: "fil_1",
          source: "edgar",
          title: "10-K",
          url: "https://example.com",
          status: "applied",
          form: "10-K",
          periodEnd: "2026-09-26",
          filedAt: new Date(Date.now() - 3_600_000).toISOString(),
        },
      }),
      "zh",
      t,
    );
    expect(status?.text).toContain(
      "filing.latest:period=2026-09-26,form=10-K",
    );
    expect(status?.text).toContain("filing.updated:time=");
    expect(status?.warn).toBeUndefined();
  });

  it("falls back to the filed date and checked-at line", () => {
    const filedOnly = filingStatus(
      view({
        latest: {
          id: "fil_1",
          source: "cninfo",
          title: "年度报告",
          url: "https://example.com",
          status: "applied",
          filedAt: "2026-10-31T00:00:00.000Z",
        },
      }),
      "zh",
      t,
    );
    expect(filedOnly?.text).toContain(
      "filing.latest:period=2026-10-31,form=定期报告",
    );

    const checked = filingStatus(
      view({
        lastStatus: "ok",
        lastCheckedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
      "en",
      t,
    );
    expect(checked?.text).toContain("filing.checked:time=");
  });

  it("says the check is automatic before the first run", () => {
    expect(filingStatus(view({ lastStatus: "never" }), "zh", t)).toEqual({
      text: "filing.never:",
    });
  });
});

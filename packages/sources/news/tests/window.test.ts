import { describe, expect, it } from "vitest";

import {
  NEWS_COLD_START_DAYS,
  NEWS_COLD_START_MAX_ITEMS,
  NEWS_STEADY_MAX_ITEMS,
  newsFetchWindow,
} from "../src/window.js";

const NOW = new Date("2026-11-01T12:00:00.000Z");

describe("newsFetchWindow", () => {
  it("uses the cold-start window when the company was never checked", () => {
    expect(newsFetchWindow({ now: NOW })).toEqual({
      sinceDays: NEWS_COLD_START_DAYS,
      maxItems: NEWS_COLD_START_MAX_ITEMS,
      coldStart: true,
    });
  });

  it("clamps a steady-state window to at least one day", () => {
    // ceil(30 min / 1 day) + 1 = 2 days; the clamp only matters for a run
    // that completed under a second ago.
    expect(
      newsFetchWindow({
        lastUpdateAt: "2026-11-01T11:30:00.000Z",
        now: NOW,
      }).sinceDays,
    ).toBe(2);
    expect(
      newsFetchWindow({
        lastUpdateAt: NOW.toISOString(),
        now: NOW,
      }).sinceDays,
    ).toBe(1);
    expect(
      newsFetchWindow({
        lastUpdateAt: "2026-11-01T11:30:00.000Z",
        now: NOW,
      }).maxItems,
    ).toBe(NEWS_STEADY_MAX_ITEMS);
  });

  it("uses the older of run time and newest article time", () => {
    // The feed's newest item is two days old although the run was an hour
    // ago: widen the window so late-indexed articles are not skipped.
    const window = newsFetchWindow({
      lastUpdateAt: "2026-11-01T11:00:00.000Z",
      newestPublishedAt: "2026-10-30T12:00:00.000Z",
      now: NOW,
    });
    expect(window.sinceDays).toBe(3);
    expect(window.coldStart).toBe(false);
  });

  it("never exceeds 30 days", () => {
    expect(
      newsFetchWindow({
        lastUpdateAt: "2026-01-01T00:00:00.000Z",
        now: NOW,
      }).sinceDays,
    ).toBe(30);
  });

  it("accepts string timestamps and ignores invalid values", () => {
    expect(
      newsFetchWindow({
        lastUpdateAt: "not-a-date",
        newestPublishedAt: "2026-10-31T12:00:00.000Z",
        now: NOW,
      }).sinceDays,
    ).toBe(2);
  });
});

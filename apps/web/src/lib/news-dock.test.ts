import { describe, expect, it } from "vitest";

import type { NewsSweepView } from "../api";
import {
  describeJob,
  describeSweep,
  formatElapsed,
  relativeFuture,
  relativePast,
  sweepPercent,
  sweepState,
} from "./news-dock";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const t = (key: string, vars?: Record<string, string | number>): string =>
  vars ? `${key}:${JSON.stringify(vars)}` : key;

function sweep(patch: Partial<NewsSweepView> = {}): NewsSweepView {
  return {
    runId: "run-1",
    status: "running",
    total: 10,
    done: 4,
    failed: 0,
    inserted: 12,
    skipped: 3,
    startedAt: "2026-11-01T11:58:00.000Z",
    finishedAt: null,
    elapsedMs: null,
    source: "auto",
    sweepSource: "ui",
    active: true,
    ...patch,
  };
}

describe("news dock helpers", () => {
  it("computes clamped progress", () => {
    expect(sweepPercent({ done: 4, total: 10 })).toBe(40);
    expect(sweepPercent({ done: 0, total: 0 })).toBe(0);
    expect(sweepPercent({ done: 99, total: 10 })).toBe(100);
  });

  it("maps run status to a display state", () => {
    expect(sweepState({ status: "running" })).toBe("running");
    expect(sweepState({ status: "queued" })).toBe("queued");
    expect(sweepState({ status: "partial" })).toBe("partial");
    expect(sweepState({ status: "failed" })).toBe("failed");
    expect(sweepState({ status: "completed" })).toBe("completed");
  });

  it("formats relative past time in both languages", () => {
    expect(relativePast("2026-11-01T11:59:30.000Z", "zh", NOW)).toBe("刚刚");
    expect(relativePast("2026-11-01T11:57:00.000Z", "zh", NOW)).toBe("3 分钟前");
    expect(relativePast("2026-11-01T09:00:00.000Z", "en", NOW)).toBe("3h ago");
    expect(relativePast(null, "zh", NOW)).toBe("尚未更新");
  });

  it("formats the next due time in the future", () => {
    expect(relativeFuture("2026-11-01T13:00:00.000Z", "zh", NOW)).toBe(
      "约 1 小时后",
    );
    expect(relativeFuture("2026-11-01T12:00:20.000Z", "en", NOW)).toBe(
      "any moment",
    );
  });

  it("formats elapsed run time", () => {
    expect(formatElapsed(42_000, "zh")).toBe("42 秒");
    expect(formatElapsed(185_000, "en")).toBe("3m 05s");
    expect(formatElapsed(3_720_000, "zh")).toBe("1 小时 02 分");
  });

  it("describes a sweep from its state", () => {
    expect(describeSweep(sweep(), "zh", t)).toContain("dock.running");
    expect(
      describeSweep(
        sweep({ status: "completed", active: false, inserted: 128 }),
        "zh",
        t,
      ),
    ).toContain('"count":128');
    expect(
      describeSweep(
        sweep({ status: "partial", active: false, failed: 2 }),
        "zh",
        t,
      ),
    ).toContain('"failed":2');
  });

  it("describes per-company job results", () => {
    expect(describeJob({ status: "completed", meta: { inserted: 8 } }, t)).toContain(
      '"count":8',
    );
    expect(describeJob({ status: "completed", meta: { inserted: 0 } }, t)).toBe(
      "dock.emptyFeed",
    );
    expect(describeJob({ status: "active" }, t)).toBe("dock.runningDetail");
    expect(describeJob({ status: "queued" }, t)).toBe("dock.queuedDetail");
    expect(describeJob({ status: "dead" }, t)).toBe("dock.failedDetail");
  });
});

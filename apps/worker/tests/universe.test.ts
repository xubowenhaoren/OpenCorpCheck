import { describe, expect, it } from "vitest";

import {
  filterShard,
  parseTicker,
  resolveTargets,
  shardOf,
} from "../src/universe.ts";

describe("parseTicker", () => {
  it.each([
    ["600519", "A:600519", "A", "600519"],
    ["600519:A", "A:600519", "A", "600519"],
    ["SH600519", "A:600519", "A", "600519"],
    ["00700", "HK:00700", "HK", "00700"],
    ["700:HK", "HK:00700", "HK", "00700"],
    ["02513.HK", "HK:02513", "HK", "02513"],
    ["AAPL", "US:AAPL", "US", "AAPL"],
    ["aapl", "US:AAPL", "US", "AAPL"],
    ["BRK.B", "US:BRK.B", "US", "BRK.B"],
  ])("parses %s", (input, key, market, code) => {
    const parsed = parseTicker(input);
    expect(parsed).toEqual({ key, ticker: code, market, code });
  });

  it("rejects empty and unsafe values", () => {
    expect(parseTicker("")).toBeNull();
    expect(parseTicker("../etc")).toBeNull();
  });
});

describe("resolveTargets", () => {
  it("dedupes explicit tickers and sorts by priority", async () => {
    const targets = await resolveTargets({ tickers: "AAPL,600519,AAPL" });
    expect(targets.map((target) => target.key)).toEqual(["A:600519", "US:AAPL"]);
    expect(targets.every((target) => target.priority === 50)).toBe(true);
  });

  it("loads the MAG7 universe with focus text", async () => {
    const targets = await resolveTargets({ universe: "mag7", limit: 3 });
    expect(targets).toHaveLength(3);
    expect(targets[0]!.priority).toBe(60);
    expect(targets.every((target) => target.focus)).toBe(true);
  });

  it("requires market+code when F10 is requested", async () => {
    const targets = await resolveTargets({
      universe: "ai-watchlist",
      requireF10: true,
    });
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((target) => target.market && target.code)).toBe(true);
    expect(targets.some((target) => target.key === "HK:02513")).toBe(true);
  });
});

describe("sharding", () => {
  it("is deterministic and splits a target list", async () => {
    const targets = await resolveTargets({ universe: "mag7" });
    const first = filterShard(targets, 0, 2);
    const second = filterShard(targets, 1, 2);
    expect(first.length + second.length).toBe(targets.length);
    for (const target of first) {
      expect(shardOf(target.key, 2)).toBe(0);
    }
    for (const target of second) {
      expect(shardOf(target.key, 2)).toBe(1);
    }
  });

  it("rejects invalid shards", async () => {
    const targets = await resolveTargets({ tickers: "AAPL" });
    expect(() => filterShard(targets, 2, 2)).toThrow();
    expect(() => filterShard(targets, 0, 0)).toThrow();
  });
});

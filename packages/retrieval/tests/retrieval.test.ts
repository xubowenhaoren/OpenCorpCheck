import { describe, expect, it } from "vitest";

import { dbsfFuse, rrfFuse } from "../src/fusion.js";
import { hashEmbed } from "../src/embedding.js";
import { toPointId } from "../src/qdrant.js";

describe("fusion", () => {
  it("RRF puts an item ranked highly by both branches first", () => {
    const fused = rrfFuse([
      [
        { id: "a", score: 10 },
        { id: "b", score: 8 },
      ],
      [
        { id: "b", score: 0.9 },
        { id: "c", score: 0.8 },
      ],
    ]);
    expect(fused[0].id).toBe("b");
    expect(fused[0].ranks).toEqual([2, 1]);
  });

  it("DBSF returns one score per id", () => {
    const fused = dbsfFuse([
      [
        { id: "a", score: 10 },
        { id: "b", score: 9 },
      ],
      [
        { id: "b", score: 0.9 },
        { id: "a", score: 0.1 },
      ],
    ]);
    expect(fused.map((item) => item.id).sort()).toEqual(["a", "b"]);
    expect(fused.every((item) => item.score >= 0 && item.score <= 1)).toBe(true);
  });
});

describe("hash embedding", () => {
  it("is deterministic, normalized, and the right dimension", () => {
    const a = hashEmbed("宁德时代 动力电池", 64);
    const b = hashEmbed("宁德时代 动力电池", 64);
    expect(a).toEqual(b);
    expect(a).toHaveLength(64);
    const norm = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 3);
  });
});

describe("point ids", () => {
  it("returns a stable UUID-shaped id", () => {
    const id = toPointId("cmp_宁德时代");
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(toPointId("cmp_宁德时代")).toBe(id);
  });
});

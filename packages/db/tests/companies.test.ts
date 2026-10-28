import { describe, expect, it } from "vitest";

import { cjkSimilarity } from "../src/repositories/companies.js";

describe("cjkSimilarity", () => {
  it("scores identical names as 1", () => {
    expect(cjkSimilarity("宁德时代", "宁德时代")).toBe(1);
  });

  it("ignores shared ASCII tokens when CJK differs", () => {
    // pg_trgm would score these as 1.0 because it only sees "ai".
    expect(cjkSimilarity("AI 芯片", "智谱AI")).toBe(0);
  });

  it("still catches a one-character typo", () => {
    expect(cjkSimilarity("宁得时代", "宁德时代")).toBeGreaterThan(0.3);
  });
});

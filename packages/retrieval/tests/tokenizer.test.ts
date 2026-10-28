import { describe, expect, it } from "vitest";

import { encodeSparse } from "../src/sparse.js";
import { normalizeText, tokenSet, tokenize } from "../src/tokenizer.js";

describe("tokenizer", () => {
  it("segments Chinese with jieba", () => {
    const tokens = tokenize("宁德时代的动力电池");
    expect(tokens).toContain("宁德");
    expect(tokens).toContain("时代");
    expect(tokens).toContain("电池");
  });

  it("stems English words", () => {
    const tokens = tokenize("running batteries companies");
    expect(tokens).toContain("run");
    expect(tokens).toContain("batteri");
    expect(tokens).toContain("compani");
  });

  it("normalizes full-width characters and case", () => {
    expect(normalizeText("ＡＩ 芯片")).toBe("ai 芯片");
    expect(tokenSet("AI 芯片")).toContain("ai");
  });

  it("drops stopwords and punctuation", () => {
    const tokens = tokenize("the AI 与 芯片 !!!");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("与");
    expect(tokens).toContain("ai");
  });
});

describe("sparse encoder", () => {
  it("is deterministic and sorted", () => {
    const a = encodeSparse("宁德时代 动力电池");
    const b = encodeSparse("宁德时代 动力电池");
    expect(a).toEqual(b);
    expect(a.indices).toEqual([...a.indices].sort((x, y) => x - y));
    expect(a.values.every((value) => value > 0)).toBe(true);
  });

  it("differs for different text", () => {
    const a = encodeSparse("宁德时代 动力电池");
    const b = encodeSparse("贵州茅台 白酒");
    expect(a.indices).not.toEqual(b.indices);
  });
});

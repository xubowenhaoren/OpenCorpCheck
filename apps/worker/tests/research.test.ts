import { describe, expect, it } from "vitest";

import { stripPreamble } from "../src/jobs/research.ts";

describe("stripPreamble", () => {
  it("drops text before the first profile heading", () => {
    const text =
      "I have sufficient evidence. Correction notes applied:\n- x\n\n## 腾讯控股（00700）\n### 1. 一句话\n...";
    expect(stripPreamble(text)).toBe(
      "## 腾讯控股（00700）\n### 1. 一句话\n...",
    );
  });

  it("keeps a profile that already starts with a heading", () => {
    const text = "## 苹果（AAPL）\n### 1. 一句话";
    expect(stripPreamble(text)).toBe(text);
  });

  it("does not lose text when there is no heading", () => {
    expect(stripPreamble("plain answer")).toBe("plain answer");
  });

  it("drops a trailing verification note after the sources", () => {
    const text =
      "## 腾讯控股（00700）\n### 13. 来源\n[1] x\n\n---\n\n**校验说明**：正文引用 18 条。";
    expect(stripPreamble(text)).toBe(
      "## 腾讯控股（00700）\n### 13. 来源\n[1] x",
    );
  });
});

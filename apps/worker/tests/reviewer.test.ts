import { describe, expect, it } from "vitest";

import {
  buildReviewPrompt,
  missingSections,
  parseReviewOutput,
} from "../src/research/reviewer.ts";

describe("review prompt", () => {
  it("includes the profile, the schema and the no-file-access rule", () => {
    const prompt = buildReviewPrompt({
      company: "Tencent",
      ticker: "00700",
      market: "HK",
      markdown: "## 腾讯控股（00700）\n### 1. 一句话\n腾讯做社交和游戏。[1]",
    });
    expect(prompt).toContain("腾讯控股");
    expect(prompt).toContain("verdict");
    expect(prompt).toContain("不要调用 bash");
    expect(prompt).toContain("=== 待审核 profile 开始 ===");
  });
});

describe("review output", () => {
  it("accepts the documented schema", () => {
    const result = parseReviewOutput(
      JSON.stringify({ verdict: "pass", issues: [], fix_instructions: "" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.verdict).toBe("pass");
  });

  it("normalises reject/passed/checklist shapes from reasoning models", () => {
    const result = parseReviewOutput(
      JSON.stringify({
        verdict: "reject",
        passed: false,
        checklist: [
          { id: "C01", status: "fail", finding: "缺少财务表" },
          { id: "C02", status: "pass", finding: "引用齐全" },
        ],
        summary: "重做第 5 节",
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.verdict).toBe("revise");
    expect(result.result.issues).toEqual([
      { field: "C01", reason: "缺少财务表" },
    ]);
    expect(result.result.fix_instructions).toBe("重做第 5 节");
  });

  it("accepts string issues and fenced JSON", () => {
    const result = parseReviewOutput(
      '```json\n{"verdict":"REVISE","issues":["营收错误"],"fix_instructions":"改正"}\n```',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.verdict).toBe("revise");
      expect(result.result.issues[0]).toEqual({
        field: "general",
        reason: "营收错误",
      });
    }
  });

  it("repairs raw double quotes inside JSON string values", () => {
    const raw = `{"verdict":"revise","issues":[{"field":"6. 质量快照","reason":"按 profile 口径，"资本开支上行是主因"不成立，会误导读者。","evidence":"原文：“FCF 趋势”"}],"fix_instructions":"改正"}`;
    const result = parseReviewOutput(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.verdict).toBe("revise");
    expect(result.result.issues).toHaveLength(1);
    expect(result.result.issues[0]?.reason).toContain("资本开支上行是主因");
  });

  it("still rejects a genuinely truncated object", () => {
    const result = parseReviewOutput(
      '{"verdict":"revise","issues":[{"field":"x","reason":"未闭合',
    );
    expect(result.ok).toBe(false);
  });

  it("returns an error when there is no verdict", () => {
    const result = parseReviewOutput('{"issues":["x"]}');
    expect(result.ok).toBe(false);
  });
});

describe("required sections", () => {
  it("finds missing chapter names", () => {
    expect(missingSections("### 1. 一句话\n### 13. 来源")).toContain("财务表现");
    expect(missingSections("### 1. 一句话\n### 13. 来源")).not.toContain("一句话");
  });
});

import { describe, expect, it } from "vitest";

import { parseReviewOutput } from "../src/research/reviewer.ts";
import {
  classifyIssue,
  decideReviewOutcome,
  planReviewRoute,
  type ReviewTaskIssue,
} from "../src/research/router.ts";

function issue(
  field: string,
  reason: string,
  kind?: string,
): ReviewTaskIssue {
  return {
    field,
    reason,
    kind: classifyIssue({ field, reason, kind }),
  };
}

describe("issue classification", () => {
  it("trusts a valid reviewer kind", () => {
    expect(classifyIssue({ field: "x", reason: "任意", kind: "financials" })).toBe(
      "financials",
    );
  });

  it.each([
    ["5. 财务表现", "FY2025 营收应为 416,161 百万美元，与来源不符", "financials"],
    ["来源", "公告文件 10-K 的链接打不开", "filings"],
    ["关键关系", "腾讯持股 30%，大股东信息有误", "ownership"],
    ["公司快照", "证券代码与上市地不一致", "entity"],
    ["一句话", "措辞过于主观", "profile"],
  ])("classifies %s from text", (field, reason, expected) => {
    expect(classifyIssue({ field, reason })).toBe(expected);
  });

  it("falls back to profile for unknown reviewer kinds", () => {
    expect(classifyIssue({ field: "一句话", reason: "太啰嗦", kind: "vibes" })).toBe(
      "profile",
    );
  });
});

describe("route planning", () => {
  it("routes profile issues to research and financials alongside it", () => {
    const plan = planReviewRoute({
      cycle: 0,
      issues: [
        issue("一句话", "措辞", "profile"),
        issue("财务表现", "营收错误", "financials"),
      ],
      fixInstructions: "修正",
    });
    expect(plan.run.map((action) => action.kind).sort()).toEqual([
      "financials",
      "profile",
    ]);
    expect(plan.deferred).toEqual([]);
  });

  it("runs only one deterministic worker per cycle and defers the rest", () => {
    const plan = planReviewRoute({
      cycle: 0,
      issues: [
        issue("财务表现", "营收错误", "financials"),
        issue("来源", "公告链接错误", "filings"),
      ],
      fixInstructions: "修正",
    });
    expect(plan.run.map((action) => action.kind)).toEqual(["financials"]);
    expect(plan.deferred).toEqual(["filings"]);
  });

  it("records operator commands for entity/ownership and runs nothing", () => {
    const plan = planReviewRoute({
      cycle: 0,
      issues: [
        issue("关键关系", "大股东持股比例错误", "ownership"),
        issue("公司快照", "上市地错误", "entity"),
      ],
      fixInstructions: "修正",
    });
    expect(plan.operatorOnly).toBe(true);
    expect(plan.run).toEqual([]);
    expect(plan.operator.map((action) => action.kind).sort()).toEqual([
      "entity",
      "ownership",
    ]);
    expect(
      plan.operator.find((action) => action.kind === "entity")?.instruction,
    ).toContain("entities");
    expect(
      plan.operator.find((action) => action.kind === "ownership")?.instruction,
    ).toContain("ownership sync");
  });
});

describe("review decision", () => {
  const base = {
    attempt: 0,
    maxCycles: 2,
    missingSections: [] as string[],
    fixInstructions: "修正",
  };

  it("passes a clean review", () => {
    const decision = decideReviewOutcome({
      ...base,
      verdict: "pass",
      issues: [],
    });
    expect(decision.kind).toBe("pass");
  });

  it("routes a mock reviewer's financials issue to the financials worker", () => {
    const parsed = parseReviewOutput(
      JSON.stringify({
        verdict: "revise",
        issues: [
          {
            field: "5. 财务表现",
            kind: "financial",
            reason: "FY2025 营收与 10-K 不一致",
            evidence: "https://example.com/10-k",
          },
        ],
        fix_instructions: "用结构化财报重写第 5 节",
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const decision = decideReviewOutcome({
      ...base,
      verdict: parsed.result.verdict,
      issues: parsed.result.issues,
      fixInstructions: parsed.result.fix_instructions,
    });
    expect(decision.kind).toBe("revise");
    if (decision.kind !== "revise") return;
    expect(decision.plan.run.map((action) => action.kind)).toEqual([
      "financials",
    ]);
    expect(decision.nextAttempt).toBe(1);
  });

  it("treats missing sections as a profile issue", () => {
    const decision = decideReviewOutcome({
      ...base,
      verdict: "pass",
      issues: [],
      missingSections: ["风险与反证"],
    });
    expect(decision.kind).toBe("revise");
    if (decision.kind !== "revise") return;
    expect(decision.issues[0]).toMatchObject({
      field: "章节",
      kind: "profile",
    });
    expect(decision.plan.run.map((action) => action.kind)).toEqual(["profile"]);
  });

  it("stops at the cycle cap", () => {
    const decision = decideReviewOutcome({
      ...base,
      attempt: 2,
      verdict: "revise",
      issues: [issue("一句话", "措辞", "profile")],
    });
    expect(decision.kind).toBe("needs_review");
    if (decision.kind !== "needs_review") return;
    expect(decision.reason).toBe("cap");
  });

  it("sends operator-only reviews to needs_review without burning a cycle", () => {
    const decision = decideReviewOutcome({
      ...base,
      verdict: "revise",
      issues: [issue("关键关系", "大股东持股比例错误", "ownership")],
    });
    expect(decision.kind).toBe("needs_review");
    if (decision.kind !== "needs_review") return;
    expect(decision.reason).toBe("no_route");
    expect(decision.message).toContain("ownership");
  });
});

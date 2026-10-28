import { describe, expect, it } from "vitest";

import {
  buildChunks,
  chunkText,
  estimateTokens,
  parseSectionMarkdown,
} from "../src/sections.js";

const SECTION = `## 贵州茅台酒股份有限公司（600519）

> 数据截止：2026-10-28 ｜ 置信度：高 ｜ 来源数：10

### 1. 一句话

贵州茅台以酱香型白酒为主业，靠品牌溢价与渠道体系赚钱。[3][6]

### 2. 公司快照

| 项目 | 内容 |
|---|---|
| 股票代码 | 600519 / 上海证券交易所 |
| 总部 | 贵州省仁怀市茅台镇 |

### 3. 财务表现

2026 年上半年营业总收入 922.78 亿元，茅台酒 777.2 亿元。
`;

describe("parseSectionMarkdown", () => {
  it("uses the H2 heading as title and strips the ticker suffix", () => {
    const parsed = parseSectionMarkdown(SECTION);
    expect(parsed.title).toBe("贵州茅台酒股份有限公司（600519）");
    expect(parsed.displayName).toBe("贵州茅台酒股份有限公司");
    expect(parsed.legalName).toBe("贵州茅台酒股份有限公司");
  });

  it("splits chapters on H3 and strips numeric prefixes", () => {
    const parsed = parseSectionMarkdown(SECTION);
    expect(parsed.chapters.map((chapter) => chapter.section)).toEqual([
      "概览",
      "一句话",
      "公司快照",
      "财务表现",
    ]);
    expect(parsed.chapters[1]!.text).toContain("贵州茅台");
    expect(parsed.chapters[1]!.text).not.toContain("###");
  });

  it("keeps tables as text", () => {
    const parsed = parseSectionMarkdown(SECTION);
    const snapshot = parsed.chapters.find(
      (chapter) => chapter.section === "公司快照",
    );
    expect(snapshot?.text).toContain("| 股票代码 | 600519 / 上海证券交易所 |");
  });

  it("falls back to a single chapter when there are no H3 headings", () => {
    const parsed = parseSectionMarkdown("## Apple Inc.（AAPL）\n\nApple sells devices.\n");
    expect(parsed.chapters).toHaveLength(1);
    expect(parsed.chapters[0]!.section).toBe("概览");
  });
});

describe("estimateTokens", () => {
  it("counts CJK characters one-for-one and Latin words sublinearly", () => {
    expect(estimateTokens("贵州茅台")).toBe(4);
    expect(estimateTokens("Apple Inc.")).toBe(3);
  });
});

describe("chunkText", () => {
  it("respects the hard token cap", () => {
    const paragraph = "这是一段关于公司业务和财务表现的说明文字。".repeat(40);
    const blocks = Array.from({ length: 8 }, (_, index) => `${index} ${paragraph}`);
    const chunks = chunkText(blocks.join("\n\n"), {
      targetTokens: 200,
      maxTokens: 260,
      overlapTokens: 30,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk)).toBeLessThanOrEqual(260);
    }
  });

  it("splits an oversized table by rows instead of dropping it", () => {
    const rows = Array.from(
      { length: 120 },
      (_, index) => `| 项目 ${index} | ${index * 100} 亿元 |`,
    );
    const table = rows.join("\n");
    const chunks = chunkText(table, { targetTokens: 120, maxTokens: 200 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("\n")).toContain("项目 119");
    for (const chunk of chunks) {
      expect(estimateTokens(chunk)).toBeLessThanOrEqual(200);
    }
  });

  it("returns one chunk for a short section", () => {
    expect(chunkText("短文本。")).toEqual(["短文本。"]);
  });
});

describe("buildChunks", () => {
  it("carries the chapter name into every chunk", () => {
    const parsed = parseSectionMarkdown(SECTION);
    const chunks = buildChunks(parsed);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some((chunk) => chunk.section === "财务表现")).toBe(true);
  });
});

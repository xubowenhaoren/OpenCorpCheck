import fs from "node:fs";

import { parseSectionMarkdown, type ParsedSection } from "@occ/ingest";
import { describe, expect, it } from "vitest";

import { parseDataCutoff, parseSourceChapter } from "../src/citations.js";
import { extractFinancials } from "../src/financials/index.js";
import { parseMarkdownTables } from "../src/markdown-table.js";
import { parseFiscalYearEnd, parsePeriodLabel } from "../src/periods.js";
import { extractSegmentFacts } from "../src/segments.js";
import { extractSnapshotFacts } from "../src/snapshot.js";
import { extractTimelineFacts } from "../src/timeline.js";
import { parseNumericCell, parseUnitContext } from "../src/units.js";

function fixture(name: string): string {
  return fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

function parsed(name: string): ParsedSection {
  return parseSectionMarkdown(fixture(name));
}

function chapter(value: ParsedSection, name: string) {
  const found = value.chapters.find(
    (entry) => entry.section.replace(/\s+/g, "") === name.replace(/\s+/g, ""),
  );
  if (!found) throw new Error(`chapter not found: ${name}`);
  return found;
}

function finance(value: ParsedSection) {
  const found = value.chapters.find((entry) =>
    entry.section.startsWith("财务表现"),
  );
  if (!found) throw new Error("finance chapter not found");
  return found;
}

describe("citations and source chapter", () => {
  it("parses markdown-link citations with publisher and date", () => {
    const citations = parseSourceChapter(chapter(parsed("us.md"), "来源").text);
    expect(citations).toHaveLength(5);
    expect(citations[0]).toMatchObject({
      ref: 1,
      url: "https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm",
      publisher: "SEC",
      publishedAt: "2025-10-31",
    });
    expect(citations[4]?.title).toContain("Gemini");
  });

  it("parses bare Eastmoney URLs and fetch timestamps", () => {
    const citations = parseSourceChapter(
      chapter(parsed("a-share.md"), "来源").text,
    );
    expect(citations[0]).toMatchObject({
      ref: 1,
      title: "东方财富 F10 财务分析",
      fetchedAt: "2026-10-28T20:21:37Z",
    });
    expect(citations[0]?.url).toContain("eastmoney.com");
  });

  it("reads the data cutoff", () => {
    expect(parseDataCutoff(fixture("us.md"))).toBe("2026-10-28");
  });
});

describe("markdown tables", () => {
  it("finds the snapshot, segment and financial tables", () => {
    const tables = parseMarkdownTables(parsed("us.md").chapters[2]!.text);
    expect(tables.length).toBeGreaterThanOrEqual(1);
    const all = parsed("us.md").chapters.flatMap((entry) =>
      parseMarkdownTables(entry.text),
    );
    expect(all.some((table) => table.headers.length === 2)).toBe(true);
    expect(all.some((table) => table.headers.length === 3)).toBe(true);
    const financial = all.find((table) => table.headers[0] === "指标");
    expect(financial?.headers).toEqual([
      "指标",
      "FY2023",
      "FY2024",
      "FY2025",
      "最新季度 Q3 FY2026",
    ]);
  });
});

describe("units and numeric cells", () => {
  it("reads million/billion/CNY units", () => {
    expect(
      parseUnitContext("财务表现", "单位：百万美元（EPS 为美元/股）", "US"),
    ).toMatchObject({ scale: 1e6, currency: "USD", inferred: false });
    expect(
      parseUnitContext("财务表现（单位：人民币亿元）", "", "A"),
    ).toMatchObject({ scale: 1e8, currency: "CNY", inferred: false });
    expect(
      parseUnitContext("财务表现", "| 指标（人民币亿元） | 2023 |", "HK"),
    ).toMatchObject({ scale: 1e8, currency: "CNY", inferred: false });
    expect(parseUnitContext("财务表现", "", "US")).toMatchObject({
      scale: 1e6,
      currency: "USD",
      inferred: true,
    });
  });

  it("normalizes values and keeps missing cells missing", () => {
    expect(parseNumericCell("1,721[1]")).toMatchObject({
      value: 1721,
      refs: [1],
    });
    expect(parseNumericCell("91.93%[1]")).toMatchObject({
      value: 91.93,
      percent: true,
    });
    expect(parseNumericCell("583.9（计算）")).toMatchObject({
      value: 583.9,
      computed: true,
    });
    expect(parseNumericCell("673*")).toMatchObject({
      value: 673,
      computed: true,
    });
    expect(parseNumericCell("-138")?.value).toBe(-138);
    expect(parseNumericCell("未验证")).toBeNull();
    expect(parseNumericCell("未单列")).toBeNull();
    expect(parseNumericCell("未获取")).toBeNull();
  });
});

describe("period labels", () => {
  it("uses explicit FY dates and infers calendar years", () => {
    const us = parseFiscalYearEnd(chapter(parsed("us.md"), "公司快照").text);
    expect(parsePeriodLabel("FY2025", us)).toMatchObject({
      kind: "annual",
      periodEnd: "2025-09-27",
      confidence: 1,
    });
    expect(parsePeriodLabel("最新季度 Q3 FY2026", us)).toMatchObject({
      kind: "quarter",
      fiscalQuarter: 3,
      periodEnd: "2026-06-30",
    });

    const a = parseFiscalYearEnd(
      chapter(parsed("a-share.md"), "公司快照").text,
    );
    expect(parsePeriodLabel("2023", a)).toMatchObject({
      kind: "annual",
      periodEnd: "2023-12-31",
      confidence: 0.8,
    });
    expect(parsePeriodLabel("2026H1", a)).toMatchObject({
      kind: "half",
      periodEnd: "2026-06-30",
    });
  });

  it("parses TTM labels", () => {
    const us = parseFiscalYearEnd(chapter(parsed("us.md"), "公司快照").text);
    expect(parsePeriodLabel("TTM 2026/6", us)).toMatchObject({
      kind: "ttm",
      periodEnd: "2026-06-30",
    });
  });
});

describe("deterministic extraction", () => {
  it("extracts US financial rows without inventing missing values", () => {
    const value = parsed("us.md");
    const fye = parseFiscalYearEnd(chapter(value, "公司快照").text);
    const rows = extractFinancials({
      companyId: "c_aapl",
      chapter: finance(value),
      market: "US",
      fye,
      dataCutoff: "2026-10-28",
    });
    expect(rows).toHaveLength(29);
    const revenue = rows.find(
      (row) => row.item === "revenue" && row.periodEnd === "2025-09-27",
    );
    expect(revenue).toMatchObject({
      value: 416161000000,
      currency: "USD",
      unit: "currency",
      sourceRef: 3,
    });
    const margin = rows.find(
      (row) => row.item === "gross_margin" && row.periodEnd === "2025-09-27",
    );
    expect(margin).toMatchObject({ value: 46.9, unit: "percent" });
    const eps = rows.find(
      (row) => row.item === "eps" && row.periodEnd === "2025-09-27",
    );
    expect(eps?.value).toBe(7.46);
    expect(
      rows.some(
        (row) =>
          row.item === "operating_cash_flow" &&
          row.periodEnd === "2026-06-30",
      ),
    ).toBe(false);
  });

  it("extracts A-share units and skips 未验证 cells", () => {
    const value = parsed("a-share.md");
    const fye = parseFiscalYearEnd(chapter(value, "公司快照").text);
    const rows = extractFinancials({
      companyId: "c_moutai",
      chapter: finance(value),
      market: "A",
      fye,
      dataCutoff: "2026-10-28",
    });
    expect(rows).toHaveLength(23);
    expect(
      rows.find((row) => row.item === "revenue" && row.periodEnd === "2026-06-30"),
    ).toMatchObject({ value: 92278000000, currency: "CNY" });
    expect(
      rows.some(
        (row) => row.item === "gross_margin" && row.periodEnd === "2023-12-31",
      ),
    ).toBe(false);
    expect(
      rows.find(
        (row) => row.item === "operating_cash_flow" && row.periodEnd === "2025-12-31",
      )?.value,
    ).toBe(61520000000);
  });

  it("extracts HK header-cell units and computed markers", () => {
    const value = parsed("hk.md");
    const fye = parseFiscalYearEnd(chapter(value, "公司快照").text);
    const rows = extractFinancials({
      companyId: "c_tencent",
      chapter: finance(value),
      market: "HK",
      fye,
      dataCutoff: "2026-10-28",
    });
    expect(rows).toHaveLength(30);
    expect(
      rows.find((row) => row.item === "revenue" && row.periodEnd === "2026-06-30"),
    ).toMatchObject({ value: 204800000000, currency: "CNY" });
    expect(
      rows.find(
        (row) => row.item === "free_cash_flow" && row.periodEnd === "2026-06-30",
      )?.value,
    ).toBe(-13800000000);
    expect(
      rows.find(
        (row) => row.item === "operating_income" && row.periodEnd === "2026-06-30",
      )?.confidence,
    ).toBeLessThan(0.7);
  });

  it("extracts snapshot, segment and timeline facts", () => {
    const value = parsed("us.md");
    const snapshot = extractSnapshotFacts({
      companyId: "c_aapl",
      chapter: chapter(value, "公司快照"),
      dataCutoff: "2026-10-28",
    });
    expect(snapshot).toHaveLength(6);
    expect(
      snapshot.find((fact) => fact.predicate === "employees")?.value,
    ).toMatchObject({ count: 166000 });
    expect(
      snapshot.find((fact) => fact.predicate === "fiscal_year_end")?.value,
    ).toMatchObject({ text: expect.stringContaining("2025-09-27") });

    const segments = extractSegmentFacts({
      companyId: "c_aapl",
      chapter: chapter(value, "业务与收入结构"),
      market: "US",
      dataCutoff: "2026-10-28",
    });
    expect(segments).toHaveLength(2);
    expect(segments[0]?.value).toMatchObject({
      segment: "iPhone",
      revenue: 209586000000,
      share: 50.4,
    });

    const timeline = extractTimelineFacts({
      companyId: "c_aapl",
      chapter: chapter(value, "近 12 个月大事"),
      dataCutoff: "2026-10-28",
    });
    expect(timeline).toHaveLength(2);
    expect(timeline[0]?.value).toMatchObject({ date: "2026-01-12" });
  });

  it("keeps annual and Q4 rows that share the same period end", () => {
    const markdown = [
      "## Test Corp（TEST）",
      "",
      "### 2. 公司快照",
      "",
      "| 项目 | 内容 |",
      "|---|---|",
      "| 财年 | 7 月 31 日止 [1] |",
      "",
      "### 5. 财务表现（近 3 个财年 + 最新季度）",
      "",
      "单位：百万美元",
      "",
      "| 指标 | FY2026 | Q4 FY2026 |",
      "|---|---:|---:|",
      "| 营收 | 4,666.2 | 1,152.4 |",
      "",
      "### 13. 来源",
      "",
      "[1] [Test filing](https://example.com/filing) — Example, 2026-08-01",
    ].join("\n");
    const value = parseSectionMarkdown(markdown);
    const rows = extractFinancials({
      companyId: "c_test",
      chapter: finance(value),
      market: "US",
      fye: parseFiscalYearEnd(chapter(value, "公司快照").text),
      dataCutoff: "2026-10-28",
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.periodKind).sort()).toEqual([
      "annual",
      "quarter",
    ]);
    expect(new Set(rows.map((row) => row.periodEnd))).toEqual(
      new Set(["2026-07-31"]),
    );
  });

  it("is deterministic across runs", () => {
    const value = parsed("us.md");
    const fye = parseFiscalYearEnd(chapter(value, "公司快照").text);
    const run = () =>
      extractFinancials({
        companyId: "c_aapl",
        chapter: finance(value),
        market: "US",
        fye,
        dataCutoff: "2026-10-28",
      });
    expect(run()).toEqual(run());
  });
});

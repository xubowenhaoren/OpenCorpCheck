import { describe, expect, it } from "vitest";

import { projectScrapeResult } from "../src/index.ts";
import { makeScrapeResponse } from "./fixtures.ts";

describe("projectScrapeResult", () => {
  it("trims text, tables and XHR bodies for an agent context", () => {
    const projected = projectScrapeResult(makeScrapeResponse(), {
      maxTextChars: 1_000,
      maxTableRows: 10,
    });

    expect(projected.detail).toBe("summary");
    const page = projected.pages[0]!;
    expect(page.text.length).toBe(1_000);
    expect(page.text_chars).toBe(25_005);
    expect(page.text_truncated).toBe(true);
    expect(page.tables[0]!.rows).toHaveLength(10);
    expect(page.tables_truncated).toBe(true);
    expect(page.xhr_count).toBe(2);
    expect(page.xhr).toEqual([
      {
        url: expect.stringContaining("RPT_F10_FINANCE_MAINFINADATA"),
        status: 200,
        report_name: "RPT_F10_FINANCE_MAINFINADATA",
      },
      {
        url: expect.stringContaining("RPT_F10_FN_BALANCE"),
        status: 200,
        report_name: "RPT_F10_FN_BALANCE",
      },
    ]);
  });

  it("can include XHR bodies explicitly", () => {
    const projected = projectScrapeResult(makeScrapeResponse(), {
      includeXhrBodies: true,
    });
    const xhr = projected.pages[0]!.xhr as Array<{ json?: unknown }>;
    expect(xhr[0]!.json).toEqual({ result: { data: [{ X: 1 }] } });
  });

  it("returns the full payload in full mode", () => {
    const projected = projectScrapeResult(makeScrapeResponse(), { detail: "full" });
    const page = projected.pages[0]!;
    expect(page.text.length).toBe(25_005);
    expect(page.text_truncated).toBe(false);
    expect(page.tables[0]!.rows).toHaveLength(100);
    expect(page.tables_truncated).toBe(false);
  });

  it("records table-count truncation when maxTables is hit", () => {
    const fixture = makeScrapeResponse();
    fixture.pages[0]!.tables.push({
      caption: "second",
      headers: ["a"],
      rows: [["1"]],
    });
    fixture.pages[0]!.table_count = 2;

    const projected = projectScrapeResult(fixture, { maxTables: 1 });
    expect(projected.pages[0]!.tables).toHaveLength(1);
    expect(projected.pages[0]!.tables_truncated).toBe(true);
  });
});

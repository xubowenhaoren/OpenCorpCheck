import { describe, expect, it } from "vitest";

import { filingDocumentId } from "../src/filings.js";

describe("filing document identity", () => {
  it("is stable for the same source item and canonical URL", () => {
    const item = {
      source: "cninfo" as const,
      externalId: "1225649906",
      url: "https://static.cninfo.com.cn/finalpage/2026-10-31/1225649906.PDF",
    };
    expect(filingDocumentId(item, "c_moutai")).toBe(
      filingDocumentId(item, "c_moutai"),
    );
    expect(filingDocumentId(item, "c_moutai")).toMatch(
      /^doc_filing_[0-9a-f]{24}$/,
    );
  });

  it("keeps the same article separate for two companies", () => {
    const item = {
      source: "gdelt" as const,
      externalId: "https://example.com/story",
      url: "https://example.com/story",
    };
    expect(filingDocumentId(item, "c_apple")).not.toBe(
      filingDocumentId(item, "c_alphabet"),
    );
  });

  it("ignores tracking parameters but not the external id", () => {
    const first = filingDocumentId({
      source: "edgar",
      externalId: "0000320193-26-000024",
      url: "https://www.sec.gov/Archives/x?utm_source=a&id=42",
    }, "c_apple");
    const second = filingDocumentId({
      source: "edgar",
      externalId: "0000320193-26-000024",
      url: "https://www.sec.gov/Archives/x?id=42",
    }, "c_apple");
    const other = filingDocumentId({
      source: "edgar",
      externalId: "0000320193-26-000025",
      url: "https://www.sec.gov/Archives/x?id=42",
    }, "c_apple");
    expect(first).toBe(second);
    expect(first).not.toBe(other);
  });
});

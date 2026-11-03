import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  baseFilingForm,
  canonicalFilingUrl,
  cleanText,
  cninfoBoard,
  cninfoForm,
  cninfoPdfUrl,
  cninfoPeriodicKind,
  cninfoPublishedAt,
  createFilingContentLoader,
  edgarPeriodicKind,
  fetchCninfoFilings,
  filingKey,
  filingPeriodicKind,
  gdeltDate,
  hkexPeriodicKind,
  htmlToText,
  isAnnouncementForm,
  isPeriodicReport,
  parseCninfoStocks,
  parseEdgarFilings,
  parseFilingDate,
  parseGdeltResponse,
  parseHkexNewsRows,
  parseIrFeed,
  pdfPageText,
  periodicReportKind,
  type EdgarSubmissionsPayload,
} from "../src/index.js";

describe("text helpers", () => {
  it("cleans HTML entities and strips tags", () => {
    expect(cleanText("<b>Apple &amp; Co.</b>&nbsp;")).toBe("Apple & Co.");
    expect(cleanText("&#x4E2D;&#25991;")).toBe("中文");
  });

  it("drops out-of-range entities and NUL instead of throwing", () => {
    expect(cleanText("a&#x110000;b")).toBe("ab");
    expect(cleanText("a&#0;b")).toBe("ab");
    expect(cleanText("a\u0000b")).toBe("ab");
  });

  it("canonicalizes tracking parameters but keeps ids", () => {
    expect(
      canonicalFilingUrl(
        "https://www.sec.gov/Archives/x?utm_source=a&id=42&random=0.5#top",
      ),
    ).toBe("https://www.sec.gov/Archives/x?id=42");
  });

  it("builds a stable filing key", () => {
    const key = filingKey({
      source: "cninfo",
      externalId: "1225649906",
      url: "https://static.cninfo.com.cn/finalpage/2026-10-31/1225649906.PDF",
    });
    expect(key).toContain("cninfo|1225649906|https://static.cninfo.com.cn/");
  });

  it("parses both HKEX and ISO dates", () => {
    expect(parseFilingDate("22/10/2026 12:03")).toBe(
      "2026-10-22T12:03:00.000Z",
    );
    expect(parseFilingDate("2026-10-22")).toBe("2026-10-22T00:00:00.000Z");
    expect(parseFilingDate("")).toBeUndefined();
  });
});

describe("SEC EDGAR adapter", () => {
  const payload: EdgarSubmissionsPayload = {
    cik: 320193,
    name: "Apple Inc.",
    filings: {
      recent: {
        accessionNumber: [
          "0000320193-26-000024",
          "0001140361-26-041201",
          "0000320193-26-000020",
        ],
        filingDate: ["2026-11-02", "2026-10-29", "2026-10-02"],
        reportDate: ["2026-11-02", "2026-10-27", "2026-09-26"],
        acceptanceDateTime: [
          "2026-11-02T21:30:23.000Z",
          "2026-10-29T22:30:14.000Z",
          "2026-10-02T20:00:00.000Z",
        ],
        form: ["8-K", "4", "10-Q"],
        items: ["2.02,9.01", "", ""],
        primaryDocument: [
          "aapl-20261102.htm",
          "xslF345X06/form4.xml",
          "aapl-20260926.htm",
        ],
        primaryDocDescription: ["8-K", "FORM 4", "10-Q"],
        size: [420455, 4822, 1_000_000],
        isXBRL: [1, 0, 1],
        isInlineXBRL: [1, 0, 1],
      },
    },
  };

  it("keeps announcement forms and skips routine Form 4", () => {
    const items = parseEdgarFilings(payload);
    expect(items.map((item) => item.form)).toEqual(["8-K", "10-Q"]);
    expect(items[0]?.title).toBe("8-K · items 2.02,9.01");
    expect(items[0]?.url).toBe(
      "https://www.sec.gov/Archives/edgar/data/320193/000032019326000024/aapl-20261102.htm",
    );
    expect(items[0]?.publishedAt).toBe("2026-11-02T21:30:23.000Z");
  });

  it("supports a since cutoff and a limit", () => {
    const items = parseEdgarFilings(payload, { since: "2026-10-15", limit: 1 });
    expect(items).toHaveLength(1);
    expect(items[0]?.form).toBe("8-K");
  });

  it("recognizes amendments and excludes ownership noise", () => {
    expect(isAnnouncementForm("10-K/A")).toBe(true);
    expect(isAnnouncementForm("SC 13D/A")).toBe(true);
    expect(isAnnouncementForm("4")).toBe(false);
    expect(isAnnouncementForm("13F-HR")).toBe(false);
    expect(isAnnouncementForm("NPORT-P")).toBe(false);
  });
});

describe("CNINFO adapter", () => {
  it("finds the real orgId, which is not derivable from the ticker", () => {
    expect(
      parseCninfoStocks(
        [
          {
            code: "601318",
            orgId: "9900002221",
            zwjc: "中国平安",
            category: "A股",
          },
        ],
        "601318",
      ),
    ).toEqual({
      code: "601318",
      orgId: "9900002221",
      name: "中国平安",
      category: "A股",
      type: undefined,
    });
  });

  it("builds absolute PDF URLs from adjunct paths", () => {
    expect(cninfoPdfUrl("finalpage/2026-10-31/1225649906.PDF")).toBe(
      "https://static.cninfo.com.cn/finalpage/2026-10-31/1225649906.PDF",
    );
    expect(cninfoPdfUrl("https://example.com/a.pdf")).toBe(
      "https://example.com/a.pdf",
    );
  });

  it("classifies announcement titles deterministically", () => {
    expect(cninfoForm("贵州茅台2026年第三季度报告")).toBe("季报");
    expect(cninfoForm("2025年年度报告")).toBe("年报");
    expect(cninfoForm("中国平安2025年半年度报告")).toBe("半年报");
    expect(cninfoForm("关于回购股份的公告")).toBe("回购");
    expect(cninfoForm("关联交易公告")).toBe("关联交易");
  });

  it("routes SSE A- and B-shares to the Shanghai board", () => {
    expect(cninfoBoard("600519").column).toBe("sse");
    expect(cninfoBoard("900901").column).toBe("sse");
    expect(cninfoBoard("000001").column).toBe("szse");
  });

  it("keeps the Beijing calendar date instead of shifting a day in UTC", () => {
    // 2026-10-31 00:00 Beijing
    expect(cninfoPublishedAt(1793376000000)).toBe("2026-10-31T00:00:00.000Z");
  });

  it("queries an orgId, then announcement history", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push(href);
      if (href.includes("topSearch/query")) {
        return jsonResponse([{ code: "601318", orgId: "9900002221", zwjc: "中国平安" }]);
      }
      expect(String(init?.body)).toContain("stock=601318%2C9900002221");
      return jsonResponse({
        totalAnnouncement: 1,
        hasMore: false,
        announcements: [
          {
            announcementId: "1225649906",
            announcementTitle: "中国平安2026年第三季度报告",
            announcementTime: 1793376000000,
            adjunctUrl: "finalpage/2026-10-31/1225649906.PDF",
            adjunctType: "PDF",
            adjunctSize: 86,
            orgId: "9900002221",
            secCode: "601318",
            secName: "中国平安",
            pageColumn: "SHZB",
          },
        ],
      });
    }) as typeof fetch;

    const result = await fetchCninfoFilings({
      code: "601318",
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2026-11-02T00:00:00Z"),
      fetchImpl,
    });
    expect(calls).toHaveLength(2);
    expect(result.stock.orgId).toBe("9900002221");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      source: "cninfo",
      market: "A",
      externalId: "1225649906",
      form: "季报",
      url: "https://static.cninfo.com.cn/finalpage/2026-10-31/1225649906.PDF",
    });
  });
});

describe("HKEXnews adapter", () => {
  it("maps result rows to filing items and keeps the PDF link", () => {
    const items = parseHkexNewsRows(
      [
        {
          date: "22/10/2026 12:03",
          stock_code: "00700",
          stock_name: "TENCENT",
          category: "Announcements and Notices - [Issue of Debt Securities]",
          title: "COMPLETION OF NOTES ISSUE",
          url: "https://www1.hkexnews.hk/listedco/listconews/sehk/2026/1022/2026102200033.pdf",
          size: "114KB",
        },
      ],
      { code: "00700" },
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source: "hkexnews",
      market: "HK",
      form: "Announcements and Notices",
      publishedAt: "2026-10-22T12:03:00.000Z",
      pdfUrl:
        "https://www1.hkexnews.hk/listedco/listconews/sehk/2026/1022/2026102200033.pdf",
    });
  });
});

describe("IR RSS and GDELT adapters", () => {
  it("parses RSS items and Atom entries", () => {
    const rss = parseIrFeed(
      `<?xml version="1.0"?><rss><channel>
        <item><title>Apple reports results</title><link>https://apple.com/news/a</link>
          <pubDate>Mon, 02 Nov 2026 21:30:00 GMT</pubDate>
          <description><![CDATA[<p>Quarterly results.</p>]]></description></item>
      </channel></rss>`,
      { market: "US", sourceName: "Apple Newsroom" },
    );
    expect(rss[0]).toMatchObject({
      source: "ir-rss",
      market: "US",
      title: "Apple reports results",
      trustTier: "company_ir",
      category: "Apple Newsroom",
    });
    expect(rss[0]?.metadata?.summary).toBe("Quarterly results.");

    const atom = parseIrFeed(
      `<feed><entry><title>Interim results</title>
        <link href="https://example.com/hk/interim"/>
        <updated>2026-08-20T10:00:00Z</updated></entry></feed>`,
      { market: "HK" },
    );
    expect(atom[0]?.url).toBe("https://example.com/hk/interim");
    expect(atom[0]?.publishedAt).toBe("2026-08-20T10:00:00.000Z");

    const relative = parseIrFeed(
      `<feed><entry><title>Relative</title>
        <link rel="self" href="/feed-entry"/>
        <link rel="alternate" href="press/result"/>
        <updated>2026-08-20T10:00:00Z</updated></entry></feed>`,
      { market: "US", baseUrl: "https://example.com/ir/feed.xml" },
    );
    expect(relative[0]?.url).toBe("https://example.com/ir/press/result");
  });

  it("formats GDELT dates and parses articles as media", () => {
    expect(gdeltDate(new Date("2026-11-02T03:04:05Z"))).toBe("20261102030405");
    const items = parseGdeltResponse(
      {
        articles: [
          {
            url: "https://example.com/story",
            title: "Apple ships something",
            seendate: "20261102T030405Z",
            domain: "example.com",
            language: "English",
          },
        ],
      },
      { market: "US", query: '"Apple Inc"' },
    );
    expect(items[0]).toMatchObject({
      source: "gdelt",
      market: "US",
      trustTier: "media",
      publishedAt: "2026-11-02T03:04:05.000Z",
    });
  });
});

describe("PDF page text", () => {
  it("keeps page text and table rows with page provenance", () => {
    expect(
      pdfPageText({
        page: 2,
        text: "经营情况",
        tables: [
          {
            headers: ["项目", "金额"],
            rows: [["收入", "11,292,545.23"]],
          },
        ],
      }),
    ).toBe("经营情况\n项目 | 金额\n收入 | 11,292,545.23");
  });
});

describe("periodic report classification (P1.5)", () => {
  it("classifies EDGAR periodic forms, including amendments", () => {
    expect(baseFilingForm("10-K/A")).toBe("10-K");
    expect(edgarPeriodicKind("10-K")).toBe("annual");
    expect(edgarPeriodicKind("10-K/A")).toBe("annual");
    expect(edgarPeriodicKind("20-F")).toBe("annual");
    expect(edgarPeriodicKind("40-F")).toBe("annual");
    expect(edgarPeriodicKind("10-Q")).toBe("quarter");
    expect(edgarPeriodicKind("10-Q/A")).toBe("quarter");
    expect(edgarPeriodicKind("8-K")).toBeNull();
    expect(edgarPeriodicKind("6-K")).toBeNull();
  });

  it("requires an unambiguous CNINFO report title", () => {
    expect(cninfoPeriodicKind({ title: "2025年年度报告" })).toBe("annual");
    expect(cninfoPeriodicKind({ title: "2025年半年度报告" })).toBe("half");
    expect(cninfoPeriodicKind({ title: "2025年第三季度报告" })).toBe(
      "quarter",
    );
    expect(cninfoPeriodicKind({ title: "2025年年度报告摘要" })).toBeNull();
    expect(
      cninfoPeriodicKind({ title: "关于召开2025年度业绩说明会的公告" }),
    ).toBeNull();
    expect(cninfoPeriodicKind({ title: "2025年年度业绩预告" })).toBeNull();
    expect(cninfoPeriodicKind({ title: "", form: "季报" })).toBe("quarter");
  });

  it("classifies HKEXnews results announcements but not notices", () => {
    expect(
      hkexPeriodicKind({
        title: "ANNOUNCEMENT OF ANNUAL RESULTS FOR THE YEAR ENDED 31 DECEMBER 2025",
      }),
    ).toBe("annual");
    expect(
      hkexPeriodicKind({ title: "ANNOUNCEMENT OF INTERIM RESULTS" }),
    ).toBe("half");
    expect(
      hkexPeriodicKind({ title: "QUARTERLY RESULTS ANNOUNCEMENT" }),
    ).toBe("quarter");
    expect(
      hkexPeriodicKind({ title: "截至2025年12月31日止年度之年度业绩" }),
    ).toBe("annual");
    expect(hkexPeriodicKind({ title: "中期业绩" })).toBe("half");
    expect(hkexPeriodicKind({ title: "PROFIT WARNING" })).toBeNull();
    expect(hkexPeriodicKind({ title: "DATE OF BOARD MEETING" })).toBeNull();
    expect(
      hkexPeriodicKind({ title: "MONTHLY RETURN", category: "月报表" }),
    ).toBeNull();
  });

  it("dispatches by source and exposes an item helper", () => {
    expect(
      periodicReportKind({
        source: "edgar",
        form: "10-Q",
        title: "10-Q",
      }),
    ).toBe("quarter");
    expect(
      isPeriodicReport({ source: "edgar", form: "8-K", title: "8-K" }),
    ).toBe(false);
    expect(
      filingPeriodicKind({
        source: "cninfo",
        title: "2025年年度报告",
        form: "年报",
        category: "上交所",
      }),
    ).toBe("annual");
    expect(
      filingPeriodicKind({
        source: "hkexnews",
        title: "Interim Results",
        category: "Financial Statements",
      }),
    ).toBe("half");
  });
});

describe("filing content loader (P1.5)", () => {
  it("returns null for link-only mode", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-filing-content-"));
    try {
      const load = createFilingContentLoader({
        dir,
        sidecarUrl: "http://127.0.0.1:8090",
        skipPdf: true,
      });
      await expect(
        load({
          source: "edgar",
          market: "US",
          externalId: "0000320193-26-000024",
          title: "8-K",
          url: "https://www.sec.gov/Archives/x.htm",
        }),
      ).resolves.toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("extracts EDGAR HTML only when fullText is enabled", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-filing-content-"));
    try {
      const fetchImpl = (async () =>
        new Response("<html><body><p>Annual report</p></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })) as unknown as typeof fetch;
      const load = createFilingContentLoader({
        dir,
        sidecarUrl: "http://127.0.0.1:8090",
        fullText: true,
        fetchImpl,
      });
      const content = await load({
        source: "edgar",
        market: "US",
        externalId: "0000320193-26-000024",
        title: "10-K",
        url: "https://www.sec.gov/Archives/x.htm",
      });
      expect(content?.pages).toHaveLength(1);
      expect(content?.pages[0]?.text).toBe("Annual report");
      expect(content?.mime).toBe("text/html");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("strips HTML to text", () => {
    expect(htmlToText("<b>Apple &amp; Co.</b>")).toBe("Apple & Co.");
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

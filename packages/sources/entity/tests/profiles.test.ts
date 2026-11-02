import { describe, expect, it } from "vitest";

import { parseEdgarProfile } from "../src/edgar-profile.js";
import { parseF10CompanyProfile } from "../src/f10-profile.js";
import {
  normalizeDomain,
  normalizeFullName,
  normalizeIsin,
  normalizeLei,
  normalizeName,
  normalizeQid,
  normalizeUscc,
  usccChecksumMatches,
} from "../src/text.js";

describe("text normalization", () => {
  it("normalizes names for exact matching", () => {
    expect(normalizeFullName("Apple Inc.")).toBe("appleinc");
    expect(normalizeFullName("APPLE, INC.")).toBe("appleinc");
    expect(normalizeFullName("中国平安保险（集团）股份有限公司")).toBe(
      "中国平安保险集团股份有限公司",
    );
    expect(normalizeFullName("中国平安保险(集团)股份有限公司")).toBe(
      "中国平安保险集团股份有限公司",
    );
    expect(normalizeName("Tencent Holdings Limited")).toBe("tencentholdings");
  });

  it("normalizes domains", () => {
    expect(normalizeDomain("www.apple.com")).toBe("apple.com");
    expect(normalizeDomain("https://www.tencent.com/zh/index.html")).toBe(
      "tencent.com",
    );
    expect(normalizeDomain("--")).toBeNull();
    expect(normalizeDomain("not a domain")).toBeNull();
  });

  it("validates identifiers", () => {
    expect(normalizeLei("hwupkr0mpou8fgxbt394")).toBe("HWUPKR0MPOU8FGXBT394");
    expect(normalizeLei("short")).toBeNull();
    expect(normalizeIsin("us0378331005")).toBe("US0378331005");
    expect(normalizeIsin("US037833100")).toBeNull();
    expect(normalizeUscc("9152000071430580XT")).toBe("9152000071430580XT");
    expect(normalizeUscc("9152000071430580XT!")).toBeNull();
    expect(normalizeQid("q312")).toBe("Q312");
    expect(normalizeQid("P31")).toBeNull();
  });

  it("validates the USCC checksum", () => {
    expect(usccChecksumMatches("9152000071430580XT")).toBe(true);
    expect(usccChecksumMatches("91440300100012316L")).toBe(true);
    expect(usccChecksumMatches("9152000071430580XA")).toBe(false);
  });
});

describe("parseF10CompanyProfile", () => {
  it("parses an A-share gsgk page", () => {
    const profile = parseF10CompanyProfile({
      market: "A",
      page: {
        page: "gsgk",
        url: "https://emweb.eastmoney.com/PC_HSF10/gsgk",
        meta: { fetched_at: "2026-11-01T00:00:00Z" },
        tables: [
          {
            rows: [
              ["公司名称", "中国平安保险(集团)股份有限公司"],
              ["英文名称", "Ping An Insurance (Group) Company of China, Ltd."],
              ["A股代码", "601318", "A股简称", "中国平安"],
              ["H股代码", "02318.HK", "H股简称", "中国平安"],
              ["证券类别", "A股", "所属东财行业", "非银金融-保险Ⅱ-保险Ⅲ"],
              ["上市交易所", "上海证券交易所", "所属证监会行业", "金融业-保险业"],
              ["公司网址", "www.pingan.cn"],
              ["工商登记", "91440300100012316L"],
              ["电子信箱", "IR@pingan.com.cn"],
            ],
          },
        ],
      },
    });
    expect(profile.companyName).toBe("中国平安保险(集团)股份有限公司");
    expect(profile.englishName).toContain("Ping An Insurance");
    expect(profile.industry).toBe("非银金融-保险Ⅱ-保险Ⅲ");
    expect(profile.industryCsrc).toBe("金融业-保险业");
    expect(profile.uscc).toBe("91440300100012316L");
    expect(profile.domain).toBe("pingan.cn");
    expect(profile.aCode).toBe("601318");
    expect(profile.hCode).toBe("02318");
    expect(profile.isin).toBeUndefined();
  });

  it("parses an HK CompanyProfile page with ISIN from the text fallback", () => {
    const profile = parseF10CompanyProfile({
      market: "HK",
      page: {
        page: "CompanyProfile",
        url: "https://emweb.eastmoney.com/pc_hkf10/CompanyProfile",
        text: "证券代码\t00700.HK\t证券简称\t腾讯控股\nISIN（国际证券识别编码）\tKYG875721634\n所属行业\t软件服务\n公司网址\twww.tencent.com",
      },
    });
    expect(profile.isin).toBe("KYG875721634");
    expect(profile.industry).toBe("软件服务");
    expect(profile.domain).toBe("tencent.com");
  });

  it("parses a US gsgk page", () => {
    const profile = parseF10CompanyProfile({
      market: "US",
      page: {
        page: "gsgk",
        url: "https://emweb.eastmoney.com/PC_USF10/gsgk",
        tables: [
          {
            rows: [
              ["证券代码", "AAPL", "ISIN", "US0378331005"],
              ["公司名称", "Apple Inc.", "公司网址", "www.apple.com"],
              ["所属行业", "电脑硬件、储存设备及电脑周边"],
            ],
          },
        ],
      },
    });
    expect(profile.isin).toBe("US0378331005");
    expect(profile.companyName).toBe("Apple Inc.");
    expect(profile.industry).toBe("电脑硬件、储存设备及电脑周边");
    expect(profile.domain).toBe("apple.com");
  });

  it("drops empty placeholder values", () => {
    const profile = parseF10CompanyProfile({
      market: "US",
      page: {
        url: "https://example.test",
        tables: [{ rows: [["所属行业", "--"], ["ISIN", "--"]] }],
      },
    });
    expect(profile.industry).toBeUndefined();
    expect(profile.isin).toBeUndefined();
  });
});

describe("parseEdgarProfile", () => {
  it("extracts SIC, LEI, EIN and website", () => {
    const profile = parseEdgarProfile({
      cik: "320193",
      name: "Apple Inc.",
      sic: "3571",
      sicDescription: "Electronic Computers",
      lei: "HWUPKR0MPOU8FGXBT394",
      ein: "94-2404110",
      website: "https://www.apple.com",
      tickers: ["AAPL"],
      exchanges: ["Nasdaq"],
    });
    expect(profile?.cik).toBe("0000320193");
    expect(profile?.sic).toBe("3571");
    expect(profile?.lei).toBe("HWUPKR0MPOU8FGXBT394");
    expect(profile?.ein).toBe("942404110");
    expect(profile?.domain).toBe("apple.com");
    expect(profile?.tickers).toEqual(["AAPL"]);
  });

  it("returns null for a missing payload", () => {
    expect(parseEdgarProfile(null)).toBeNull();
  });
});

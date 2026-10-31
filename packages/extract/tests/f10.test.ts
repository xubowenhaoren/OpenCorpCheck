import { describe, expect, it } from "vitest";

import {
  buildF10Relations,
  parseF10Shareholders,
  resolveShareholder,
} from "../src/relations/f10.js";
import type { UniverseCompany } from "../src/relations/prompt.js";

const universe: UniverseCompany[] = [
  {
    id: "c_boc",
    ticker: "03988",
    displayName: "中国银行",
    names: ["中国银行", "中国银行股份有限公司", "Bank of China"],
  },
  {
    id: "c_tencent",
    ticker: "00700",
    displayName: "腾讯控股",
    names: ["腾讯控股", "腾讯控股有限公司", "Tencent Holdings Limited"],
  },
  {
    id: "c_hsbc",
    ticker: "00005",
    displayName: "汇丰控股",
    names: ["汇丰控股", "HSBC Holdings plc"],
  },
];

describe("F10 shareholder tables", () => {
  it("parses the A-share 十大股东 table", () => {
    const page = {
      page: "gdyj",
      url: "https://emweb.eastmoney.com/PC_HSF10#/gdyj",
      tables: [
        {
          headers: ["名次", "股东名称", "股份类型", "持股数(股)", "占总股本 持股比例"],
          rows: [
            ["1", "中国银行股份有限公司", "流通A股", "55,263,682", "4.42%"],
            ["2", "中国贵州茅台酒厂(集团)有限责任公司", "流通A股", "681,282,935", "54.50%"],
          ],
        },
      ],
    };
    const rows = parseF10Shareholders(page, "A");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: "中国银行股份有限公司",
      percent: 4.42,
    });
  });

  it("parses HK MajorShareholder and US gbgd shapes", () => {
    const hk = parseF10Shareholders(
      {
        page: "MajorShareholder",
        url: "https://emweb.eastmoney.com/pc_hkf10#/MajorShareholder",
        tables: [
          {
            headers: ["直接/间接持股方", "权益股份(股)", "权益占比"],
            rows: [["直 MIH Internet Holdings B.V.", "20.55亿", "22.60%"]],
          },
        ],
      },
      "HK",
    );
    expect(hk[0]).toMatchObject({
      name: "MIH Internet Holdings B.V.",
      percent: 22.6,
    });

    const us = parseF10Shareholders(
      {
        page: "gbgd",
        url: "https://emweb.eastmoney.com/PC_USF10#/gbgd",
        tables: [
          {
            headers: ["持股人", "权益股份(股)", "权益占比"],
            rows: [["The Vanguard Group", "14.16亿", "9.63%"]],
          },
        ],
      },
      "US",
    );
    expect(us[0]).toMatchObject({ name: "The Vanguard Group", percent: 9.63 });
  });
});

describe("F10 relation building", () => {
  it("resolves legal names through the universe and splits owns/invests_in", () => {
    const page = {
      page: "gdyj",
      url: "https://emweb.eastmoney.com/PC_HSF10#/gdyj",
      text: "2026-09-30",
      tables: [
        {
          headers: ["名次", "股东名称", "占总股本 持股比例"],
          rows: [
            ["1", "中国银行股份有限公司", "54.50%"],
            ["2", "汇丰控股有限公司", "4.42%"],
            ["3", "某未收录股东", "2.00%"],
          ],
        },
      ],
    };
    const result = buildF10Relations({
      page,
      market: "A",
      selfCompanyId: "c_target",
      universe,
    });
    expect(result.relations).toHaveLength(2);
    expect(result.relations[0]).toMatchObject({
      srcCompanyId: "c_boc",
      dstCompanyId: "c_target",
      type: "owns",
      validFrom: "2026-09-30",
    });
    expect(result.relations[1]).toMatchObject({
      srcCompanyId: "c_hsbc",
      type: "invests_in",
    });
    expect(result.unmatched.map((row) => row.name)).toEqual(["某未收录股东"]);
  });

  it("ignores tiny stakes and self edges", () => {
    const result = buildF10Relations({
      page: {
        page: "gbgd",
        url: "https://example.com",
        tables: [
          {
            headers: ["持股人", "权益占比"],
            rows: [
              ["腾讯控股有限公司", "0.10%"],
              ["腾讯控股", "9.00%"],
            ],
          },
        ],
      },
      market: "US",
      selfCompanyId: "c_tencent",
      universe,
    });
    expect(result.relations).toHaveLength(0);
    expect(result.dropped).toBe(1);
    expect(result.unmatched).toHaveLength(1);
  });

  it("normalises corporate suffixes", () => {
    expect(
      resolveShareholder("腾讯控股有限公司", universe)?.id,
    ).toBe("c_tencent");
    expect(resolveShareholder("HSBC Holdings plc", universe)?.id).toBe("c_hsbc");
    expect(resolveShareholder("Apple Inc.", universe)).toBeUndefined();
  });
});

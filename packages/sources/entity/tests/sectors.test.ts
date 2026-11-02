import { describe, expect, it } from "vitest";

import {
  CANONICAL_SECTORS,
  sectorFromEastmoneyIndustry,
  sectorFromLegacyLabel,
  sectorFromSic,
} from "../src/sectors.js";

describe("sectorFromEastmoneyIndustry", () => {
  it("uses the first level of the A-share hierarchy", () => {
    expect(
      sectorFromEastmoneyIndustry("食品饮料-白酒Ⅱ-白酒Ⅲ", "A"),
    ).toEqual({
      sector: "必需消费",
      rule: "eastmoney-a-first-level",
      label: "食品饮料-白酒Ⅱ-白酒Ⅲ",
    });
    expect(sectorFromEastmoneyIndustry("非银金融-保险Ⅱ-保险Ⅲ", "A")?.sector).toBe("金融");
    expect(sectorFromEastmoneyIndustry("电子-半导体-数字芯片设计", "A")?.sector).toBe(
      "信息技术",
    );
  });

  it("maps Hong Kong industry labels", () => {
    expect(sectorFromEastmoneyIndustry("软件服务", "HK")?.sector).toBe("信息技术");
    expect(sectorFromEastmoneyIndustry("银行", "HK")?.sector).toBe("金融");
    expect(sectorFromEastmoneyIndustry("地产", "HK")?.sector).toBe("房地产");
    expect(sectorFromEastmoneyIndustry("药品及生物科技", "HK")?.sector).toBe("医疗保健");
  });

  it("maps US industry labels and falls back to keywords", () => {
    expect(sectorFromEastmoneyIndustry("半导体产品", "US")?.sector).toBe("信息技术");
    expect(sectorFromEastmoneyIndustry("汽车制造商", "US")?.sector).toBe("可选消费");
    expect(sectorFromEastmoneyIndustry("多品类零售", "US")?.sector).toBe("可选消费");
    expect(sectorFromEastmoneyIndustry("日常消费品零售", "US")?.sector).toBe("必需消费");
    expect(sectorFromEastmoneyIndustry("综合性石油与天然气企业", "US")?.sector).toBe(
      "能源",
    );
    expect(sectorFromEastmoneyIndustry("某个新能源设备企业", "US")?.sector).toBe("能源");
  });

  it("returns null for empty or unknown labels", () => {
    expect(sectorFromEastmoneyIndustry("", "A")).toBeNull();
    expect(sectorFromEastmoneyIndustry("--", "HK")).toBeNull();
    expect(sectorFromEastmoneyIndustry("不存在的行业", "US")).toBeNull();
  });
});

describe("sectorFromSic", () => {
  it("maps representative SIC divisions", () => {
    expect(sectorFromSic("3571", "Electronic Computers")?.sector).toBe("信息技术");
    expect(sectorFromSic("3674", "Semiconductors")?.sector).toBe("信息技术");
    expect(sectorFromSic("2836", "Biological Products")?.sector).toBe("医疗保健");
    expect(sectorFromSic("7372", "Prepackaged Software")?.sector).toBe("信息技术");
    expect(sectorFromSic("4911", "Electric Services")?.sector).toBe("公用事业");
    expect(sectorFromSic("1311", "Crude Petroleum")?.sector).toBe("能源");
    expect(sectorFromSic("5331", "Variety Stores")?.sector).toBe("必需消费");
    expect(sectorFromSic("5812", "Eating Places")?.sector).toBe("可选消费");
    expect(sectorFromSic("6021", "National Commercial Banks")?.sector).toBe("金融");
    expect(sectorFromSic("6500", "Real Estate")?.sector).toBe("房地产");
  });

  it("special-cases oil field machinery and pharma chemicals", () => {
    expect(sectorFromSic("3533", "Oil & Gas Field Machinery")?.sector).toBe("能源");
    expect(sectorFromSic("2834", "Pharmaceutical Preparations")?.sector).toBe(
      "医疗保健",
    );
    expect(sectorFromSic("2810", "Industrial Inorganic Chemicals")?.sector).toBe(
      "原材料",
    );
  });

  it("returns null for unknown input", () => {
    expect(sectorFromSic(null)).toBeNull();
    expect(sectorFromSic("")).toBeNull();
    expect(sectorFromSic("99999")).toBeNull();
  });
});

describe("sectorFromLegacyLabel", () => {
  it("recognizes canonical and thematic legacy labels", () => {
    expect(sectorFromLegacyLabel("信息技术")?.rule).toBe("canonical");
    expect(sectorFromLegacyLabel("白酒")?.sector).toBe("必需消费");
    expect(sectorFromLegacyLabel("大模型")?.sector).toBe("信息技术");
    expect(sectorFromLegacyLabel("互联网平台")?.sector).toBe("通信服务");
    expect(sectorFromLegacyLabel("未知标签")).toBeNull();
  });
});

describe("taxonomy", () => {
  it("has 11 unique canonical sectors", () => {
    expect(CANONICAL_SECTORS).toHaveLength(11);
    expect(new Set(CANONICAL_SECTORS).size).toBe(11);
  });
});

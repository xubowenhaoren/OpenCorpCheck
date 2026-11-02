/**
 * Canonical sector taxonomy and deterministic vendor-code mappings.
 *
 * This is a GICS-style 11-sector spine, rendered in Chinese because the
 * corpus and the existing UI labels are Chinese. The taxonomy is deliberately
 * coarse: it exists to make the company header, the search sector filter and
 * ownership matching trustworthy, not to replace a full GICS/中证 industry
 * hierarchy. Vendor labels stay in `companies.profile.industry` for display.
 *
 * Every mapping is deterministic and auditable:
 *  - A/HK: Eastmoney F10 `所属东财行业` / `所属行业` (first-level segment).
 *  - US: Eastmoney F10 `所属行业` first, SEC EDGAR SIC as the fallback.
 *  - Unknown labels return null and are reported; nothing is guessed.
 */

export const SECTOR_TAXONOMY_VERSION = "gics-like-11@1";

export const CANONICAL_SECTORS = [
  "信息技术",
  "通信服务",
  "可选消费",
  "必需消费",
  "医疗保健",
  "金融",
  "工业",
  "能源",
  "原材料",
  "公用事业",
  "房地产",
] as const;

export type CanonicalSector = (typeof CANONICAL_SECTORS)[number];

export interface SectorDecision {
  sector: CanonicalSector;
  /** Which deterministic rule produced the sector. */
  rule: string;
  /** The vendor label or code the rule consumed. */
  label: string;
}

/** A-share Eastmoney industry first-level segment (所属东财行业). */
const EASTMONEY_A_FIRST_LEVEL: Record<string, CanonicalSector> = {
  食品饮料: "必需消费",
  非银金融: "金融",
  银行: "金融",
  电子: "信息技术",
  医药生物: "医疗保健",
  电力设备: "工业",
  计算机: "信息技术",
  通信: "通信服务",
  传媒: "通信服务",
  汽车: "可选消费",
  机械设备: "工业",
  有色金属: "原材料",
  基础化工: "原材料",
  石油石化: "能源",
  公用事业: "公用事业",
  房地产: "房地产",
  交通运输: "工业",
  建筑装饰: "工业",
  建筑材料: "原材料",
  家用电器: "可选消费",
  纺织服饰: "可选消费",
  商贸零售: "可选消费",
  社会服务: "可选消费",
  美容护理: "必需消费",
  农林牧渔: "必需消费",
  轻工制造: "可选消费",
  钢铁: "原材料",
  煤炭: "能源",
  环保: "工业",
  国防军工: "工业",
  综合: "工业",
};

/** Hong Kong Eastmoney industry labels (所属行业). */
const EASTMONEY_HK: Record<string, CanonicalSector> = {
  地产: "房地产",
  药品及生物科技: "医疗保健",
  医疗保健设备和服务: "医疗保健",
  公用事业: "公用事业",
  银行: "金融",
  保险: "金融",
  其他金融: "金融",
  食物饮品: "必需消费",
  农业产品: "必需消费",
  消费者主要零售商: "必需消费",
  专业零售: "可选消费",
  旅游及消闲设施: "可选消费",
  家庭电器及用品: "可选消费",
  纺织及服饰: "可选消费",
  汽车: "可选消费",
  资讯科技器材: "信息技术",
  半导体: "信息技术",
  软件服务: "信息技术",
  石油及天然气: "能源",
  煤炭: "能源",
  工业工程: "工业",
  工用运输: "工业",
  工用支援: "工业",
  建筑: "工业",
  航运: "工业",
  航空: "工业",
  综合企业: "工业",
  电讯: "通信服务",
  媒体及娱乐: "通信服务",
  一般金属及矿石: "原材料",
  黄金及贵金属: "原材料",
  化工产品: "原材料",
  建筑材料: "原材料",
};

/** US Eastmoney industry labels (所属行业). */
const EASTMONEY_US: Record<string, CanonicalSector> = {
  半导体产品: "信息技术",
  半导体材料与设备: "信息技术",
  应用软件: "信息技术",
  系统软件: "信息技术",
  "电脑硬件、储存设备及电脑周边": "信息技术",
  通信设备: "信息技术",
  数据处理与外包服务: "信息技术",
  互联网服务与基础设施: "通信服务",
  互动媒体与服务: "通信服务",
  有线和卫星电视: "通信服务",
  无线电信业务: "通信服务",
  互动家庭娱乐: "通信服务",
  出版: "通信服务",
  电影与娱乐: "通信服务",
  医疗保健设备: "医疗保健",
  生物科技: "医疗保健",
  制药: "医疗保健",
  药品制造商: "医疗保健",
  软饮料与不含酒精饮料: "必需消费",
  包装食品与肉类: "必需消费",
  多品类零售: "可选消费",
  日常消费品零售: "必需消费",
  "酒店、度假村与豪华游轮": "可选消费",
  消闲设施: "可选消费",
  汽车制造商: "可选消费",
  汽车零售: "可选消费",
  服装零售: "可选消费",
  餐馆: "可选消费",
  电力公用事业: "公用事业",
  综合支持服务: "工业",
  航天航空与国防: "工业",
  铁路: "工业",
  工业集团企业: "工业",
  建筑与工程: "工业",
  建筑机械与重型运输设备: "工业",
  地面货运: "工业",
  商品化工: "原材料",
  石油与天然气的勘探与生产: "能源",
  石油天然气设备与服务: "能源",
  综合性石油与天然气企业: "能源",
  综合性银行: "金融",
  保险: "金融",
  资产管理与托管银行: "金融",
  资本市场: "金融",
};

/**
 * Keyword fallback for vendor labels that are not in the explicit table.
 * Order matters: energy/health/finance win over the generic industrial and
 * consumer keywords.
 */
const KEYWORD_RULES: Array<[RegExp, CanonicalSector]> = [
  [/房地产|地产/, "房地产"],
  [/银行|保险|金融|资本|资产管理|证券|信托/, "金融"],
  [/石油|天然气|煤炭|能源|油气/, "能源"],
  [/电力|公用事业|水务|燃气供应/, "公用事业"],
  [/药品|制药|生物|医疗|保健|医药/, "医疗保健"],
  [/半导体|软件|计算机|电脑|信息技术|电子|通信设备|互联网|数据服务/, "信息技术"],
  [/电讯|电信|媒体|娱乐|电视|广告|出版|互联网平台/, "通信服务"],
  [/化工|金属|矿石|矿业|钢铁|材料|造纸|水泥|玻璃/, "原材料"],
  [/食品|饮料|酒|零售|超市|农业|农产品|烟草|日用品/, "必需消费"],
  [/汽车|家电|纺织|服饰|酒店|旅游|消闲|餐饮|服装|家居|零售/, "可选消费"],
  [/工业|机械|设备|航天|航空|国防|军工|建筑|工程|运输|铁路|货运|物流|制造|环保/, "工业"],
];

/** Map an A/HK/US Eastmoney industry label to the canonical sector. */
export function sectorFromEastmoneyIndustry(
  industry: string | null | undefined,
  market: "A" | "HK" | "US",
): SectorDecision | null {
  const raw = (industry ?? "").trim();
  if (!raw || raw === "--") return null;

  if (market === "A") {
    // 所属东财行业 is hierarchical: 食品饮料-白酒Ⅱ-白酒Ⅲ.
    const first = raw.split(/[-－—]/)[0]?.trim() ?? "";
    const sector = EASTMONEY_A_FIRST_LEVEL[first];
    if (sector) {
      return { sector, rule: "eastmoney-a-first-level", label: raw };
    }
  } else {
    const table = market === "HK" ? EASTMONEY_HK : EASTMONEY_US;
    const sector = table[raw];
    if (sector) {
      return { sector, rule: `eastmoney-${market.toLowerCase()}-label`, label: raw };
    }
  }

  for (const [pattern, sector] of KEYWORD_RULES) {
    if (pattern.test(raw)) {
      return { sector, rule: "eastmoney-keyword", label: raw };
    }
  }
  return null;
}

/**
 * Map a SEC SIC code to the canonical sector.
 *
 * The SIC divisions are stable and public domain. A few high-impact codes are
 * special-cased because the broad division would misclassify them (e.g. oil
 * field machinery sits in the industrial-machinery range). Unknown codes
 * return null.
 */
export function sectorFromSic(
  sic: string | number | null | undefined,
  description?: string | null,
): SectorDecision | null {
  if (sic === null || sic === undefined || sic === "") return null;
  const code = Number.parseInt(String(sic).trim(), 10);
  if (!Number.isFinite(code) || code <= 0) return null;
  const label = description ? `${code} ${description}` : String(code);

  const decide = (sector: CanonicalSector, rule = "sec-sic-range"): SectorDecision => ({
    sector,
    rule,
    label,
  });

  // Oil & gas field machinery (industrial machinery range, energy in GICS).
  if (code === 3533) return decide("能源", "sec-sic-override");
  // Pharmaceutical preparations, biological products, in-vitro diagnostics.
  if (code >= 2833 && code <= 2836) return decide("医疗保健", "sec-sic-override");

  if (code >= 100 && code <= 999) return decide("必需消费");
  if (code >= 1000 && code <= 1099) return decide("原材料");
  if (code >= 1200 && code <= 1399) return decide("能源");
  if (code >= 1400 && code <= 1499) return decide("原材料");
  if (code >= 1500 && code <= 1799) return decide("工业");
  if (code >= 2000 && code <= 2199) return decide("必需消费");
  if (code >= 2200 && code <= 2399) return decide("可选消费");
  if (code >= 2400 && code <= 2499) return decide("原材料");
  if (code >= 2500 && code <= 2599) return decide("可选消费");
  if (code >= 2600 && code <= 2699) return decide("原材料");
  if (code >= 2700 && code <= 2799) return decide("通信服务");
  if (code >= 2800 && code <= 2899) {
    if (code >= 2840 && code <= 2844) return decide("必需消费", "sec-sic-override");
    return decide("原材料");
  }
  if (code >= 2900 && code <= 2999) return decide("能源");
  if (code >= 3000 && code <= 3099) return decide("原材料");
  if (code >= 3100 && code <= 3199) return decide("可选消费");
  if (code >= 3200 && code <= 3399) return decide("原材料");
  if (code >= 3400 && code <= 3499) return decide("工业");
  if (code >= 3500 && code <= 3599) {
    if (code >= 3570 && code <= 3579) return decide("信息技术", "sec-sic-override");
    return decide("工业");
  }
  if (code >= 3600 && code <= 3699) {
    if ((code >= 3620 && code <= 3629) || (code >= 3640 && code <= 3649)) {
      return decide("工业", "sec-sic-override");
    }
    return decide("信息技术");
  }
  if (code >= 3700 && code <= 3799) {
    if (code >= 3720 && code <= 3769) return decide("工业", "sec-sic-override");
    if (code >= 3790 && code <= 3799) return decide("工业", "sec-sic-override");
    return decide("可选消费");
  }
  if (code >= 3800 && code <= 3899) {
    if (code >= 3841 && code <= 3851) return decide("医疗保健", "sec-sic-override");
    return decide("信息技术");
  }
  if (code >= 3900 && code <= 3999) return decide("可选消费");
  if (code >= 4000 && code <= 4799) return decide("工业");
  if (code >= 4800 && code <= 4899) return decide("通信服务");
  if (code >= 4900 && code <= 4999) return decide("公用事业");
  if (code >= 5000 && code <= 5199) return decide("工业");
  if (code >= 5200 && code <= 5999) {
    if (code >= 5300 && code <= 5499) return decide("必需消费", "sec-sic-override");
    if (code === 5912) return decide("必需消费", "sec-sic-override");
    return decide("可选消费");
  }
  if (code >= 6000 && code <= 6499) return decide("金融");
  if (code >= 6500 && code <= 6599) return decide("房地产");
  if (code >= 7000 && code <= 7299) return decide("可选消费");
  if (code >= 7300 && code <= 7399) {
    if (code >= 7370 && code <= 7379) return decide("信息技术", "sec-sic-override");
    if (code >= 7310 && code <= 7319) return decide("通信服务", "sec-sic-override");
    return decide("工业");
  }
  if (code >= 7500 && code <= 7999) return decide("可选消费");
  if (code >= 8000 && code <= 8099) return decide("医疗保健");
  if (code >= 8100 && code <= 8999) return decide("工业");
  if (code >= 9100 && code <= 9729) return decide("公用事业");
  return null;
}

/**
 * Normalize one of the older free-form thematic labels (seed data and the
 * first seven MAG7 profiles). Only used when no vendor profile exists, so a
 * real deterministic source always wins.
 */
export function sectorFromLegacyLabel(
  label: string | null | undefined,
): SectorDecision | null {
  const raw = (label ?? "").trim();
  if (!raw) return null;
  if ((CANONICAL_SECTORS as readonly string[]).includes(raw)) {
    return { sector: raw as CanonicalSector, rule: "canonical", label: raw };
  }
  const legacy: Record<string, CanonicalSector> = {
    大模型: "信息技术",
    "AI 芯片": "信息技术",
    人工智能与语音: "信息技术",
    "计算机视觉与 AI 平台": "信息技术",
    半导体: "信息技术",
    半导体与加速计算: "信息技术",
    半导体代工: "信息技术",
    消费电子: "信息技术",
    软件与云计算: "信息技术",
    "通信与 AI 基础设施": "通信服务",
    "内容平台与 AI": "通信服务",
    互联网平台: "通信服务",
    互联网广告与云计算: "通信服务",
    社交媒体与广告: "通信服务",
    电商与云计算: "可选消费",
    白酒: "必需消费",
    动力电池与储能: "工业",
    新能源汽车与电池: "可选消费",
    电动车与储能: "可选消费",
  };
  const sector = legacy[raw];
  return sector ? { sector, rule: "legacy-label", label: raw } : null;
}

export function isCanonicalSector(value: string): value is CanonicalSector {
  return (CANONICAL_SECTORS as readonly string[]).includes(value);
}

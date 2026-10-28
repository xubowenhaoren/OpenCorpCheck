/**
 * Synthetic development corpus for P2 hybrid-search testing.
 *
 * These are short, hand-written summaries — not scraped filings and not
 * authoritative facts. Every source URL uses the `fixture://` scheme and
 * `trust_tier = 'fixture'` so nothing here can be mistaken for real research.
 * Production corpora come from F10 / SEC / CNINFO / HKEXnews ingestion.
 */

export interface SeedAlias {
  alias: string;
  lang: "zh" | "en" | "und";
  kind: "legal" | "brand" | "former" | "ticker";
  pinyin?: string;
  initials?: string;
}

export interface SeedSecurity {
  ticker: string;
  exchange: string;
  currency: string;
}

export interface SeedDocument {
  key: string;
  title: string;
  docType: "annual_report" | "company_profile" | "news" | "research_note";
  lang: "zh" | "en";
  text: string;
  publishedAt?: string;
}

export interface SeedCompany {
  slug: string;
  legalName: string;
  displayName: string;
  country: string;
  website?: string;
  coverageTier: "index_member" | "ai_watchlist" | "discovered" | "stub";
  sector: string;
  description: string;
  aliases: SeedAlias[];
  ids: Array<{ type: string; value: string }>;
  securities: SeedSecurity[];
  indices: string[];
  documents: SeedDocument[];
}

export const SEED_COMPANIES: SeedCompany[] = [
  {
    slug: "apple",
    legalName: "Apple Inc.",
    displayName: "Apple Inc.",
    country: "US",
    website: "https://www.apple.com",
    coverageTier: "index_member",
    sector: "消费电子",
    description:
      "Apple designs iPhone, Mac, iPad, wearables and services. Services and the App Store are its highest-margin growth engine.",
    aliases: [
      { alias: "苹果", lang: "zh", kind: "brand" },
      { alias: "苹果公司", lang: "zh", kind: "legal" },
      { alias: "AAPL", lang: "en", kind: "ticker" },
      { alias: "Apple", lang: "en", kind: "brand" },
    ],
    ids: [
      { type: "ticker", value: "AAPL" },
      { type: "cik", value: "0000320193" },
      { type: "domain", value: "apple.com" },
    ],
    securities: [{ ticker: "AAPL", exchange: "NASDAQ", currency: "USD" }],
    indices: ["SPX", "NDX"],
    documents: [
      {
        key: "apple-profile",
        title: "Apple 公司概况（fixture）",
        docType: "company_profile",
        lang: "zh",
        text: "苹果公司（Apple Inc.）是全球领先的消费电子公司，核心产品包括 iPhone、Mac、iPad、Apple Watch 和 AirPods。公司通过 App Store、iCloud、Apple Music 和 Apple Pay 等服务业务获得高毛利收入。苹果拥有强大的品牌、软硬件生态和用户切换成本，供应链遍及中国、印度和越南。",
      },
      {
        key: "apple-services",
        title: "Apple services growth note (fixture)",
        docType: "research_note",
        lang: "en",
        text: "Apple's services segment, including the App Store, iCloud, advertising and subscriptions, has grown faster than hardware. Installed-base monetization and ecosystem lock-in are the main drivers. Regulatory pressure on App Store commissions is a key risk.",
      },
    ],
  },
  {
    slug: "microsoft",
    legalName: "Microsoft Corporation",
    displayName: "Microsoft Corporation",
    country: "US",
    website: "https://www.microsoft.com",
    coverageTier: "index_member",
    sector: "软件与云计算",
    description:
      "Microsoft sells Azure cloud, Office 365, Windows, Dynamics and Copilot AI products to enterprises worldwide.",
    aliases: [
      { alias: "微软", lang: "zh", kind: "brand" },
      { alias: "Microsoft", lang: "en", kind: "brand" },
      { alias: "MSFT", lang: "en", kind: "ticker" },
    ],
    ids: [
      { type: "ticker", value: "MSFT" },
      { type: "cik", value: "0000789019" },
      { type: "domain", value: "microsoft.com" },
    ],
    securities: [{ ticker: "MSFT", exchange: "NASDAQ", currency: "USD" }],
    indices: ["SPX", "NDX"],
    documents: [
      {
        key: "microsoft-cloud",
        title: "微软智能云与 Copilot（fixture）",
        docType: "company_profile",
        lang: "zh",
        text: "微软的智能云业务包括 Azure、Office 365、Dynamics 365 和 GitHub。Azure 提供云计算、AI 基础设施和 Copilot 服务，是企业级大模型落地的主要平台之一。微软与 OpenAI 深度合作，将 GPT 模型嵌入 Office、Windows 和开发者工具。",
      },
      {
        key: "microsoft-ai",
        title: "Microsoft AI infrastructure note (fixture)",
        docType: "research_note",
        lang: "en",
        text: "Microsoft is one of the largest buyers of AI accelerators and operates global data-center capacity for Azure. Copilot monetization, cloud gross margin and capital expenditure are the key variables to watch.",
      },
    ],
  },
  {
    slug: "alphabet",
    legalName: "Alphabet Inc.",
    displayName: "Alphabet Inc.",
    country: "US",
    website: "https://abc.xyz",
    coverageTier: "index_member",
    sector: "互联网广告与云计算",
    description:
      "Alphabet owns Google Search, YouTube, Android, Google Cloud and the Gemini model family.",
    aliases: [
      { alias: "谷歌", lang: "zh", kind: "brand" },
      { alias: "Google", lang: "en", kind: "brand" },
      { alias: "GOOGL", lang: "en", kind: "ticker" },
      { alias: "GOOG", lang: "en", kind: "ticker" },
    ],
    ids: [
      { type: "ticker", value: "GOOGL" },
      { type: "cik", value: "0001652044" },
      { type: "domain", value: "abc.xyz" },
    ],
    securities: [
      { ticker: "GOOGL", exchange: "NASDAQ", currency: "USD" },
      { ticker: "GOOG", exchange: "NASDAQ", currency: "USD" },
    ],
    indices: ["SPX", "NDX"],
    documents: [
      {
        key: "alphabet-ai",
        title: "Alphabet 搜索、云与 Gemini（fixture）",
        docType: "company_profile",
        lang: "zh",
        text: "Alphabet 旗下 Google 搜索和广告是主要收入来源，YouTube 提供视频广告和订阅。Google Cloud 提供云计算、数据分析和 Gemini 大模型服务，是企业 AI 市场的重要参与者。公司同时通过 Waymo 布局自动驾驶。",
      },
    ],
  },
  {
    slug: "amazon",
    legalName: "Amazon.com, Inc.",
    displayName: "Amazon.com, Inc.",
    country: "US",
    website: "https://www.amazon.com",
    coverageTier: "index_member",
    sector: "电商与云计算",
    description:
      "Amazon operates the largest online marketplace, AWS cloud, advertising and Prime membership.",
    aliases: [
      { alias: "亚马逊", lang: "zh", kind: "brand" },
      { alias: "Amazon", lang: "en", kind: "brand" },
      { alias: "AMZN", lang: "en", kind: "ticker" },
      { alias: "AWS", lang: "en", kind: "brand" },
    ],
    ids: [
      { type: "ticker", value: "AMZN" },
      { type: "cik", value: "0001018724" },
      { type: "domain", value: "amazon.com" },
    ],
    securities: [{ ticker: "AMZN", exchange: "NASDAQ", currency: "USD" }],
    indices: ["SPX", "NDX"],
    documents: [
      {
        key: "amazon-aws",
        title: "亚马逊电商与 AWS（fixture）",
        docType: "company_profile",
        lang: "zh",
        text: "亚马逊的核心业务包括电商 marketplace、AWS 云计算、广告和 Prime 会员。AWS 是全球最大的云基础设施提供商，提供计算、存储、数据库和 AI 服务。广告业务利润率较高，是近年来增长最快的板块之一。",
      },
    ],
  },
  {
    slug: "nvidia",
    legalName: "NVIDIA Corporation",
    displayName: "NVIDIA Corporation",
    country: "US",
    website: "https://www.nvidia.com",
    coverageTier: "index_member",
    sector: "半导体与加速计算",
    description:
      "NVIDIA designs GPUs and AI accelerators, led by data-center products and the CUDA software ecosystem.",
    aliases: [
      { alias: "英伟达", lang: "zh", kind: "brand" },
      { alias: "NVIDIA", lang: "en", kind: "brand" },
      { alias: "NVDA", lang: "en", kind: "ticker" },
      { alias: "黄仁勋", lang: "zh", kind: "brand" },
    ],
    ids: [
      { type: "ticker", value: "NVDA" },
      { type: "cik", value: "0001045810" },
      { type: "domain", value: "nvidia.com" },
    ],
    securities: [{ ticker: "NVDA", exchange: "NASDAQ", currency: "USD" }],
    indices: ["SPX", "NDX"],
    documents: [
      {
        key: "nvidia-ai-chips",
        title: "NVIDIA 数据中心与 AI 芯片（fixture）",
        docType: "company_profile",
        lang: "zh",
        text: "英伟达（NVIDIA）是全球领先的加速计算公司，主要产品包括 GeForce 游戏 GPU、数据中心 GPU（H100、H200、Blackwell）、CUDA 软件平台和网络设备。数据中心业务是公司最大收入来源，AI 训练和推理需求推动其高速增长。公司面临 AMD、寒武纪、华为昇腾等 AI 芯片厂商的竞争。",
      },
      {
        key: "nvidia-cuda",
        title: "NVIDIA CUDA moat (fixture)",
        docType: "research_note",
        lang: "en",
        text: "CUDA and the surrounding developer ecosystem remain NVIDIA's strongest moat in AI accelerators. The company's networking and system-level offerings increasingly compete with custom ASICs from hyperscalers.",
      },
    ],
  },
  {
    slug: "amd",
    legalName: "Advanced Micro Devices, Inc.",
    displayName: "Advanced Micro Devices, Inc.",
    country: "US",
    website: "https://www.amd.com",
    coverageTier: "index_member",
    sector: "半导体",
    description:
      "AMD designs CPUs and GPUs for data centers, PCs and embedded markets, including Instinct AI accelerators.",
    aliases: [
      { alias: "超威半导体", lang: "zh", kind: "legal" },
      { alias: "AMD", lang: "en", kind: "ticker" },
    ],
    ids: [
      { type: "ticker", value: "AMD" },
      { type: "domain", value: "amd.com" },
    ],
    securities: [{ ticker: "AMD", exchange: "NASDAQ", currency: "USD" }],
    indices: ["SPX", "NDX"],
    documents: [
      {
        key: "amd-ai",
        title: "AMD 数据中心与 AI 加速器（fixture）",
        docType: "company_profile",
        lang: "zh",
        text: "AMD 设计 EPYC 服务器 CPU、Ryzen 客户端 CPU 和 Instinct 数据中心 GPU。MI300 系列 AI 加速器是英伟达 GPU 的主要替代方案之一，微软、Meta 等云厂商已开始部署。AMD 的挑战在于软件生态 ROCm 相对 CUDA 仍不成熟。",
      },
    ],
  },
  {
    slug: "meta",
    legalName: "Meta Platforms, Inc.",
    displayName: "Meta Platforms, Inc.",
    country: "US",
    website: "https://about.meta.com",
    coverageTier: "index_member",
    sector: "社交媒体与广告",
    description:
      "Meta operates Facebook, Instagram, WhatsApp and Threads, monetized by advertising, and invests heavily in AI and the metaverse.",
    aliases: [
      { alias: "Meta", lang: "en", kind: "brand" },
      { alias: "Facebook", lang: "en", kind: "former" },
      { alias: "脸书", lang: "zh", kind: "brand" },
      { alias: "META", lang: "en", kind: "ticker" },
    ],
    ids: [
      { type: "ticker", value: "META" },
      { type: "cik", value: "0001326801" },
      { type: "domain", value: "meta.com" },
    ],
    securities: [{ ticker: "META", exchange: "NASDAQ", currency: "USD" }],
    indices: ["SPX", "NDX"],
    documents: [
      {
        key: "meta-ads-ai",
        title: "Meta 社交广告与 Llama（fixture）",
        docType: "company_profile",
        lang: "zh",
        text: "Meta 运营 Facebook、Instagram、WhatsApp 和 Threads，收入几乎全部来自广告。公司利用 AI 推荐系统提升广告转化率，并开源 Llama 系列大模型。Reality Labs 负责 VR/AR 硬件，仍处于高投入阶段。",
      },
    ],
  },
  {
    slug: "tesla",
    legalName: "Tesla, Inc.",
    displayName: "Tesla, Inc.",
    country: "US",
    website: "https://www.tesla.com",
    coverageTier: "index_member",
    sector: "电动车与储能",
    description:
      "Tesla builds electric vehicles, energy storage and solar products, and develops FSD autonomous driving software.",
    aliases: [
      { alias: "特斯拉", lang: "zh", kind: "brand" },
      { alias: "Tesla", lang: "en", kind: "brand" },
      { alias: "TSLA", lang: "en", kind: "ticker" },
    ],
    ids: [
      { type: "ticker", value: "TSLA" },
      { type: "cik", value: "0001318605" },
      { type: "domain", value: "tesla.com" },
    ],
    securities: [{ ticker: "TSLA", exchange: "NASDAQ", currency: "USD" }],
    indices: ["SPX", "NDX"],
    documents: [
      {
        key: "tesla-ev",
        title: "特斯拉整车、储能与 FSD（fixture）",
        docType: "company_profile",
        lang: "zh",
        text: "特斯拉设计、制造和销售电动汽车，主要车型包括 Model 3、Model Y、Model S 和 Model X。能源业务提供 Megapack 储能系统和太阳能产品。公司还在开发 FSD 自动驾驶软件和人形机器人 Optimus。",
      },
    ],
  },
  {
    slug: "kweichow-moutai",
    legalName: "贵州茅台酒股份有限公司",
    displayName: "贵州茅台",
    country: "CN",
    website: "https://www.moutaichina.com",
    coverageTier: "index_member",
    sector: "白酒",
    description:
      "贵州茅台生产销售酱香型白酒，核心产品飞天茅台依靠品牌、产地和稀缺性维持高毛利。",
    aliases: [
      { alias: "贵州茅台", lang: "zh", kind: "brand" },
      { alias: "茅台", lang: "zh", kind: "brand" },
      { alias: "飞天茅台", lang: "zh", kind: "brand" },
      { alias: "Kweichow Moutai", lang: "en", kind: "legal" },
      { alias: "Moutai", lang: "en", kind: "brand" },
      { alias: "gzmt", lang: "zh", kind: "brand", initials: "gzmt" },
      { alias: "600519", lang: "zh", kind: "ticker" },
    ],
    ids: [
      { type: "ticker", value: "600519" },
      { type: "ticker", value: "600519.SH" },
    ],
    securities: [{ ticker: "600519", exchange: "SSE", currency: "CNY" }],
    indices: ["A500"],
    documents: [
      {
        key: "moutai-profile",
        title: "贵州茅台公司概况（fixture）",
        docType: "company_profile",
        lang: "zh",
        text: "贵州茅台酒股份有限公司主要生产销售酱香型白酒，核心产品为飞天茅台。公司依靠品牌、赤水河产地和基酒稀缺性维持高毛利率，渠道包括直销和经销。白酒消费与商务宴请、礼品需求和居民消费能力相关。",
      },
      {
        key: "moutai-channel",
        title: "贵州茅台渠道与价格体系（fixture）",
        docType: "research_note",
        lang: "zh",
        text: "贵州茅台近年推进渠道改革，提高直销比例，i茅台电商平台贡献增量。飞天茅台批价与出厂价之间的价差是观察供需的重要指标。系列酒承担大众价格带，但品牌力弱于主品牌。",
      },
    ],
  },
  {
    slug: "tencent",
    legalName: "腾讯控股有限公司",
    displayName: "腾讯控股",
    country: "CN",
    website: "https://www.tencent.com",
    coverageTier: "index_member",
    sector: "互联网平台",
    description:
      "腾讯经营微信、QQ、游戏、广告、金融科技和腾讯云，混元大模型接入多个产品。",
    aliases: [
      { alias: "腾讯", lang: "zh", kind: "brand" },
      { alias: "腾讯控股", lang: "zh", kind: "legal" },
      { alias: "Tencent", lang: "en", kind: "brand" },
      { alias: "0700.HK", lang: "en", kind: "ticker" },
      { alias: "700.HK", lang: "en", kind: "ticker" },
      { alias: "00700", lang: "zh", kind: "ticker" },
      { alias: "tx", lang: "zh", kind: "brand", initials: "tx" },
    ],
    ids: [
      { type: "ticker", value: "00700.HK" },
      { type: "ticker", value: "0700.HK" },
      { type: "ticker", value: "00700" },
    ],
    securities: [{ ticker: "00700", exchange: "HKEX", currency: "HKD" }],
    indices: ["HSI"],
    documents: [
      {
        key: "tencent-profile",
        title: "腾讯控股公司概况（fixture）",
        docType: "company_profile",
        lang: "zh",
        text: "腾讯控股有限公司经营微信、QQ、游戏、广告、金融科技和云计算业务。微信是中国最大的社交平台，视频号和小程序生态持续扩张。游戏业务包括王者荣耀、和平精英等，海外工作室贡献增加。腾讯云为企业提供云计算和 AI 服务，混元大模型已接入多个产品。",
      },
      {
        key: "tencent-ads",
        title: "腾讯广告与视频号（fixture）",
        docType: "research_note",
        lang: "zh",
        text: "视频号是腾讯广告增长的主要驱动力，直播电商和创作者生态提升了用户时长。小程序连接线下服务和交易，形成微信内的商业闭环。金融科技与企业服务收入受支付活跃度和云业务影响。",
      },
    ],
  },
  {
    slug: "alibaba",
    legalName: "阿里巴巴集团控股有限公司",
    displayName: "阿里巴巴",
    country: "CN",
    website: "https://www.alibabagroup.com",
    coverageTier: "index_member",
    sector: "电商与云计算",
    description:
      "阿里巴巴经营淘宝、天猫、阿里云、菜鸟和国际电商业务，通义大模型提供 AI 服务。",
    aliases: [
      { alias: "阿里巴巴", lang: "zh", kind: "brand" },
      { alias: "阿里", lang: "zh", kind: "brand" },
      { alias: "Alibaba", lang: "en", kind: "brand" },
      { alias: "BABA", lang: "en", kind: "ticker" },
      { alias: "09988.HK", lang: "en", kind: "ticker" },
      { alias: "9988.HK", lang: "en", kind: "ticker" },
    ],
    ids: [
      { type: "ticker", value: "BABA" },
      { type: "ticker", value: "09988.HK" },
    ],
    securities: [
      { ticker: "BABA", exchange: "NYSE", currency: "USD" },
      { ticker: "09988", exchange: "HKEX", currency: "HKD" },
    ],
    indices: ["HSI"],
    documents: [
      {
        key: "alibaba-cloud",
        title: "阿里巴巴电商与阿里云（fixture）",
        docType: "company_profile",
        lang: "zh",
        text: "阿里巴巴的核心业务包括淘宝天猫电商、阿里云、菜鸟物流和国际电商。阿里云是中国市场份额领先的云服务商，提供计算、数据库和通义大模型服务。电商业务面临拼多多、京东和抖音电商的竞争，公司通过低价策略和用户增长投入应对。",
      },
    ],
  },
  {
    slug: "catl",
    legalName: "宁德时代新能源科技股份有限公司",
    displayName: "宁德时代",
    country: "CN",
    website: "https://www.catl.com",
    coverageTier: "index_member",
    sector: "动力电池与储能",
    description:
      "宁德时代是全球领先的动力电池和储能电池制造商，产品覆盖三元锂、磷酸铁锂和钠离子电池。",
    aliases: [
      { alias: "宁德时代", lang: "zh", kind: "brand" },
      { alias: "宁德", lang: "zh", kind: "brand" },
      { alias: "CATL", lang: "en", kind: "brand" },
      { alias: "ndsd", lang: "zh", kind: "brand", initials: "ndsd" },
      { alias: "300750", lang: "zh", kind: "ticker" },
    ],
    ids: [
      { type: "ticker", value: "300750" },
      { type: "ticker", value: "300750.SZ" },
    ],
    securities: [{ ticker: "300750", exchange: "SZSE", currency: "CNY" }],
    indices: ["A500"],
    documents: [
      {
        key: "catl-battery",
        title: "宁德时代动力电池与储能（fixture）",
        docType: "company_profile",
        lang: "zh",
        text: "宁德时代新能源科技股份有限公司是全球领先的动力电池和储能电池制造商。公司主营三元锂离子电池、磷酸铁锂电池、钠离子电池及储能系统，客户覆盖特斯拉、宝马、奔驰、蔚来、理想等整车厂。2025 年公司动力电池全球市占率继续保持第一，储能电池出货量快速增长。公司持续投入固态电池、快充和换电技术研发。",
      },
      {
        key: "catl-storage",
        title: "宁德时代储能业务（fixture）",
        docType: "research_note",
        lang: "zh",
        text: "储能电池是宁德时代增长最快的业务之一，客户包括电网、发电集团和海外储能集成商。储能电芯价格下降推动需求增长，但也压缩单位盈利。公司通过规模、良率和供应链一体化维持成本优势。",
      },
    ],
  },
  {
    slug: "byd",
    legalName: "比亚迪股份有限公司",
    displayName: "比亚迪",
    country: "CN",
    website: "https://www.byd.com",
    coverageTier: "index_member",
    sector: "新能源汽车与电池",
    description:
      "比亚迪生产新能源汽车、动力电池、电子零部件和轨道交通设备，垂直整合程度高。",
    aliases: [
      { alias: "比亚迪", lang: "zh", kind: "brand" },
      { alias: "BYD", lang: "en", kind: "brand" },
      { alias: "002594", lang: "zh", kind: "ticker" },
      { alias: "byd", lang: "zh", kind: "brand", initials: "byd" },
    ],
    ids: [
      { type: "ticker", value: "002594" },
      { type: "ticker", value: "002594.SZ" },
    ],
    securities: [{ ticker: "002594", exchange: "SZSE", currency: "CNY" }],
    indices: ["A500"],
    documents: [
      {
        key: "byd-profile",
        title: "比亚迪整车与电池（fixture）",
        docType: "company_profile",
        lang: "zh",
        text: "比亚迪是中国领先的新能源汽车制造商，同时生产动力电池、半导体和电子零部件。公司采用垂直整合模式，刀片电池和 DM 混动技术是核心卖点。比亚迪还经营轨道交通和储能业务，并加速海外市场扩张。",
      },
    ],
  },
  {
    slug: "cambricon",
    legalName: "中科寒武纪科技股份有限公司",
    displayName: "寒武纪",
    country: "CN",
    website: "https://www.cambricon.com",
    coverageTier: "ai_watchlist",
    sector: "AI 芯片",
    description:
      "寒武纪设计云端和边缘 AI 芯片及加速卡，是中国本土 AI 算力的代表厂商之一。",
    aliases: [
      { alias: "寒武纪", lang: "zh", kind: "brand" },
      { alias: "中科寒武纪", lang: "zh", kind: "legal" },
      { alias: "Cambricon", lang: "en", kind: "brand" },
      { alias: "688256", lang: "zh", kind: "ticker" },
    ],
    ids: [
      { type: "ticker", value: "688256.SH" },
      { type: "ticker", value: "688256" },
    ],
    securities: [{ ticker: "688256", exchange: "SSE", currency: "CNY" }],
    indices: [],
    documents: [
      {
        key: "cambricon-ai",
        title: "寒武纪 AI 芯片与加速卡（fixture）",
        docType: "company_profile",
        lang: "zh",
        text: "寒武纪（Cambricon）设计云端训练和推理 AI 芯片、边缘智能芯片及加速卡，产品用于数据中心和行业智能计算。公司是中国本土 AI 芯片的重要厂商，受益于算力国产化需求，但面临英伟达 CUDA 生态和华为昇腾的竞争。",
      },
    ],
  },
  {
    slug: "iflytek",
    legalName: "科大讯飞股份有限公司",
    displayName: "科大讯飞",
    country: "CN",
    website: "https://www.iflytek.com",
    coverageTier: "ai_watchlist",
    sector: "人工智能与语音",
    description:
      "科大讯飞提供语音识别、语音合成、教育、医疗和星火大模型等 AI 产品与服务。",
    aliases: [
      { alias: "科大讯飞", lang: "zh", kind: "brand" },
      { alias: "讯飞", lang: "zh", kind: "brand" },
      { alias: "iFlytek", lang: "en", kind: "brand" },
      { alias: "002230", lang: "zh", kind: "ticker" },
    ],
    ids: [
      { type: "ticker", value: "002230.SZ" },
      { type: "ticker", value: "002230" },
    ],
    securities: [{ ticker: "002230", exchange: "SZSE", currency: "CNY" }],
    indices: [],
    documents: [
      {
        key: "iflytek-profile",
        title: "科大讯飞语音与星火大模型（fixture）",
        docType: "company_profile",
        lang: "zh",
        text: "科大讯飞是中国领先的智能语音和人工智能公司，提供语音识别、语音合成、自然语言理解和教育硬件。星火大模型已接入学习机、办公本、医疗和车载场景。公司客户以政府、教育和企业为主。",
      },
    ],
  },
  {
    slug: "sensetime",
    legalName: "商汤集团股份有限公司",
    displayName: "商汤",
    country: "CN",
    website: "https://www.sensetime.com",
    coverageTier: "ai_watchlist",
    sector: "计算机视觉与 AI 平台",
    description:
      "商汤提供计算机视觉、大模型和 AI 基础设施，日日新大模型面向企业客户。",
    aliases: [
      { alias: "商汤", lang: "zh", kind: "brand" },
      { alias: "商汤科技", lang: "zh", kind: "legal" },
      { alias: "SenseTime", lang: "en", kind: "brand" },
      { alias: "0020.HK", lang: "en", kind: "ticker" },
    ],
    ids: [
      { type: "ticker", value: "0020.HK" },
      { type: "ticker", value: "00020.HK" },
    ],
    securities: [{ ticker: "0020", exchange: "HKEX", currency: "HKD" }],
    indices: [],
    documents: [
      {
        key: "sensetime-profile",
        title: "商汤计算机视觉与大模型（fixture）",
        docType: "company_profile",
        lang: "zh",
        text: "商汤集团提供计算机视觉、深度学习平台和 AI 基础设施，业务覆盖智慧城市、汽车、医疗和内容生成。日日新大模型面向企业提供多模态能力。公司长期投入研发，盈利能力仍是市场关注点。",
      },
    ],
  },
  {
    slug: "smic",
    legalName: "中芯国际集成电路制造有限公司",
    displayName: "中芯国际",
    country: "CN",
    website: "https://www.smics.com",
    coverageTier: "index_member",
    sector: "半导体代工",
    description:
      "中芯国际是中国大陆最大的集成电路晶圆代工厂，提供成熟制程和部分先进制程代工服务。",
    aliases: [
      { alias: "中芯国际", lang: "zh", kind: "brand" },
      { alias: "中芯", lang: "zh", kind: "brand" },
      { alias: "SMIC", lang: "en", kind: "brand" },
      { alias: "688981", lang: "zh", kind: "ticker" },
    ],
    ids: [
      { type: "ticker", value: "688981.SH" },
      { type: "ticker", value: "688981" },
    ],
    securities: [{ ticker: "688981", exchange: "SSE", currency: "CNY" }],
    indices: ["A500"],
    documents: [
      {
        key: "smic-foundry",
        title: "中芯国际晶圆代工（fixture）",
        docType: "company_profile",
        lang: "zh",
        text: "中芯国际是中国大陆最大的集成电路晶圆代工厂，提供 0.35 微米到 14 纳米及更先进节点的代工服务。公司客户覆盖消费电子、通信、汽车和工业领域。半导体设备出口管制和先进制程研发是主要挑战。",
      },
    ],
  },
  {
    slug: "openai",
    legalName: "OpenAI",
    displayName: "OpenAI",
    country: "US",
    website: "https://openai.com",
    coverageTier: "ai_watchlist",
    sector: "大模型",
    description:
      "OpenAI develops GPT models, ChatGPT and developer APIs, and partners closely with Microsoft.",
    aliases: [
      { alias: "OpenAI", lang: "en", kind: "brand" },
      { alias: "ChatGPT", lang: "en", kind: "brand" },
      { alias: "开放人工智能", lang: "zh", kind: "former" },
    ],
    ids: [{ type: "domain", value: "openai.com" }],
    securities: [],
    indices: [],
    documents: [
      {
        key: "openai-profile",
        title: "OpenAI 大模型与 ChatGPT（fixture）",
        docType: "company_profile",
        lang: "zh",
        text: "OpenAI 是一家美国人工智能研究公司，开发 GPT 系列大语言模型、ChatGPT 和开发者 API 平台。公司与微软深度合作，使用 Azure 算力并向企业客户提供模型服务。OpenAI 同时推进多模态、推理模型和 agent 产品。",
      },
      {
        key: "openai-competition",
        title: "OpenAI competitive landscape (fixture)",
        docType: "research_note",
        lang: "en",
        text: "OpenAI competes with Anthropic, Google DeepMind, Meta and Chinese model labs such as DeepSeek. Model quality, inference cost, enterprise distribution and compute access are the main competitive dimensions.",
      },
    ],
  },
  {
    slug: "anthropic",
    legalName: "Anthropic PBC",
    displayName: "Anthropic",
    country: "US",
    website: "https://www.anthropic.com",
    coverageTier: "ai_watchlist",
    sector: "大模型",
    description:
      "Anthropic develops the Claude model family with a focus on AI safety, and is backed by Google and Amazon.",
    aliases: [
      { alias: "Anthropic", lang: "en", kind: "brand" },
      { alias: "Claude", lang: "en", kind: "brand" },
    ],
    ids: [{ type: "domain", value: "anthropic.com" }],
    securities: [],
    indices: [],
    documents: [
      {
        key: "anthropic-profile",
        title: "Anthropic 与 Claude 大模型（fixture）",
        docType: "company_profile",
        lang: "zh",
        text: "Anthropic 是一家美国 AI 安全公司，开发 Claude 系列大语言模型，强调可解释性、安全对齐和长上下文能力。公司获得 Google 和 Amazon 投资，并通过云平台向企业提供模型服务。Claude 在编程、文档分析和 agent 场景中具有竞争力。",
      },
    ],
  },
  {
    slug: "deepseek",
    legalName: "杭州深度求索人工智能基础技术研究有限公司",
    displayName: "深度求索（DeepSeek）",
    country: "CN",
    website: "https://www.deepseek.com",
    coverageTier: "ai_watchlist",
    sector: "大模型",
    description:
      "DeepSeek develops open-weight large language and reasoning models known for low training and inference cost.",
    aliases: [
      { alias: "DeepSeek", lang: "en", kind: "brand" },
      { alias: "深度求索", lang: "zh", kind: "legal" },
      { alias: "杭州深度求索", lang: "zh", kind: "legal" },
    ],
    ids: [{ type: "domain", value: "deepseek.com" }],
    securities: [],
    indices: [],
    documents: [
      {
        key: "deepseek-profile",
        title: "深度求索与 DeepSeek 大模型（fixture）",
        docType: "company_profile",
        lang: "zh",
        text: "深度求索（DeepSeek）是一家中国人工智能公司，开发 DeepSeek 系列大语言模型和推理模型。公司以开源权重、低成本训练和高效推理著称，模型被广泛用于开发者和企业场景。DeepSeek 的崛起推动了大模型价格下降和开源生态发展。",
      },
    ],
  },
  {
    slug: "bytedance",
    legalName: "字节跳动有限公司",
    displayName: "字节跳动",
    country: "CN",
    website: "https://www.bytedance.com",
    coverageTier: "ai_watchlist",
    sector: "内容平台与 AI",
    description:
      "字节跳动运营抖音、TikTok、今日头条和火山引擎，豆包大模型提供 AI 服务。",
    aliases: [
      { alias: "字节跳动", lang: "zh", kind: "brand" },
      { alias: "字节", lang: "zh", kind: "brand" },
      { alias: "ByteDance", lang: "en", kind: "brand" },
      { alias: "TikTok", lang: "en", kind: "brand" },
      { alias: "抖音", lang: "zh", kind: "brand" },
      { alias: "豆包", lang: "zh", kind: "brand" },
      { alias: "bdt", lang: "zh", kind: "brand", initials: "bdt" },
    ],
    ids: [{ type: "domain", value: "bytedance.com" }],
    securities: [],
    indices: [],
    documents: [
      {
        key: "bytedance-profile",
        title: "字节跳动内容平台与豆包大模型（fixture）",
        docType: "company_profile",
        lang: "zh",
        text: "字节跳动拥有抖音、TikTok、今日头条、飞书等产品，核心能力是推荐算法和内容分发。火山引擎向企业提供云服务和豆包大模型，AI 已嵌入内容创作、广告和办公场景。公司是全球估值最高的未上市科技公司之一。",
      },
    ],
  },
  {
    slug: "moonshot",
    legalName: "月之暗面科技有限公司",
    displayName: "月之暗面（Moonshot AI）",
    country: "CN",
    website: "https://www.moonshot.cn",
    coverageTier: "ai_watchlist",
    sector: "大模型",
    description:
      "Moonshot AI develops the Kimi assistant and long-context language models for Chinese users.",
    aliases: [
      { alias: "月之暗面", lang: "zh", kind: "legal" },
      { alias: "Moonshot AI", lang: "en", kind: "brand" },
      { alias: "Moonshot", lang: "en", kind: "brand" },
      { alias: "Kimi", lang: "zh", kind: "brand" },
    ],
    ids: [{ type: "domain", value: "moonshot.cn" }],
    securities: [],
    indices: [],
    documents: [
      {
        key: "moonshot-profile",
        title: "月之暗面与 Kimi 智能助手（fixture）",
        docType: "company_profile",
        lang: "zh",
        text: "月之暗面（Moonshot AI）是一家中国大模型公司，开发 Kimi 智能助手和长上下文语言模型。Kimi 以长文档阅读、搜索和中文对话体验见长，面向个人用户和企业提供 API 服务。",
      },
    ],
  },
  {
    slug: "zhipu",
    legalName: "北京智谱华章科技有限公司",
    displayName: "智谱 AI",
    country: "CN",
    website: "https://www.zhipuai.cn",
    coverageTier: "ai_watchlist",
    sector: "大模型",
    description:
      "Zhipu AI develops the GLM model family and enterprise model services, with origins in Tsinghua University.",
    aliases: [
      { alias: "智谱", lang: "zh", kind: "brand" },
      { alias: "智谱AI", lang: "zh", kind: "brand" },
      { alias: "Zhipu AI", lang: "en", kind: "brand" },
      { alias: "Zhipu", lang: "en", kind: "brand" },
      { alias: "GLM", lang: "en", kind: "brand" },
    ],
    ids: [
      { type: "domain", value: "zhipuai.cn" },
      { type: "ticker", value: "02513.HK" },
    ],
    securities: [],
    indices: [],
    documents: [
      {
        key: "zhipu-profile",
        title: "智谱 AI 与 GLM 大模型（fixture）",
        docType: "company_profile",
        lang: "zh",
        text: "智谱 AI 源自清华大学，开发 GLM 系列大语言模型和多模态模型，面向企业提供模型 API、私有化部署和行业解决方案。公司是中国大模型创业公司的主要参与者之一，覆盖政务、金融、教育和办公场景。",
      },
    ],
  },
  {
    slug: "huawei",
    legalName: "华为技术有限公司",
    displayName: "华为",
    country: "CN",
    website: "https://www.huawei.com",
    coverageTier: "ai_watchlist",
    sector: "通信与 AI 基础设施",
    description:
      "华为提供通信设备、企业 IT、云计算、智能手机和昇腾 AI 芯片，是中国 AI 算力的重要供应商。",
    aliases: [
      { alias: "华为", lang: "zh", kind: "brand" },
      { alias: "Huawei", lang: "en", kind: "brand" },
      { alias: "昇腾", lang: "zh", kind: "brand" },
      { alias: "Ascend", lang: "en", kind: "brand" },
    ],
    ids: [{ type: "domain", value: "huawei.com" }],
    securities: [],
    indices: [],
    documents: [
      {
        key: "huawei-ascend",
        title: "华为昇腾 AI 芯片与云（fixture）",
        docType: "company_profile",
        lang: "zh",
        text: "华为技术有限公司提供通信网络设备、企业 IT、华为云、智能手机和昇腾 AI 芯片。昇腾系列加速卡和 MindSpore 框架构成国产 AI 算力栈，被中国云厂商和政企客户广泛采用。华为同时开发盘古大模型，覆盖行业应用。",
      },
    ],
  },
];

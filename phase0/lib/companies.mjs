export const COMPANIES = [
  {
    ticker: "AAPL",
    company: "Apple Inc.",
    focus: "iPhone 与服务业务、Apple Intelligence、供应链与毛利率",
  },
  {
    ticker: "MSFT",
    company: "Microsoft Corporation",
    focus: "Azure 与 AI 基础设施、OpenAI 合作、Copilot、capex 与自由现金流",
  },
  {
    ticker: "GOOGL",
    company: "Alphabet Inc.",
    focus: "Search/广告、Google Cloud、Gemini、TPU、Anthropic 投资、Waymo",
  },
  {
    ticker: "AMZN",
    company: "Amazon.com, Inc.",
    focus: "AWS、Anthropic 投资、Trainium/Inferentia、零售与广告、capex",
  },
  {
    ticker: "NVDA",
    company: "NVIDIA Corporation",
    focus: "数据中心 GPU、Blackwell/Rubin、CUDA 生态、客户集中、中国出口限制",
  },
  {
    ticker: "META",
    company: "Meta Platforms, Inc.",
    focus: "广告、Llama、AI 基础设施 capex、Reality Labs、监管",
  },
  {
    ticker: "TSLA",
    company: "Tesla, Inc.",
    focus: "电动车、FSD、Optimus、能源业务、xAI 关系、毛利率",
  },
];

export const REQUIRED_SECTIONS = [
  "一句话",
  "公司快照",
  "业务与收入结构",
  "产品与服务",
  "财务表现",
  "质量快照",
  "AI 敞口与战略动向",
  "护城河与竞争格局",
  "关键关系",
  "近12个月大事",
  "风险与反证",
  "未验证与数据缺口",
  "来源",
];

export function normalizeHeading(value) {
  return String(value)
    .replace(/\s+/g, "")
    .replace(/[：:]/g, "")
    .replace(/[（）()]/g, "");
}

export function companyByTicker(ticker) {
  return COMPANIES.find((c) => c.ticker === ticker.toUpperCase());
}

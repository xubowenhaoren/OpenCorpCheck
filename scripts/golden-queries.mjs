/**
 * Curated golden queries for search-quality evaluation.
 *
 * Every expected value is a ticker present in the visible corpus. Keep this
 * list in sync with `config/indices/ndx.yaml`; the generated ticker/name
 * families in `eval-search.mjs` come from that snapshot.
 *
 * Families:
 *   typo      realistic English misspellings
 *   pinyin    first-letter (and full) pinyin for Chinese aliases
 *   natural   natural-language descriptions in Chinese and English
 *   zh-name   Chinese company names
 */

export const TYPO_QUERIES = [
  ["Nvdia", "NVDA"],
  ["Micrsoft", "MSFT"],
  ["Googel", "GOOGL"],
  ["Amazn", "AMZN"],
  ["Teslla", "TSLA"],
  ["Brodcom", "AVGO"],
  ["Qalcomm", "QCOM"],
  ["Intell Corporaton", "INTC"],
  ["Adboe", "ADBE"],
  ["Airbnd", "ABNB"],
  ["Neflix", "NFLX"],
  ["Starbuks", "SBUX"],
  ["Costo Wholesale", "COST"],
  ["Paypall", "PYPL"],
  ["Palantirr", "PLTR"],
  ["Fortnet", "FTNT"],
  ["Crowdstrke", "CRWD"],
  ["Datadoq", "DDOG"],
  ["Synopys", "SNPS"],
  ["Cadense Design", "CDNS"],
  ["Marvel Tecnology", "MRVL"],
  ["Shopfy", "SHOP"],
  ["Thompson Reuters", "TRI"],
  ["RocketLab", "RKLB"],
];

export const PINYIN_QUERIES = [
  ["pg", "AAPL"],
  ["pingguo", "AAPL"],
  ["wr", "MSFT"],
  ["gg", "GOOGL"],
  ["ymx", "AMZN"],
  ["ywd", "NVDA"],
  ["yingweida", "NVDA"],
  ["cwbdt", "AMD"],
  ["ls", "META"],
  ["tsl", "TSLA"],
  ["yzgj", "MDLZ"],
  ["kkst", "CMCSA"],
  ["bs", "PEP"],
  ["yte", "INTC"],
  ["tx", "00700"],
  ["gzmt", "600519"],
];

export const NATURAL_QUERIES = [
  ["做 GPU 和 AI 芯片的数据中心公司", ["NVDA", "AMD"]],
  ["CPU 和显卡的芯片设计公司", ["AMD", "NVDA", "INTC", "ARM"]],
  ["iPhone 和 Mac 的制造商", "AAPL"],
  ["Windows 和 Office 的软件公司", "MSFT"],
  ["搜索引擎和在线广告巨头", "GOOGL"],
  ["全球最大的电商和云计算公司", "AMZN"],
  ["社交网络和广告平台", "META"],
  ["电动汽车和储能公司", "TSLA"],
  ["半导体制造设备供应商", ["AMAT", "ASML", "LRCX", "KLAC"]],
  ["光刻机设备公司", "ASML"],
  ["企业网络安全 防火墙 零信任", "PANW"],
  ["云原生监控和可观测性平台", "DDOG"],
  ["端点安全 杀毒软件", ["CRWD", "PANW"]],
  ["人力资源 薪酬外包 工资单", "ADP"],
  ["会员制仓储 批发超市", "COST"],
  ["咖啡连锁店", "SBUX"],
  ["酒店和机票在线预订", "BKNG"],
  ["流媒体 原创剧集", "NFLX"],
  ["在线支付 数字钱包", "PYPL"],
  ["工业设计软件 3D 建模", "ADSK"],
  ["模拟芯片 电源管理", "ADI"],
  ["半导体测试设备", ["TER", "KLAC", "AMAT"]],
  ["网络设备 交换机 路由器", "CSCO"],
  ["独立站 电商 SaaS", "SHOP"],
  ["拉美电商平台", "MELI"],
  ["外卖配送平台", "DASH"],
  ["货运铁路运输", "CSX"],
  ["咖啡胶囊 饮料", "KDP"],
  ["医疗手术机器人", "ISRG"],
  ["AI 云基础设施 GPU 租赁", "CRWV"],
  ["光模块 光通信", "LITE"],
  ["航天火箭 发射服务", ["RKLB", "SPCX"]],
];

export const ZH_NAME_QUERIES = [
  ["苹果", "AAPL"],
  ["微软", "MSFT"],
  ["谷歌", "GOOGL"],
  ["亚马逊", "AMZN"],
  ["英伟达", "NVDA"],
  ["特斯拉", "TSLA"],
  ["超威半导体", "AMD"],
  ["英特尔", "INTC"],
  ["奈飞", "NFLX"],
  ["星巴克", "SBUX"],
  ["好市多", "COST"],
  ["亿滋国际", "MDLZ"],
  ["康卡斯特", "CMCSA"],
  ["百事公司", "PEP"],
  ["腾讯", "00700"],
  ["茅台", "600519"],
];

export const DOC_SEMANTIC_QUERIES = [
  ["模拟芯片 工业 汽车", "Analog Devices, Inc."],
  ["短租 民宿 体验", "Airbnb, Inc."],
  ["薪酬外包 人力资源", "Automatic Data Processing, Inc."],
  ["创意软件 订阅 现金流", "Adobe Inc."],
  ["iPhone 服务 生态", "Apple Inc."],
  ["AI 芯片 GPU 数据中心", "NVIDIA Corporation"],
  ["云计算 广告 搜索", "Alphabet Inc."],
  ["流媒体 内容 订阅", "Netflix, Inc."],
  ["会员制仓储 低价", "Costco Wholesale Corporation"],
  ["电动车 储能 自动驾驶", "Tesla, Inc."],
];

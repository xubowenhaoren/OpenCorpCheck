import type { RelationType } from "@occ/core";

export const RELATION_TYPES: RelationType[] = [
  "owns",
  "parent_of",
  "invests_in",
  "supplies",
  "buys_from",
  "competes_with",
  "partners_with",
  "joint_venture_with",
  "licenses_to",
  "licenses_from",
  "other",
];

export interface UniverseCompany {
  id: string;
  ticker: string;
  displayName: string;
  names: string[];
}

export interface PromptInput {
  company: { displayName: string; ticker?: string };
  chapterText: string;
  citations: Array<{ ref: number; title?: string; publisher?: string }>;
  candidates: UniverseCompany[];
}

export const RELATION_PROMPT_VERSION = "relations-v1";

const SYSTEM = [
  "你是一个公司关系抽取器。只从给定文本中抽取明确写出的公司间关系。",
  "只能使用候选公司列表里的公司，不能引入列表外的公司。",
  "如果文本没有明确关系，返回 {\"relations\":[]}。",
  "必须输出 JSON，不要解释。",
].join("\n");

/**
 * The profile company is always the subject (`src`). Types encode direction:
 * `supplies` = src supplies dst; `buys_from` = src buys from dst;
 * `owns` = src owns a stake in dst; `parent_of` = src is dst's parent.
 */
export function buildRelationPrompt(input: PromptInput): string {
  const candidates = input.candidates
    .map(
      (company) =>
        `- ${company.ticker} | ${company.displayName} | aliases: ${company.names.slice(0, 8).join(", ")}`,
    )
    .join("\n");
  const citations = input.citations
    .map((citation) => `[${citation.ref}] ${citation.publisher ?? citation.title ?? ""}`)
    .join("\n");

  return [
    SYSTEM,
    "",
    `本公司：${input.company.displayName}${input.company.ticker ? `（${input.company.ticker}）` : ""}`,
    "",
    "候选公司（dst 只能从中选择）：",
    candidates,
    "",
    "关系类型（src 固定为本公司）：",
    "- supplies：本公司向对方供货/代工",
    "- buys_from：本公司向对方采购",
    "- competes_with：与对方竞争（对称）",
    "- partners_with：与对方合作（对称）",
    "- joint_venture_with：与对方成立合资公司（对称）",
    "- owns：本公司持有对方股权/拥有对方",
    "- parent_of：本公司是对方的母公司",
    "- invests_in：本公司投资对方（非控股）",
    "- licenses_to：本公司授权对方使用 IP/技术",
    "- licenses_from：本公司从对方获得 IP/技术授权",
    "- other：其他明确关系",
    "",
    "规则：",
    "1. quote 必须是下面文本中的原样片段（可以去掉 [n] 标记），不能改写。",
    "2. refs 只能填文本里出现过的引用编号；没有引用就返回空数组。",
    "3. 不要因为两家公司同属一个行业就判定竞争；必须有明确表述。",
    "4. 最多返回 20 条；没有就返回空数组。",
    "",
    "输出格式：",
    '{"relations":[{"dst_ticker":"GOOGL","type":"buys_from","quote":"原文片段","refs":[10],"confidence":0.7}]}',
    "",
    "可用引用编号：",
    citations || "（无）",
    "",
    "待抽取文本（关键关系章节）：",
    input.chapterText,
  ].join("\n");
}

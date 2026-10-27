import fs from "node:fs";
import path from "node:path";
import { COMPANIES } from "./companies.mjs";
import { sha256File } from "./dsh.mjs";

function readIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
}

function uniqueUrlCount(text) {
  return new Set(
    (text.match(/https?:\/\/[^\s)\]"'<>]+/g) || []).map((u) =>
      u.replace(/[),.;，。；]+$/, ""),
    ),
  ).size;
}

function confidenceOf(text) {
  const match = text.match(/置信度[：:]\s*(高|中|低)/);
  return match ? match[1] : "未标注";
}

export function assemble({
  phaseDir,
  repoRoot,
  model = "deepseek-v4-pro",
  dshVersion = "unknown",
  synthesisFile = null,
}) {
  const outDir = path.join(phaseDir, "out");
  const sectionsDir = path.join(outDir, "sections");
  const date = new Date().toISOString().slice(0, 10);

  const sections = [];
  const rows = [];
  for (const company of COMPANIES) {
    const file = path.join(sectionsDir, `${company.ticker}.md`);
    const text = readIfExists(file);
    if (text) sections.push(text);
    rows.push(
      `| ${company.company} | ${company.ticker} | ${text ? confidenceOf(text) : "缺少"} | ${
        text ? uniqueUrlCount(text) : 0
      } |`,
    );
  }

  const skillPath = path.join(repoRoot, ".dsh", "skills", "mag7-profile", "SKILL.md");
  const skillHash = fs.existsSync(skillPath) ? sha256File(skillPath).slice(0, 12) : "missing";
  const synthesis = synthesisFile ? readIfExists(synthesisFile) : "";
  const summary = synthesis
    ? synthesis
    : `| 公司 | Ticker | 置信度 | 来源数 |\n|---|---|---|---:|\n${rows.join("\n")}`;

  const doc = `# 美股七姐妹 Company Profile

> 生成日期：${date} ｜ 模型：${model} ｜ dsh：${dshVersion} ｜ skill：${skillHash}
>
> 本文由 DeepSeek Harness headless + mag7-profile skill 生成。数据来自公开网页、SEC 文件与
> 公司 IR；不是投资建议。每份 profile 的数字与事实均带编号引用，详见各节“来源”。

## 摘要

${summary}

## 公司 Profile

${sections.join("\n\n---\n\n")}

## 方法、来源与局限

- **流程**：每家公司先做 BFS 广度扫描（公司快照、业务分部、财务、AI 敞口、竞争与风险），
  再做汇合点核对（ticker/CIK、财年、币种、分部 vs 合并口径），最后对 3 个关键 claim 做
  DFS 纵深验证。
- **来源层级**：SEC 10-K/10-Q/8-K、公司 IR 与 earnings release 优先；stockanalysis /
  macrotrends 仅用于交叉校验。
- **数据截止**：${date}。不同公司的财年不同，最新季度也可能不同；以每份 profile 的标注为准。
- **局限**：Phase 0 没有数据库，也没有确定性 XBRL 解析；财务数字来自网页/文件抓取与模型
  抽取，可能存在口径差异。无法确认的数字已标注“未验证/未披露”。
- **免责声明**：本文是研究 demo，不构成投资建议，不提供买入/卖出评级或目标价。
`;

  const outPath = path.join(outDir, "magnificent-seven.md");
  fs.writeFileSync(outPath, doc, "utf8");
  return { outPath, sectionCount: sections.length, rowCount: rows.length };
}

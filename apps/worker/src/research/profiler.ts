import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import type { CompanyTarget } from "../universe.js";

export const DEFAULT_FOCUS =
  "商业模式与收入结构、最新财务表现、竞争格局与近一年战略动向";

const MARKET_LABELS: Record<string, string> = {
  A: "A 股",
  HK: "港股",
  US: "美股",
};

/**
 * MAG7 universe companies keep the tuned US mega-cap skill; everything else
 * (A-share, HK, US non-MAG7, AI watchlist) uses the generic company-profile
 * skill with market-aware source hierarchies and F10 discipline.
 */
export function skillForTarget(
  target: Pick<CompanyTarget, "source">,
): "mag7-profile" | "company-profile" {
  return target.source === "mag7" ? "mag7-profile" : "company-profile";
}

export function skillPath(skill: string): string {
  return path.join(config.repoRoot, ".dsh", "skills", skill, "SKILL.md");
}

export function renderPrompt(
  target: CompanyTarget,
  date = today(),
  skillOverride?: string,
): string {
  const template = fs.readFileSync(config.promptTemplate, "utf8");
  const skill = skillOverride ?? skillForTarget(target);
  const prompt = template
    .replaceAll("{{COMPANY}}", target.name)
    .replaceAll("{{TICKER}}", target.ticker)
    .replaceAll("{{MARKET}}", MARKET_LABELS[target.market ?? ""] ?? "未指明")
    .replaceAll("{{DATE}}", date)
    .replaceAll("{{FOCUS}}", target.focus ?? DEFAULT_FOCUS)
    .replaceAll("{{SKILL}}", skill);
  return (
    `${prompt}\n\n` +
    `重要：请先调用 skill 工具加载 ${skill}，再开始研究。\n` +
    `本会话的联网工具是 mcp__psearch__web_search / mcp__psearch__web_fetch ` +
    `（若不可用，回退到 web_search / web_fetch）。F10 工具是 mcp__occ__f10_scrape。\n` +
    `只返回最终 markdown profile。\n`
  );
}

/**
 * Hash everything that determines the model output: the prompt (including the
 * date and market), the model alias, the skill file and every patch layer. A
 * backfill rerun with the same hash and an intact section is skipped without an
 * LLM call; changing any input — including switching skills — invalidates it.
 */
export function promptHash(
  prompt: string,
  patchPaths: string[],
  skill = "mag7-profile",
): string {
  const hash = createHash("sha256");
  hash.update(prompt);
  hash.update("\0model\0");
  hash.update(config.model);
  for (const file of [skillPath(skill), ...patchPaths]) {
    if (fs.existsSync(file)) hash.update(fs.readFileSync(file));
  }
  return hash.digest("hex");
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

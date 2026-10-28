import { createHash } from "node:crypto";
import fs from "node:fs";

import { config } from "../config.js";
import type { CompanyTarget } from "../universe.js";

export const DEFAULT_FOCUS =
  "business model, segment mix, latest financials, competitive moat and AI exposure";

export function renderPrompt(target: CompanyTarget, date = today()): string {
  const template = fs.readFileSync(config.promptTemplate, "utf8");
  const prompt = template
    .replaceAll("{{COMPANY}}", target.name)
    .replaceAll("{{TICKER}}", target.ticker)
    .replaceAll("{{DATE}}", date)
    .replaceAll("{{FOCUS}}", target.focus ?? DEFAULT_FOCUS);
  return (
    `${prompt}\n\n` +
    "重要：请先调用 skill 工具加载 mag7-profile，再开始研究。只返回最终 markdown profile。\n"
  );
}

/**
 * Hash everything that determines the model output: the prompt (including the
 * date), the model alias, the skill file and every patch layer. A backfill
 * rerun with the same hash and an intact section is skipped without an LLM
 * call; changing any input invalidates the cache.
 */
export function promptHash(prompt: string, patchPaths: string[]): string {
  const hash = createHash("sha256");
  hash.update(prompt);
  hash.update("\0model\0");
  hash.update(config.model);
  for (const file of [config.skillFile, ...patchPaths]) {
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

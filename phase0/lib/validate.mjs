import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMPANIES, REQUIRED_SECTIONS, normalizeHeading } from "./companies.mjs";
import {
  eventUrls,
  isCompleted,
  normalizeUrl,
  parseJsonLines,
  toolCounts,
} from "./dsh.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultPhaseDir = path.resolve(moduleDir, "..");

function readIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function urlsIn(text) {
  const raw = text.match(/https?:\/\/[^\s)\]"'<>]+/g) || [];
  return [
    ...new Set(
      raw.map((url) => normalizeUrl(url.replace(/[),.;，。；]+$/, ""))),
    ),
  ];
}

function hanCount(text) {
  return (text.match(/\p{Script=Han}/gu) || []).length;
}

function findSection(doc, ticker) {
  const blocks = doc.split(/\n(?=## )/);
  return blocks.find((block) => {
    const heading = block.split("\n")[0];
    return (
      heading.includes(`（${ticker}）`) ||
      heading.includes(`(${ticker})`) ||
      new RegExp(`\\b${ticker}\\b`).test(heading)
    );
  });
}

export function validate({ only = null, phaseDir = defaultPhaseDir } = {}) {
  const outDir = path.join(phaseDir, "out");
  const runsDir = path.join(phaseDir, "runs");
  const docPath = path.join(outDir, "magnificent-seven.md");
  const doc = readIfExists(docPath);
  const selected = only
    ? COMPANIES.filter((company) => only.includes(company.ticker))
    : [...COMPANIES];

  const results = [];

  for (const company of selected) {
    const { ticker } = company;
    const eventsPath = path.join(runsDir, `${ticker}.jsonl`);
    const events = fs.existsSync(eventsPath)
      ? parseJsonLines(fs.readFileSync(eventsPath, "utf8"))
      : [];
    const counts = toolCounts(events);
    const knownUrls = eventUrls(events);
    const completed = isCompleted(events);
    const section = doc ? findSection(doc, ticker) : null;

    const errors = [];
    const warnings = [];

    if (!doc) {
      errors.push("out/magnificent-seven.md 不存在");
    }
    if (!section) {
      errors.push("最终文档中没有找到该公司的 profile 章节");
    }

    let missingSections = [];
    let charCount = 0;
    let sourceUrls = [];
    let unverified = [];

    if (section) {
      const normalized = normalizeHeading(section);
      missingSections = REQUIRED_SECTIONS.filter(
        (required) => !normalized.includes(normalizeHeading(required)),
      );
      if (missingSections.length) {
        errors.push(`缺少章节: ${missingSections.join(", ")}`);
      }

      charCount = hanCount(section);
      if (charCount < 600) errors.push(`中文字数过少: ${charCount} < 600`);
      else if (charCount < 800) warnings.push(`中文字数低于目标: ${charCount} < 800`);
      if (charCount > 2000) warnings.push(`中文字数偏多: ${charCount} > 2000`);

      sourceUrls = urlsIn(section);
      if (sourceUrls.length < 3) {
        errors.push(`来源不足: ${sourceUrls.length} < 3`);
      }
      unverified = sourceUrls.filter((url) => !knownUrls.has(url));
      if (unverified.length > 0) {
        warnings.push(`有 ${unverified.length} 个来源未出现在工具事件中`);
      }
      if (unverified.length > 2) {
        errors.push(`未验证来源过多: ${unverified.length} > 2`);
      }

      if (!/置信度[：:]\s*(高|中|低)/.test(section)) {
        warnings.push("缺少置信度标注");
      }
      if (/\bTODO\b|\bTBD\b|待补充|placeholder/i.test(section)) {
        errors.push("包含 TODO/TBD/待补充/placeholder");
      }
    }

    const searchCalls = counts.web_search || 0;
    const fetchCalls = counts.web_fetch || 0;
    if (searchCalls < 1) errors.push(`web_search 调用次数: ${searchCalls} < 1`);
    if (fetchCalls < 2) errors.push(`web_fetch 调用次数: ${fetchCalls} < 2`);
    if (!completed) errors.push("dsh turn 未正常完成（final.reason != completed）");

    const status = errors.length ? "fail" : warnings.length ? "warn" : "pass";
    results.push({
      ticker,
      company: company.company,
      status,
      charCount,
      sourceCount: sourceUrls.length,
      searchCalls,
      fetchCalls,
      missingSections,
      unverifiedCitations: unverified,
      errors,
      warnings,
    });
  }

  const ok = results.every((result) => result.status !== "fail");
  const summary = {
    generatedAt: new Date().toISOString(),
    doc: docPath,
    ok,
    companies: results,
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "run-summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
    "utf8",
  );

  const header = "Ticker  Status  Chars  Sources  Search  Fetch  Missing  Unverified";
  const lines = [header, "-".repeat(header.length)];
  for (const result of results) {
    lines.push(
      [
        result.ticker.padEnd(6),
        result.status.padEnd(6),
        String(result.charCount).padEnd(5),
        String(result.sourceCount).padEnd(7),
        String(result.searchCalls).padEnd(6),
        String(result.fetchCalls).padEnd(5),
        String(result.missingSections.length).padEnd(7),
        String(result.unverifiedCitations.length),
      ].join("  "),
    );
  }
  console.log(lines.join("\n"));
  for (const result of results) {
    if (result.errors.length) {
      console.log(`\n[${result.ticker}] errors:`);
      for (const error of result.errors) console.log(`  - ${error}`);
    }
    if (result.warnings.length) {
      console.log(`[${result.ticker}] warnings:`);
      for (const warning of result.warnings) console.log(`  - ${warning}`);
    }
  }
  console.log(`\nResult: ${ok ? "PASS" : "FAIL"} (${summary.doc})`);

  return { ok, results, summary };
}

function parseOnly(argv) {
  const index = argv.indexOf("--only");
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value) return null;
  return value
    .split(",")
    .map((ticker) => ticker.trim().toUpperCase())
    .filter(Boolean);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const only = parseOnly(process.argv.slice(2));
  const { ok } = validate({ only });
  process.exit(ok ? 0 : 1);
}

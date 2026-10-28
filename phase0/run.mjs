import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMPANIES } from "./lib/companies.mjs";
import {
  DEFAULT_MODEL,
  DSH_VERSION,
  ensureDir,
  eventUrls,
  isCompleted,
  loadEnv,
  runHeadless,
  sha256File,
  toolCounts,
  usageTotals,
} from "./lib/dsh.mjs";
import { assemble } from "./lib/assemble.mjs";
import { validate } from "./lib/validate.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..");
const outDir = path.join(moduleDir, "out");
const sectionsDir = path.join(outDir, "sections");
const runsDir = path.join(moduleDir, "runs");
const dshHome = path.join(moduleDir, ".dsh-home");
const date = new Date().toISOString().slice(0, 10);

const argv = process.argv.slice(2);
const mock = argv.includes("--mock");
const force = argv.includes("--force");
const synthesize = argv.includes("--synthesize");
const searchApi = argv.includes("--search-api");
const onlyArg = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
const concurrencyArg = argv.includes("--concurrency")
  ? Number(argv[argv.indexOf("--concurrency") + 1])
  : 4;

const only = onlyArg
  ? onlyArg
      .split(",")
      .map((ticker) => ticker.trim().toUpperCase())
      .filter(Boolean)
  : null;
const selected = only ? COMPANIES.filter((c) => only.includes(c.ticker)) : [...COMPANIES];
const concurrency = Number.isFinite(concurrencyArg) && concurrencyArg > 0 ? concurrencyArg : 4;
const model = process.env.DSH_MODEL || DEFAULT_MODEL;

loadEnv(path.join(moduleDir, ".env"));
loadEnv(path.join(repoRoot, ".env"));
ensureDir(outDir);
ensureDir(sectionsDir);
ensureDir(runsDir);
ensureDir(dshHome);

if (only && selected.length !== only.length) {
  console.error(`Unknown ticker in --only: ${only.filter((t) => !COMPANIES.some((c) => c.ticker === t)).join(", ")}`);
  process.exit(2);
}
if (!mock && !process.env.DEEPSEEK_API_KEY) {
  console.error(
    [
      "DEEPSEEK_API_KEY is missing.",
      `Put it in ${path.join(moduleDir, ".env")} (copy .env.example) or export it.`,
      "To test the pipeline without an API key, run: npm run research -- --mock",
    ].join("\n"),
  );
  process.exit(2);
}

const patchPaths = [path.join(moduleDir, "dsh.patch.yml")];
if (searchApi) patchPaths.push(path.join(moduleDir, "search-api.patch.yml"));

function readIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function renderPrompt(company, repair = false) {
  const template = fs.readFileSync(path.join(moduleDir, "prompts", "company.md"), "utf8");
  const prompt = template
    .replaceAll("{{COMPANY}}", company.company)
    .replaceAll("{{TICKER}}", company.ticker)
    .replaceAll("{{DATE}}", date)
    .replaceAll("{{FOCUS}}", company.focus);
  const skillLine =
    "重要：请先调用 skill 工具加载 mag7-profile，再开始研究。只返回最终 markdown profile。\n";
  const repairLine = repair
    ? "\n上一次运行没有返回可用的 profile。这次务必先加载 mag7-profile skill，完整输出全部 13 个章节，只返回 markdown。\n"
    : "";
  return `${prompt}\n\n${skillLine}${repairLine}`;
}

function sectionPath(ticker) {
  return path.join(sectionsDir, `${ticker}.md`);
}

function writeMockRun(company) {
  const ticker = company.ticker;
  const fixture = fs.readFileSync(path.join(moduleDir, "fixtures", "mock-section.md"), "utf8");
  const text = fixture
    .replaceAll("{{COMPANY}}", company.company)
    .replaceAll("{{TICKER}}", ticker)
    .replaceAll("{{DATE}}", date);
  fs.writeFileSync(sectionPath(ticker), text, "utf8");

  const secUrl = "https://www.sec.gov/edgar/searchedgar/companysearch";
  const irUrl = `https://example.com/${ticker}/ir`;
  const tenKUrl = `https://example.com/${ticker}/10k`;
  const events = [
    { type: "session", sessionId: `mock-${ticker}`, cwd: repoRoot },
    { type: "status", phase: "turn_start", turn: 1 },
    {
      type: "tool_call",
      callId: `mock-search-${ticker}`,
      tool: "web_search",
      input: { queries: [`${company.company} 10-K annual report`] },
    },
    {
      type: "tool_result",
      callId: `mock-search-${ticker}`,
      status: "ok",
      result: `Sources:\n- [SEC EDGAR](${secUrl})\n- [Investor Relations](${irUrl})\n- [10-K](${tenKUrl})`,
    },
    {
      type: "tool_call",
      callId: `mock-fetch-1-${ticker}`,
      tool: "web_fetch",
      input: { url: secUrl },
    },
    {
      type: "tool_result",
      callId: `mock-fetch-1-${ticker}`,
      status: "ok",
      result: `Mock SEC page for ${company.company}. ${secUrl}`,
    },
    {
      type: "tool_call",
      callId: `mock-fetch-2-${ticker}`,
      tool: "web_fetch",
      input: { url: tenKUrl },
    },
    {
      type: "tool_result",
      callId: `mock-fetch-2-${ticker}`,
      status: "ok",
      result: `Mock 10-K for ${company.company}. ${tenKUrl}`,
    },
    { type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } },
    { type: "final", text },
  ];
  fs.writeFileSync(
    path.join(runsDir, `${ticker}.jsonl`),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );
  fs.writeFileSync(path.join(runsDir, `${ticker}.err`), "", "utf8");

  return {
    ticker,
    status: "mock",
    durationMs: 0,
    tools: toolCounts(events),
    usage: usageTotals(events),
    text,
    urls: eventUrls(events),
    completed: isCompleted(events),
  };
}

async function runCompany(company) {
  const ticker = company.ticker;
  if (mock) return writeMockRun(company);

  const existing = readIfExists(sectionPath(ticker)).trim();
  if (existing && !force) {
    console.log(`[${ticker}] skip (section exists; use --force to rerun)`);
    return {
      ticker,
      status: "skipped",
      durationMs: 0,
      tools: {},
      usage: {},
      text: existing,
      urls: new Set(),
      completed: true,
    };
  }

  const prompt = renderPrompt(company);
  if (force) {
    const oldSection = sectionPath(ticker);
    if (fs.existsSync(oldSection)) fs.unlinkSync(oldSection);
  }
  for (const ext of [".jsonl", ".err"]) {
    const oldRun = path.join(runsDir, `${ticker}${ext}`);
    if (fs.existsSync(oldRun)) fs.unlinkSync(oldRun);
  }
  console.log(`[${ticker}] running dsh headless ...`);
  let result = await runHeadless({
    prompt,
    cwd: repoRoot,
    patchPaths,
    dshHome,
    ticker,
    runsDir,
  });

  if (!result.completed || !result.text.trim()) {
    console.warn(
      `[${ticker}] first attempt failed (exit=${result.exitCode}, completed=${result.completed}, chars=${result.text.length}); retrying once`,
    );
    result = await runHeadless({
      prompt: renderPrompt(company, true),
      cwd: repoRoot,
      patchPaths,
      dshHome,
      ticker,
      runsDir,
    });
  }

  if (result.completed && result.text.trim()) {
    fs.writeFileSync(sectionPath(ticker), result.text.trim() + "\n", "utf8");
    console.log(
      `[${ticker}] ok in ${(result.durationMs / 1000).toFixed(1)}s; search=${result.tools.web_search || 0} fetch=${result.tools.web_fetch || 0}`,
    );
    return { ...result, status: "ok" };
  }

  console.error(
    `[${ticker}] failed (exit=${result.exitCode}, completed=${result.completed}, chars=${result.text.length}); see ${result.stderrPath}`,
  );
  return { ...result, status: "failed" };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function runSynthesis(results) {
  if (!synthesize || mock) return null;
  const sections = COMPANIES.map((company) => {
    const text = readIfExists(sectionPath(company.ticker)).trim();
    return text ? `\n\n---\n\n${text}` : "";
  }).join("");
  if (!sections.trim()) return null;
  const template = fs.readFileSync(path.join(moduleDir, "prompts", "synthesis.md"), "utf8");
  const prompt = `${template}\n\n以下是 7 份 profile：${sections}`;
  console.log("[SYNTH] running synthesis pass ...");
  const result = await runHeadless({
    prompt,
    cwd: repoRoot,
    patchPaths,
    dshHome,
    ticker: "SYNTH",
    runsDir,
  });
  if (result.completed && result.text.trim()) {
    const synthesisPath = path.join(outDir, "synthesis.md");
    fs.writeFileSync(synthesisPath, result.text.trim() + "\n", "utf8");
    console.log("[SYNTH] ok");
    return synthesisPath;
  }
  console.warn("[SYNTH] failed; falling back to script-generated summary");
  return null;
}

function writeRunLog({ runResults, validation, synthesisPath }) {
  const skillPath = path.join(repoRoot, ".dsh", "skills", "mag7-profile", "SKILL.md");
  const skillHash = fs.existsSync(skillPath) ? sha256File(skillPath).slice(0, 12) : "missing";
  const validationByTicker = new Map(
    validation.results.map((result) => [result.ticker, result]),
  );
  const rows = runResults.map((result) => {
    const check = validationByTicker.get(result.ticker);
    const usage = result.usage || {};
    const notes = [];
    if (result.status === "failed") notes.push("run failed");
    if (check?.errors?.length) notes.push(check.errors.join("; "));
    if (check?.warnings?.length) notes.push(check.warnings.join("; "));
    return `| ${result.ticker} | ${result.status} | ${(result.durationMs / 1000).toFixed(1)}s | ${
      result.tools?.web_search || 0
    } | ${result.tools?.web_fetch || 0} | ${check?.charCount ?? 0} | ${
      usage.inputTokens ?? 0
    } / ${usage.outputTokens ?? 0} | ${notes.join("; ") || "-"} |`;
  });

  const text = `# Phase 0 Run Log

- 生成时间：${new Date().toISOString()}
- 模式：${mock ? "mock" : "live"}${searchApi ? " · search-api" : ""}
- dsh：${DSH_VERSION}
- 模型：${model}
- skill：${skillHash}
- 日期：${date}
- 合成摘要：${synthesisPath ? "yes" : "no"}

## Results

| Ticker | Status | Duration | Search | Fetch | Chars | Tokens in/out | Notes |
|---|---|---|---:|---:|---:|---:|---|
${rows.join("\n")}

## 输出

- 文档：${path.join(outDir, "magnificent-seven.md")}
- 机器可读验收：${path.join(outDir, "run-summary.json")}
- 原始事件：${runsDir}
`;
  fs.writeFileSync(path.join(outDir, "run-log.md"), text, "utf8");
}

async function main() {
  console.log(
    `Phase 0: ${mock ? "MOCK" : "LIVE"} · ${selected.length} companies · dsh ${DSH_VERSION} · model ${model} · concurrency ${concurrency}`,
  );
  const runResults = await mapLimit(selected, concurrency, runCompany);

  const synthesisPath = await runSynthesis(runResults);
  const assembled = assemble({
    phaseDir: moduleDir,
    repoRoot,
    model,
    dshVersion: DSH_VERSION,
    synthesisFile: synthesisPath,
  });
  console.log(`[assemble] ${assembled.sectionCount} sections -> ${assembled.outPath}`);

  const validation = validate({ only, phaseDir: moduleDir });
  writeRunLog({ runResults, validation, synthesisPath });

  const failedRuns = runResults.filter((result) => result.status === "failed");
  const ok = validation.ok && failedRuns.length === 0;
  console.log(`\nDone: ${ok ? "PASS" : "FAIL"}`);
  console.log(`  document: ${assembled.outPath}`);
  console.log(`  summary:  ${path.join(outDir, "run-summary.json")}`);
  console.log(`  log:      ${path.join(outDir, "run-log.md")}`);
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

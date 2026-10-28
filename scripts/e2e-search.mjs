#!/usr/bin/env node
/**
 * Live E2E check for hybrid search.
 *
 * Assumes Postgres, Qdrant and the embedding sidecar are running and the
 * synthetic corpus has been seeded (`scripts/e2e-search.sh` does all of it).
 * Starts the real API on a private port, drives HTTP, and asserts ranking.
 */
import { spawn } from "node:child_process";

const PORT = Number(process.env.OCC_E2E_PORT ?? 8791);
const BASE = `http://127.0.0.1:${PORT}`;
const TIMEOUT_MS = Number(process.env.OCC_E2E_TIMEOUT_MS ?? 900_000);

let failures = 0;
let checks = 0;

function assert(condition, message) {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`  ✗ ${message}`);
  } else {
    console.log(`  ✓ ${message}`);
  }
}

async function api(path) {
  const response = await fetch(`${BASE}${path}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${path} -> ${response.status}: ${text.slice(0, 600)}`);
  }
  return JSON.parse(text);
}

async function waitForHealth() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/v1/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (response.ok) return response.json();
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("API did not become healthy within 60s");
}

function q(params) {
  return new URLSearchParams(params).toString();
}

async function companySearch(params) {
  return api(`/v1/search/companies?${q(params)}`);
}

async function documentSearch(params) {
  return api(`/v1/search/documents?${q(params)}`);
}

function slugs(body) {
  return body.data.hits.map((hit) => hit.slug);
}

function printHits(label, body, n = 5) {
  console.log(
    `\n${label}  [${body.meta.mode}, ${body.meta.took_ms}ms, fusion=${body.meta.fusion}]`,
  );
  for (const hit of body.data.hits.slice(0, n)) {
    const extra = hit.tickers?.length
      ? hit.tickers.map((ticker) => `${ticker.exchange}:${ticker.ticker}`).join(",")
      : hit.companyDisplayName ?? hit.companyId;
    console.log(
      `  ${Number(hit.score).toFixed(4)}  ${String(hit.matchType).padEnd(9)}  ${String(hit.displayName ?? hit.title ?? "").slice(0, 36).padEnd(36)}  ${extra}`,
    );
  }
}

const apiProcess = spawn(process.execPath, ["apps/api/dist/server.js"], {
  env: { ...process.env, OCC_API_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
apiProcess.stdout.on("data", (chunk) => process.stdout.write(`[api] ${chunk}`));
apiProcess.stderr.on("data", (chunk) => process.stderr.write(`[api] ${chunk}`));

try {
  const health = await waitForHealth();
  console.log("health:", JSON.stringify(health));

  // ── identifier / alias paths ───────────────────────────────────────────
  console.log("\n== company search: exact and fuzzy ==");
  const cases = [
    { label: "Chinese official name", query: "宁德时代", top1: "catl" },
    { label: "Chinese brand alias", query: "茅台", top1: "kweichow-moutai" },
    { label: "Pinyin initials", query: "gzmt", top1: "kweichow-moutai" },
    { label: "Ticker", query: "NVDA", top1: "nvidia" },
    { label: "A-share code", query: "600519", top1: "kweichow-moutai" },
    { label: "HK code", query: "00700.HK", top1: "tencent" },
    { label: "English brand", query: "Tencent", top1: "tencent" },
  ];
  for (const testCase of cases) {
    const body = await companySearch({ q: testCase.query, limit: 5 });
    printHits(`"${testCase.query}"`, body);
    assert(
      slugs(body)[0] === testCase.top1,
      `${testCase.label}: "${testCase.query}" → top1 ${testCase.top1} (got ${slugs(body)[0]})`,
    );
    assert(
      ["identifier", "alias", "fuzzy"].includes(body.data.hits[0]?.matchType),
      `${testCase.label}: exact path used (got ${body.data.hits[0]?.matchType})`,
    );
  }

  // ── hybrid / semantic paths ────────────────────────────────────────────
  console.log("\n== company search: hybrid semantics ==");
  const aiChips = await companySearch({ q: "AI 芯片", limit: 8 });
  printHits('"AI 芯片"', aiChips);
  const chipSlugs = slugs(aiChips);
  assert(
    chipSlugs.slice(0, 5).includes("nvidia"),
    `"AI 芯片" → NVIDIA in top5 (got ${chipSlugs.slice(0, 5).join(", ")})`,
  );
  assert(
    chipSlugs.slice(0, 5).includes("cambricon"),
    `"AI 芯片" → Cambricon in top5 (got ${chipSlugs.slice(0, 5).join(", ")})`,
  );

  const modelLabs = await companySearch({ q: "大模型 公司", limit: 8 });
  printHits('"大模型 公司"', modelLabs);
  const labSlugs = slugs(modelLabs).slice(0, 5);
  const labHits = ["openai", "anthropic", "deepseek", "moonshot", "zhipu"].filter(
    (slug) => labSlugs.includes(slug),
  );
  assert(
    labHits.length >= 2,
    `"大模型 公司" → at least 2 model labs in top5 (got ${labSlugs.join(", ")})`,
  );

  const liquor = await companySearch({ q: "白酒", limit: 5 });
  printHits('"白酒"', liquor);
  assert(slugs(liquor)[0] === "kweichow-moutai", `"白酒" → 贵州茅台`);

  const battery = await companySearch({ q: "动力电池", limit: 5 });
  printHits('"动力电池"', battery);
  assert(slugs(battery)[0] === "catl", `"动力电池" → 宁德时代`);

  const social = await companySearch({ q: "社交 平台", limit: 6 });
  printHits('"社交 平台"', social);
  const socialSlugs = slugs(social).slice(0, 4);
  assert(
    socialSlugs.includes("tencent") || socialSlugs.includes("meta"),
    `"社交 平台" → Tencent or Meta in top4 (got ${socialSlugs.join(", ")})`,
  );

  // ── modes ──────────────────────────────────────────────────────────────
  console.log("\n== retrieval modes ==");
  const keyword = await companySearch({ q: "动力电池", mode: "keyword", limit: 5 });
  printHits('keyword "动力电池"', keyword);
  assert(slugs(keyword)[0] === "catl", `keyword mode ranks CATL first`);
  assert(keyword.meta.mode === "keyword", `keyword mode echoed in meta`);

  const semantic = await companySearch({
    q: "电动车 储能",
    mode: "semantic",
    limit: 6,
  });
  printHits('semantic "电动车 储能"', semantic);
  const semanticSlugs = slugs(semantic).slice(0, 6);
  assert(
    ["tesla", "byd", "catl"].some((slug) => semanticSlugs.includes(slug)),
    `semantic mode finds an EV/battery company (got ${semanticSlugs.join(", ")})`,
  );
  assert(semantic.meta.mode === "semantic", `semantic mode echoed in meta`);

  // ── explain ────────────────────────────────────────────────────────────
  console.log("\n== explain ==");
  const explained = await companySearch({ q: "大模型", explain: "true", limit: 8 });
  printHits('explain "大模型"', explained);
  assert(explained.data.explain, "explain payload present");
  assert(
    explained.data.explain.branches.bm25.length > 0,
    `BM25 branch has hits (${explained.data.explain.branches.bm25.length})`,
  );
  assert(
    explained.data.explain.branches.dense.length > 0,
    `dense branch has hits (${explained.data.explain.branches.dense.length})`,
  );
  assert(
    explained.data.explain.fusion.length > 0,
    `fusion has entries (${explained.data.explain.fusion.length})`,
  );
  const firstHybrid = explained.data.hits.find((hit) => hit.matchType === "hybrid");
  assert(Boolean(firstHybrid), "a hybrid hit is present");
  if (firstHybrid) {
    assert(
      firstHybrid.explain?.sparseRank || firstHybrid.explain?.denseRank,
      `hybrid hit carries branch ranks (${JSON.stringify(firstHybrid.explain)})`,
    );
  }

  // ── document search ────────────────────────────────────────────────────
  console.log("\n== document search ==");
  const cloudDocs = await documentSearch({ q: "云 业务 增长", limit: 8 });
  printHits('documents "云 业务 增长"', cloudDocs);
  assert(cloudDocs.data.hits.length > 0, "document search returns hits");
  assert(
    cloudDocs.data.hits.every((hit) => hit.source?.url),
    "every document hit has a source citation",
  );
  assert(
    cloudDocs.data.hits.every((hit) => hit.explain === undefined),
    "non-explain document search omits explain",
  );

  const chipDocs = await documentSearch({
    q: "AI 芯片 竞争",
    explain: "true",
    limit: 5,
  });
  printHits('documents "AI 芯片 竞争"', chipDocs);
  assert(chipDocs.data.hits.length > 0, "chip document search returns hits");
  assert(
    chipDocs.data.explain?.branches?.bm25?.length > 0,
    "document explain includes BM25 branch",
  );

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exitCode = 1;
} catch (error) {
  console.error("\nE2E error:", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
} finally {
  apiProcess.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 300));
}

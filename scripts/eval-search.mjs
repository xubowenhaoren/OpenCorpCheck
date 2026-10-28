#!/usr/bin/env node
/**
 * Search-quality eval for the visible research corpus.
 *
 * Assumes Postgres/Qdrant/embeddings are up, the API is running, and the NDX
 * backfill has been ingested. Fixtures are hidden by default; pass
 * `--include-fixtures` to measure the synthetic corpus too.
 *
 *   ticker    exact identifier (`AAPL`, `ADBE`, ...)
 *   name      English company name from the constituent snapshot
 *   typo      realistic English misspellings
 *   pinyin    pinyin initials / full pinyin (`ywd`, `yingweida`)
 *   natural   natural-language descriptions (Chinese and English)
 *   zh-name   Chinese company names (`英伟达`, `奈飞`)
 *   documents document-level semantic probes
 *
 * Metrics: top1 accuracy, MRR@10, nDCG@10, recall@5, zero-result rate, and
 * latency p50/p95. nDCG@10 uses one relevant company per query (binary
 * relevance), so IDCG@10 = 1.
 *
 *   node scripts/eval-search.mjs [--mode hybrid|keyword|semantic]
 *     [--family ticker|name|typo|pinyin|natural|zh-name|documents]
 *     [--include-fixtures] [--json]
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import { parseArgs } from "node:util";

import {
  DOC_SEMANTIC_QUERIES,
  NATURAL_QUERIES,
  PINYIN_QUERIES,
  TYPO_QUERIES,
  ZH_NAME_QUERIES,
} from "./golden-queries.mjs";

const require = createRequire(new URL("../apps/worker/package.json", import.meta.url));
const { parse: parseYaml } = require("yaml");

const API = (process.env.OCC_API_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "hybrid" },
    limit: { type: "string", default: "10" },
    json: { type: "boolean" },
    concurrency: { type: "string", default: "4" },
    "include-fixtures": { type: "boolean" },
    family: { type: "string" },
  },
});

const MODE = values.mode;
const LIMIT = Number(values.limit);
const CONCURRENCY = Number(values.concurrency);
const INCLUDE_FIXTURES = Boolean(values["include-fixtures"]);
const FAMILY = values.family;

const SEMANTIC = NATURAL_QUERIES;
const DOC_SEMANTIC = DOC_SEMANTIC_QUERIES;

function loadNdx() {
  const file = new URL("../config/indices/ndx.yaml", import.meta.url);
  return parseYaml(fs.readFileSync(file, "utf8"));
}

async function search(kind, query) {
  const url = new URL(`/v1/search/${kind}`, API);
  url.searchParams.set("q", query);
  url.searchParams.set("mode", MODE);
  url.searchParams.set("limit", String(LIMIT));
  if (INCLUDE_FIXTURES) url.searchParams.set("include_fixtures", "true");
  const started = performance.now();
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`search ${query} failed: ${response.status} ${JSON.stringify(body).slice(0, 300)}`);
  }
  return { body, wallMs: performance.now() - started };
}

function matchCompany(hit, expected) {
  const tickers = (hit.tickers ?? []).map((ticker) =>
    String(ticker.ticker).toUpperCase(),
  );
  if (tickers.includes(expected.toUpperCase())) return true;
  const label = `${hit.displayName ?? ""} ${hit.legalName ?? ""}`.toLowerCase();
  return label.includes(expected.toLowerCase());
}

function metrics(rows) {
  const ranks = rows.map((row) => row.rank ?? Infinity);
  const latencies = rows.map((row) => row.latencyMs).sort((a, b) => a - b);
  const found = ranks.filter((rank) => Number.isFinite(rank));
  const at10 = (rank) => (Number.isFinite(rank) && rank <= 10 ? rank : null);
  return {
    cases: rows.length,
    top1: round(found.filter((rank) => rank === 1).length / Math.max(1, rows.length)),
    // MRR@10 and nDCG@10 use one relevant company per query, so the ideal
    // DCG is 1 and nDCG@10 = 1/log2(rank+1) for a hit inside the cutoff.
    mrr10: round(
      rows.reduce((sum, row) => {
        const rank = at10(row.rank);
        return sum + (rank ? 1 / rank : 0);
      }, 0) / Math.max(1, rows.length),
    ),
    ndcg10: round(
      rows.reduce((sum, row) => {
        const rank = at10(row.rank);
        return sum + (rank ? 1 / Math.log2(rank + 1) : 0);
      }, 0) / Math.max(1, rows.length),
    ),
    recall5: round(
      found.filter((rank) => rank <= 5).length / Math.max(1, rows.length),
    ),
    zero: round(
      rows.filter((row) => row.rank === null).length / Math.max(1, rows.length),
    ),
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    wallP95: percentile(rows.map((row) => row.wallMs).sort((a, b) => a - b), 0.95),
  };
}

function rankCompany(hits, expected) {
  const expectedList = Array.isArray(expected) ? expected : [expected];
  for (let index = 0; index < hits.length; index += 1) {
    if (expectedList.some((ticker) => matchCompany(hits[index], ticker))) {
      return index + 1;
    }
  }
  return hits.length === 0 ? null : Infinity;
}

function rankDocument(hits, expectedName) {
  for (let index = 0; index < hits.length; index += 1) {
    const label = hits[index].companyDisplayName ?? "";
    if (label.toLowerCase().includes(expectedName.toLowerCase())) return index + 1;
  }
  return hits.length === 0 ? null : Infinity;
}

async function runPool(items, worker) {
  let cursor = 0;
  const out = new Array(items.length);
  async function run() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      out[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, run));
  return out;
}

async function main() {
  const snapshot = loadNdx();
  const primary = snapshot.constituents.filter((entry) => entry.primary);
  const rows = {
    ticker: [],
    name: [],
    typo: [],
    pinyin: [],
    natural: [],
    "zh-name": [],
    documents: [],
  };

  const shouldRun = (family) => {
    if (!FAMILY) return true;
    if (FAMILY === "semantic") return family === "natural";
    return FAMILY === family;
  };

  if (shouldRun("ticker") || shouldRun("name")) {
    await runPool(primary, async (entry) => {
      if (shouldRun("ticker")) {
        const ticker = await search("companies", entry.ticker);
        rows.ticker.push({
          expected: entry.ticker,
          query: entry.ticker,
          rank: rankCompany(ticker.body.data.hits, entry.ticker),
          latencyMs: ticker.body.meta.took_ms,
          wallMs: ticker.wallMs,
        });
      }
      if (shouldRun("name")) {
        const name = entry.name.replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
        const byName = await search("companies", name);
        rows.name.push({
          expected: entry.ticker,
          query: name,
          rank: rankCompany(byName.body.data.hits, entry.ticker),
          latencyMs: byName.body.meta.took_ms,
          wallMs: byName.wallMs,
        });
      }
    });
  }

  await runCompanyFamily("typo", TYPO_QUERIES);
  await runCompanyFamily("pinyin", PINYIN_QUERIES);
  await runCompanyFamily("natural", SEMANTIC);
  await runCompanyFamily("zh-name", ZH_NAME_QUERIES);

  if (shouldRun("documents")) {
    rows.documents = await runPool(DOC_SEMANTIC, async ([query, expected]) => {
      const result = await search("documents", query);
      return {
        expected,
        query,
        rank: rankDocument(result.body.data.hits, expected),
        latencyMs: result.body.meta.took_ms,
        wallMs: result.wallMs,
        top: result.body.data.hits.slice(0, 3).map((hit) => hit.companyDisplayName),
      };
    });
  }

  async function runCompanyFamily(family, queries) {
    if (!shouldRun(family)) return;
    rows[family] = await runPool(queries, async ([query, expected]) => {
      const result = await search("companies", query);
      return {
        expected,
        query,
        rank: rankCompany(result.body.data.hits, expected),
        latencyMs: result.body.meta.took_ms,
        wallMs: result.wallMs,
        top: result.body.data.hits.slice(0, 3).map((hit) => hit.displayName),
      };
    });
  }

  const present = Object.entries(rows).filter(([, familyRows]) => familyRows.length > 0);
  const report = {
    mode: MODE,
    limit: LIMIT,
    includeFixtures: INCLUDE_FIXTURES,
    companies: primary.length,
    groups: Object.fromEntries(
      present.map(([name, familyRows]) => [name, metrics(familyRows)]),
    ),
    failures: Object.fromEntries(
      present.map(([name, familyRows]) => [
        name,
        familyRows.filter((row) =>
          name === "documents"
            ? (row.rank ?? Infinity) > 5
            : row.rank !== 1,
        ),
      ]),
    ),
  };

  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(
    `mode=${MODE} limit=${LIMIT} companies=${primary.length} ` +
      `fixtures=${INCLUDE_FIXTURES ? "included" : "hidden"}`,
  );
  console.log(
    "group       cases  top1   MRR@10  nDCG@10 recall@5  zero%   p50ms  p95ms  wall-p95",
  );
  for (const [name, group] of Object.entries(report.groups)) {
    console.log(
      `${name.padEnd(11)} ${String(group.cases).padStart(5)} ` +
        `${pct(group.top1)} ${pct(group.mrr10)} ${pct(group.ndcg10)} ` +
        `${pct(group.recall5)} ${pct(group.zero)} ${String(group.p50).padStart(6)} ` +
        `${String(group.p95).padStart(6)} ${String(group.wallP95).padStart(9)}`,
    );
  }
  for (const [group, familyRows] of Object.entries(report.failures)) {
    if (familyRows.length === 0) continue;
    console.log(`\n${group} failures:`);
    for (const row of familyRows.slice(0, 20)) {
      console.log(
        `  ${String(row.query).padEnd(38)} expected=${labelExpected(row.expected)} rank=${row.rank ?? "zero"}` +
          (row.top ? ` top=${row.top.join(" | ")}` : ""),
      );
    }
  }
}

function percentile(sorted, value) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(value * sorted.length) - 1);
  return Math.round(sorted[index]);
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function pct(value) {
  return `${(value * 100).toFixed(1).padStart(5)}%`;
}

function labelExpected(value) {
  return Array.isArray(value) ? value.join("|") : value;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

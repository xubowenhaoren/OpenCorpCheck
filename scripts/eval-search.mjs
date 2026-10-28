#!/usr/bin/env node
/**
 * Search-quality eval for the NDX corpus.
 *
 * Assumes Postgres/Qdrant/embeddings are up, the API is running, and the NDX
 * backfill has been ingested. Queries three families:
 *
 *   ticker    exact identifier (`AAPL`, `ADBE`, ...)
 *   name      English company name from the constituent snapshot
 *   semantic  hand-written descriptions ("模拟芯片 电源管理")
 *
 * Metrics: top1 accuracy, MRR@N, recall@5, zero-result rate, latency p50/p95.
 * Document search is checked separately with a small semantic set.
 *
 *   node scripts/eval-search.mjs [--mode hybrid|keyword|semantic] [--json]
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import { parseArgs } from "node:util";

const require = createRequire(new URL("../apps/worker/package.json", import.meta.url));
const { parse: parseYaml } = require("yaml");

const API = (process.env.OCC_API_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "hybrid" },
    limit: { type: "string", default: "10" },
    json: { type: "boolean" },
    concurrency: { type: "string", default: "4" },
  },
});

const MODE = values.mode;
const LIMIT = Number(values.limit);
const CONCURRENCY = Number(values.concurrency);

const SEMANTIC = [
  ["模拟芯片 电源管理", "ADI"],
  ["短租 民宿 替代住宿", "ABNB"],
  ["薪酬外包 人力资源 工资单", "ADP"],
  ["创意软件 Photoshop 订阅", "ADBE"],
  ["电动汽车 储能 自动驾驶", "TSLA"],
  ["电商 云计算 Prime", "AMZN"],
  ["搜索 广告 视频 安卓", "GOOGL"],
  ["社交 广告 元宇宙", "META"],
  ["AI 芯片 GPU 数据中心", "NVDA"],
  ["咖啡 连锁 门店", "SBUX"],
  ["流媒体 订阅", "NFLX"],
  ["酒店 机票 在线旅游", "BKNG"],
  ["半导体设备 光刻", "AMAT"],
  ["网络设备 交换机", "CSCO"],
  ["在线支付 数字钱包", "PYPL"],
  ["会员制仓储 零售", "COST"],
  ["生物科技 药物研发", "AMGN"],
  ["数据平台 可观测性", "DDOG"],
  ["网络安全 零信任", "PANW"],
  ["电动车 充电 太阳能", "TSLA"],
];

const DOC_SEMANTIC = [
  ["模拟芯片 工业 汽车", "Analog Devices, Inc."],
  ["短租 民宿 体验", "Airbnb, Inc."],
  ["薪酬外包 人力资源", "Automatic Data Processing, Inc."],
  ["创意软件 订阅 现金流", "Adobe Inc."],
  ["iPhone 服务 生态", "Apple Inc."],
];

function loadNdx() {
  const file = new URL("../config/indices/ndx.yaml", import.meta.url);
  return parseYaml(fs.readFileSync(file, "utf8"));
}

async function search(kind, query) {
  const url = new URL(`/v1/search/${kind}`, API);
  url.searchParams.set("q", query);
  url.searchParams.set("mode", MODE);
  url.searchParams.set("limit", String(LIMIT));
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
  return {
    cases: rows.length,
    top1: round(found.filter((rank) => rank === 1).length / Math.max(1, rows.length)),
    mrr10: round(
      rows.reduce((sum, row) => sum + (Number.isFinite(row.rank) ? 1 / row.rank : 0), 0) /
        Math.max(1, rows.length),
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
  for (let index = 0; index < hits.length; index += 1) {
    if (matchCompany(hits[index], expected)) return index + 1;
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
  const tickerRows = [];
  const nameRows = [];

  await runPool(primary, async (entry) => {
    const ticker = await search("companies", entry.ticker);
    tickerRows.push({
      expected: entry.ticker,
      query: entry.ticker,
      rank: rankCompany(ticker.body.data.hits, entry.ticker),
      latencyMs: ticker.body.meta.took_ms,
      wallMs: ticker.wallMs,
    });
    const name = entry.name.replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
    const byName = await search("companies", name);
    nameRows.push({
      expected: entry.ticker,
      query: name,
      rank: rankCompany(byName.body.data.hits, entry.ticker),
      latencyMs: byName.body.meta.took_ms,
      wallMs: byName.wallMs,
    });
  });

  const semanticRows = await runPool(SEMANTIC, async ([query, expected]) => {
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

  const docRows = await runPool(DOC_SEMANTIC, async ([query, expected]) => {
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

  const report = {
    mode: MODE,
    limit: LIMIT,
    companies: primary.length,
    groups: {
      ticker: metrics(tickerRows),
      name: metrics(nameRows),
      semantic: metrics(semanticRows),
      documents: metrics(docRows),
    },
    failures: {
      ticker: tickerRows.filter((row) => row.rank !== 1),
      name: nameRows.filter((row) => row.rank !== 1),
      semantic: semanticRows.filter((row) => (row.rank ?? Infinity) > 5),
      documents: docRows.filter((row) => (row.rank ?? Infinity) > 5),
    },
  };

  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`mode=${MODE} limit=${LIMIT} companies=${primary.length}`);
  console.log(
    "group       cases  top1   MRR@10  recall@5  zero%   p50ms  p95ms  wall-p95",
  );
  for (const [name, group] of Object.entries(report.groups)) {
    console.log(
      `${name.padEnd(11)} ${String(group.cases).padStart(5)} ` +
        `${pct(group.top1)} ${pct(group.mrr10)} ${pct(group.recall5)} ` +
        `${pct(group.zero)} ${String(group.p50).padStart(6)} ` +
        `${String(group.p95).padStart(6)} ${String(group.wallP95).padStart(9)}`,
    );
  }
  for (const [group, rows] of Object.entries(report.failures)) {
    if (rows.length === 0) continue;
    console.log(`\n${group} failures:`);
    for (const row of rows.slice(0, 15)) {
      console.log(
        `  ${String(row.query).padEnd(38)} expected=${row.expected} rank=${row.rank ?? "zero"}` +
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

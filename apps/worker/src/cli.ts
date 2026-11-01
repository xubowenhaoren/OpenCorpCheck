#!/usr/bin/env node
import fs from "node:fs";
import { parseArgs } from "node:util";

import {
  enqueueF10,
  enqueueFinancials,
  enqueueNews,
  enqueueResearch,
  type EnqueueResult,
} from "./backfill.js";
import { publicConfig } from "./config.js";
import {
  closePool,
  getRunSummary,
  listCompanyStates,
  listRuns,
  migrate,
} from "./db.js";
import { runF10RelationsCommand } from "./f10-relations-command.js";
import { startNimGateway } from "./nim-gateway.js";
import { newsSweepStatus, runNewsSweep } from "./news-sweep.js";
import { queueCounts, startBoss } from "./queues.js";
import { resolveTargets } from "./universe.js";
import { runWorkers, type QueueKind } from "./worker.js";

const USAGE = `occ-backfill — OpenCorpCheck parallel backfill

Usage:
  occ-backfill migrate
  occ-backfill enqueue research [options]
  occ-backfill enqueue f10 [options]
  occ-backfill enqueue news [options]
  occ-backfill enqueue financials [options]
  occ-backfill news status
  occ-backfill news sweep --now
  occ-backfill work [--queues research,ingest,review,news,f10,financials] [--drain]
  occ-backfill status [--run <uuid>] [--json]
  occ-backfill states [--limit N] [--json]
  occ-backfill relations f10 [--universe hsi|ndx|cyb50|... | --tickers ...] [--force]
  occ-backfill config

Enqueue options:
  --universe mag7|ai-watchlist|ndx|hsi|cyb50
  --tickers AAPL,600519:A,00700:HK
  --exclude 00700,AAPL         Drop targets after universe expansion
  --limit N                      Cap targets after priority sort
  --shard I/N                    Only targets where hash(key) % N === I
  --force                        Ignore completed checkpoints / cache
  --mock                         Research only: write fixture sections, no LLM
  --include-f10                  Research only: attach the F10 MCP tools
  --no-review                    Research only: skip the hidden reviewer
  --no-ingest                    Research only: skip section ingestion
  --ingest-mock                  Research only: ingest mock sections too
  --preset default|minimal       F10 only (default: default)
  --pages cwfx,gsgk              F10 only: explicit page hashes
  --query "Apple earnings"       News only: search query override
  --max-items N                  News only: articles per company (default 10)
  --since-days N                 News only: recency window (default 30)

Environment:
  DATABASE_URL (default postgres://occ@127.0.0.1:5432/occdb)
  OCC_RESEARCH_CONCURRENCY (default 4)
  OCC_INGEST_CONCURRENCY (default 4)
  OCC_REVIEW_CONCURRENCY (default 4)
  OCC_F10_CONCURRENCY (default 4)
  OCC_FINANCIALS_CONCURRENCY (default 2)
  OCC_FINANCIALS (on default; none stops auto-enqueue after ingest)
  OCC_NEWS_SWEEP (on default; none disables the automatic news sweep)
  OCC_NEWS_SWEEP_CRON (default "0 7 * * *")
  OCC_NEWS_SWEEP_TZ (default: the machine's local timezone)
  OCC_NEWS_TTL_MS (default 82,800,000 = 23 h; keep shorter than the sweep period)
  OCC_NEWS_CLAIM_TIMEOUT_MS (default 1,800,000 = 30 min lease)
  OCC_NEWS_SWEEP_BATCH (default 250)
  OCC_NEWS_HISTORY_MS (default 259,200,000 = 3 days of sweep history)
  OCC_EDGAR_USER_AGENT (SEC requires a contact, e.g. Name/1.0 (you@example.com))
  OCC_EDGAR_DIR (default .occ/edgar)
  OCC_QDRANT_URL (default http://127.0.0.1:6333)
  OCC_EMBEDDING_URL (default http://127.0.0.1:8080)
  OCC_FINANCE_ANALYST_URL (default http://127.0.0.1:8090)
  OCC_LLM_PROVIDER (deepseek default; nvidia opts into the NIM free tier)
  OCC_NIM_RPM (default 20; only used with OCC_LLM_PROVIDER=nvidia)
  OCC_REVIEW_MAX_CYCLES (default 2)
  NVIDIA_API_KEY (required for live research on NIM)
  DEEPSEEK_API_KEY (required for ingest/extraction and the reviewer)
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "migrate":
      await migrate();
      console.log("migrated");
      return;
    case "enqueue": {
      const [kind, ...args] = rest;
      if (
        kind !== "research" &&
        kind !== "f10" &&
        kind !== "news" &&
        kind !== "financials"
      ) {
        throw new Error("enqueue requires research, f10, news or financials");
      }
      await enqueueCommand(kind, args);
      return;
    }
    case "work":
      await workCommand(rest);
      return;
    case "status":
      await statusCommand(rest);
      return;
    case "states":
      await statesCommand(rest);
      return;
    case "news":
      await newsCommand(rest);
      return;
    case "relations":
      await relationsCommand(rest);
      return;
    case "config":
      console.log(JSON.stringify(publicConfig(), null, 2));
      return;
    case "targets": {
      const { values } = parseArgs({
        args: rest,
        options: {
          universe: { type: "string" },
          tickers: { type: "string" },
          exclude: { type: "string" },
          limit: { type: "string" },
          shard: { type: "string" },
        },
      });
      const targets = await resolveTargets({
        universe: values.universe,
        tickers: values.tickers,
        exclude: values.exclude,
        limit: values.limit ? Number(values.limit) : undefined,
        shard: parseShard(values.shard),
      });
      console.log(JSON.stringify(targets, null, 2));
      return;
    }
    case "help":
    case "-h":
    case "--help":
    case undefined:
      console.log(USAGE);
      return;
    default:
      console.error(`unknown command: ${command}\n`);
      console.error(USAGE);
      process.exitCode = 2;
  }
}

async function enqueueCommand(
  kind: "research" | "f10" | "news" | "financials",
  args: string[],
): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      universe: { type: "string" },
      tickers: { type: "string" },
      exclude: { type: "string" },
      limit: { type: "string" },
      shard: { type: "string" },
      force: { type: "boolean" },
      mock: { type: "boolean" },
      "include-f10": { type: "boolean" },
      "no-review": { type: "boolean" },
      "no-ingest": { type: "boolean" },
      "ingest-mock": { type: "boolean" },
      preset: { type: "string" },
      pages: { type: "string" },
      query: { type: "string" },
      "max-items": { type: "string" },
      "since-days": { type: "string" },
    },
  });

  const shard = parseShard(values.shard);
  const limit = values.limit ? Number(values.limit) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error("--limit must be a positive integer");
  }

  await migrate();
  const boss = await startBoss();
  let result: EnqueueResult;
  try {
    if (kind === "research") {
      result = await enqueueResearch(boss, {
        universe: values.universe,
        tickers: values.tickers,
        exclude: values.exclude,
        limit,
        shard,
        force: values.force,
        mock: values.mock,
        includeF10: values["include-f10"],
        ingest: values["no-ingest"] ? false : undefined,
        ingestMock: values["ingest-mock"],
        review: values["no-review"] ? false : undefined,
      });
    } else if (kind === "news") {
      result = await enqueueNews(boss, {
        universe: values.universe,
        tickers: values.tickers,
        limit,
        shard,
        force: values.force,
        query: values.query,
        maxItems: parsePositive(values["max-items"], "--max-items"),
        sinceDays: parsePositive(values["since-days"], "--since-days"),
      });
    } else if (kind === "financials") {
      result = await enqueueFinancials(boss, {
        universe: values.universe,
        tickers: values.tickers,
        exclude: values.exclude,
        limit,
        shard,
        force: values.force,
      });
    } else {
      result = await enqueueF10(boss, {
        universe: values.universe,
        tickers: values.tickers,
        limit,
        shard,
        force: values.force,
        preset: values.preset,
        pages: values.pages,
      });
    }
  } finally {
    await boss.stop({ graceful: false });
  }

  console.log(JSON.stringify(result, null, 2));
}

async function workCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      queues: { type: "string" },
      drain: { type: "boolean" },
    },
  });
  const queues = (values.queues ?? "research,ingest,review,news,f10,financials")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean) as QueueKind[];
  for (const queue of queues) {
    if (
      queue !== "research" &&
      queue !== "ingest" &&
      queue !== "review" &&
      queue !== "news" &&
      queue !== "f10" &&
      queue !== "financials"
    ) {
      throw new Error(
        `unknown queue ${queue}; use research, ingest, review, news, f10 or financials`,
      );
    }
  }
  await migrate();
  if (queues.includes("research")) {
    await startNimGateway();
  }
  await runWorkers({ queues, drain: values.drain });
}

async function statusCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      run: { type: "string" },
      json: { type: "boolean" },
      limit: { type: "string" },
      out: { type: "string" },
    },
  });

  await migrate();
  const boss = await startBoss();
  try {
    const counts = await queueCounts(boss);
    const summary = values.run ? await getRunSummary(values.run) : null;
    const runs = summary
      ? []
      : await listRuns(values.limit ? Number(values.limit) : 10);
    const payload = { config: publicConfig(), counts, summary, runs };

    if (values.json) {
      const text = JSON.stringify(payload, null, 2);
      if (values.out) {
        fs.writeFileSync(values.out, `${text}\n`, "utf8");
        console.log(values.out);
      } else {
        console.log(text);
      }
      return;
    }

    console.log("Queues");
    for (const count of counts) {
      console.log(
        `  ${count.name.padEnd(24)} created=${count.created} retry=${count.retry} ` +
          `active=${count.active} failed=${count.failed} completed=${count.completed}`,
      );
    }
    if (summary) {
      const run = summary.run as
        | { status?: string; completed_jobs?: number; total_jobs?: number }
        | null;
      console.log("\nRun");
      console.log(
        `  ${values.run} status=${run?.status} ${run?.completed_jobs}/${run?.total_jobs}`,
      );
      console.log(`  jobs: ${JSON.stringify(summary.counts)}`);
      console.log(
        `  duration: p50=${summary.durationMs.p50 ?? "-"}ms ` +
          `p95=${summary.durationMs.p95 ?? "-"}ms ` +
          `avg=${summary.durationMs.avg ?? "-"}ms`,
      );
      console.log(
        `  tokens: input=${summary.tokens.input} output=${summary.tokens.output}`,
      );
      if (summary.failed.length) {
        console.log("  dead jobs:");
        for (const job of summary.failed) {
          console.log(
            `    ${job.company_id}${job.page ? `/${job.page}` : ""} attempts=${job.attempts} ` +
              `${(job.last_error ?? "").slice(0, 200)}`,
          );
        }
      }
    }
    if (runs.length) {
      console.log("\nRecent runs");
      for (const run of runs) {
        console.log(
          `  ${String(run.id).slice(0, 8)}  ${String(run.kind).padEnd(8)} ` +
            `${String(run.status).padEnd(9)} ${run.completed_jobs}/${run.total_jobs} ` +
            `failed=${run.failed_jobs} ${new Date(String(run.created_at)).toISOString()}`,
        );
      }
    }
  } finally {
    await boss.stop({ graceful: false });
  }
}

async function statesCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { json: { type: "boolean" }, limit: { type: "string" } },
  });
  await migrate();
  const states = await listCompanyStates(
    values.limit ? Number(values.limit) : 100,
  );
  if (values.json) {
    console.log(JSON.stringify(states, null, 2));
    return;
  }
  if (states.length === 0) {
    console.log("no company research state rows");
    return;
  }
  for (const state of states) {
    const review = state.review_result as
      | { verdict?: string; issues?: unknown[] }
      | null
      | undefined;
    const issues = Array.isArray(review?.issues) ? review.issues.length : 0;
    console.log(
      `${state.company_id.padEnd(14)} ${state.status.padEnd(13)} ` +
        `attempts=${state.attempts} review=${state.review_attempts} ` +
        `verdict=${review?.verdict ?? "-"} issues=${issues} ` +
        `${state.last_error ? `error=${state.last_error.slice(0, 160)}` : ""}`,
    );
  }
}

async function newsCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: { now: { type: "boolean" }, json: { type: "boolean" } },
  });
  await migrate();
  const boss = await startBoss();
  try {
    if (sub === "status") {
      console.log(JSON.stringify(await newsSweepStatus(), null, 2));
      return;
    }
    if (sub === "sweep") {
      if (!values.now) {
        throw new Error("news sweep requires --now (operator-forced sweep)");
      }
      const result = await runNewsSweep({ boss, source: "cli" });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    throw new Error("news requires `status` or `sweep --now`");
  } finally {
    await boss.stop({ graceful: false });
  }
}

async function relationsCommand(args: string[]): Promise<void> {  const [kind, ...rest] = args;
  if (kind !== "f10") {
    throw new Error("relations requires `f10` (structured shareholder pass)");
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      universe: { type: "string" },
      tickers: { type: "string" },
      exclude: { type: "string" },
      limit: { type: "string" },
      force: { type: "boolean" },
    },
  });
  await migrate();
  const result = await runF10RelationsCommand({
    ...(values.universe ? { universe: values.universe } : {}),
    ...(values.tickers ? { tickers: values.tickers } : {}),
    ...(values.limit ? { limit: Number(values.limit) } : {}),
    force: Boolean(values.force),
  });
  console.log(JSON.stringify(result, null, 2));
}

function parseShard(
  value: string | undefined,
): { index: number; count: number } | undefined {
  if (!value) return undefined;
  const [left, right] = value.split("/");
  const index = Number(left);
  const count = Number(right);
  if (!Number.isInteger(index) || !Number.isInteger(count) || count <= 0) {
    throw new Error("--shard must look like 0/4");
  }
  if (index < 0 || index >= count) {
    throw new Error(`--shard index must be between 0 and ${count - 1}`);
  }
  return { index, count };
}

function parsePositive(
  value: string | undefined,
  flag: string,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });

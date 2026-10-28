#!/usr/bin/env node
import fs from "node:fs";
import { parseArgs } from "node:util";

import { enqueueF10, enqueueResearch, type EnqueueResult } from "./backfill.js";
import { publicConfig } from "./config.js";
import {
  closePool,
  getRunSummary,
  listRuns,
  migrate,
} from "./db.js";
import { queueCounts, startBoss } from "./queues.js";
import { resolveTargets } from "./universe.js";
import { runWorkers, type QueueKind } from "./worker.js";

const USAGE = `occ-backfill — OpenCorpCheck parallel backfill

Usage:
  occ-backfill migrate
  occ-backfill enqueue research [options]
  occ-backfill enqueue f10 [options]
  occ-backfill work [--queues research,f10] [--drain]
  occ-backfill status [--run <uuid>] [--json]
  occ-backfill config

Enqueue options:
  --universe mag7|ai-watchlist   Preset target list
  --tickers AAPL,600519:A,00700:HK
  --limit N                      Cap targets after priority sort
  --shard I/N                    Only targets where hash(key) % N === I
  --force                        Ignore completed checkpoints / cache
  --mock                         Research only: write fixture sections, no LLM
  --include-f10                  Research only: attach the F10 MCP tools
  --preset default|minimal       F10 only (default: default)
  --pages cwfx,gsgk              F10 only: explicit page hashes

Environment:
  DATABASE_URL (default postgres://occ@127.0.0.1:5432/occdb)
  OCC_RESEARCH_CONCURRENCY (default 4)
  OCC_F10_CONCURRENCY (default 4)
  OCC_FINANCE_ANALYST_URL (default http://127.0.0.1:8090)
  DEEPSEEK_API_KEY (required for live research)
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
      if (kind !== "research" && kind !== "f10") {
        throw new Error("enqueue requires research or f10");
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
    case "config":
      console.log(JSON.stringify(publicConfig(), null, 2));
      return;
    case "targets": {
      const { values } = parseArgs({
        args: rest,
        options: {
          universe: { type: "string" },
          tickers: { type: "string" },
          limit: { type: "string" },
          shard: { type: "string" },
        },
      });
      const targets = await resolveTargets({
        universe: values.universe,
        tickers: values.tickers,
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

async function enqueueCommand(kind: "research" | "f10", args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      universe: { type: "string" },
      tickers: { type: "string" },
      limit: { type: "string" },
      shard: { type: "string" },
      force: { type: "boolean" },
      mock: { type: "boolean" },
      "include-f10": { type: "boolean" },
      preset: { type: "string" },
      pages: { type: "string" },
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
        limit,
        shard,
        force: values.force,
        mock: values.mock,
        includeF10: values["include-f10"],
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
  const queues = (values.queues ?? "research,f10")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean) as QueueKind[];
  for (const queue of queues) {
    if (queue !== "research" && queue !== "f10") {
      throw new Error(`unknown queue ${queue}; use research or f10`);
    }
  }
  await migrate();
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

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });

import fs from "node:fs";
import path from "node:path";

import type { Job } from "pg-boss";

import {
  exchangeForMarket,
  ingestSection,
  type IngestTarget,
} from "@occ/ingest";
import type { CoverageTier, Market } from "@occ/core";

import { config } from "../config.js";
import {
  getJobRow,
  markJobActive,
  markJobCompleted,
  markJobFailed,
} from "../db.js";
import { getIngestContext } from "../ingest-runtime.js";
import { QUEUES } from "../queues.js";

export interface IngestJobData {
  runId: string;
  key: string;
  ticker: string;
  name: string;
  market?: Market;
  code?: string;
  exchange?: string;
  sectionPath?: string;
  indexCode?: string;
  indexAsOf?: string;
  coverageTier?: CoverageTier;
  force?: boolean;
}

export async function handleIngestJobs(
  jobs: Job<IngestJobData>[],
): Promise<void> {
  for (const job of jobs) {
    await processIngestJob(job);
  }
}

async function processIngestJob(job: Job<IngestJobData>): Promise<void> {
  const data = job.data;
  const queue = QUEUES.INGEST;
  const row = await getJobRow(data.runId, queue, data.key);
  if (!row) {
    log({ event: "ingest_job_missing", run: data.runId, key: data.key });
    return;
  }
  if (row.status === "completed" && !data.force) {
    log({ event: "ingest_job_skip_completed", run: data.runId, key: data.key });
    return;
  }

  const sectionPath = data.sectionPath ?? defaultSectionPath(data.ticker);
  if (!fs.existsSync(sectionPath)) {
    const message = `section not found: ${sectionPath}`;
    await markJobFailed(data.runId, queue, data.key, message);
    throw new Error(message);
  }

  const market: Market = data.market ?? "US";
  const code = data.code ?? data.ticker;
  const target: IngestTarget = {
    key: data.key,
    ticker: data.ticker,
    name: data.name,
    market,
    code,
    exchange: data.exchange ?? exchangeForMarket(market, code),
    coverageTier: data.coverageTier,
    indexCode: data.indexCode,
    indexAsOf: data.indexAsOf,
  };

  await markJobActive(data.runId, queue, data.key);
  const startedAt = Date.now();
  try {
    const ctx = await getIngestContext();
    const result = await ingestSection(ctx, {
      sectionPath,
      target,
      force: data.force,
      model: config.model,
    });
    await markJobCompleted(data.runId, queue, data.key);
    log({
      event: "ingest_job_completed",
      run: data.runId,
      key: data.key,
      slug: result.slug,
      skipped: result.skipped,
      chunks: result.chunks,
      indexedChunks: result.indexedChunks,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markJobFailed(data.runId, queue, data.key, message);
    log({
      event: "ingest_job_failed",
      run: data.runId,
      key: data.key,
      durationMs: Date.now() - startedAt,
      error: message,
      retryCount: job.retryCount,
    });
    throw error;
  }
}

function defaultSectionPath(ticker: string): string {
  const safeTicker = ticker.replace(/[^A-Za-z0-9.-]+/g, "_");
  return path.join(config.sectionsDir, `${safeTicker}.md`);
}

function log(payload: Record<string, unknown>): void {
  console.error(JSON.stringify(payload));
}

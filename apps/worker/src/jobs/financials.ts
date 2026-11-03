import type { Job } from "pg-boss";

import type { Market } from "@occ/core";
import { createDb, resolveCompanyId, type Db } from "@occ/db";

import { config } from "../config.js";
import {
  getJobRow,
  markJobActive,
  markJobCompleted,
  markJobFailed,
} from "../db.js";
import { QUEUES } from "../queues.js";
import { runFinancials } from "../financials/run.js";

export interface FinancialsJobData {
  runId: string;
  key: string;
  ticker: string;
  code: string;
  market: Market;
  force?: boolean;
  /**
   * P1.5: the real `companies.id` for the run row. The financials job key is
   * `US:AAPL`, but the company-page refresh watcher queries by company id.
   */
  companyId?: string;
  /**
   * P1.5: bypass the EDGAR/F10 on-disk caches because a new filing was just
   * detected, but do NOT bypass the completed-job guard. A check retry must
   * not re-run an already completed financials job.
   */
  bypassCache?: boolean;
  /**
   * Internal: reopen a completed `backfill_jobs` row before enqueueing. The
   * ingest path relies on this for a re-ingest; the P1.5 data path sets it to
   * false so a check retry cannot redo a finished financials run.
   */
  reopenCompleted?: boolean;
}

let runtime: Promise<{ db: Db; close: () => Promise<void> }> | null = null;

function getFinancialsDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  if (!runtime) {
    const { db, pool } = createDb(config.databaseUrl, 4);
    runtime = Promise.resolve({
      db,
      close: async () => {
        await pool.end();
      },
    });
  }
  return runtime;
}

export async function closeFinancialsRuntime(): Promise<void> {
  if (!runtime) return;
  const entry = await runtime;
  runtime = null;
  await entry.close();
}

export async function handleFinancialsJobs(
  jobs: Job<FinancialsJobData>[],
): Promise<void> {
  for (const job of jobs) {
    await processFinancialsJob(job);
  }
}

async function processFinancialsJob(job: Job<FinancialsJobData>): Promise<void> {
  const data = job.data;
  const queue = QUEUES.FINANCIALS;
  const row = await getJobRow(data.runId, queue, data.key);
  if (!row) {
    log({ event: "financials_job_missing", run: data.runId, key: data.key });
    return;
  }
  if (row.status === "completed" && !data.force) {
    log({
      event: "financials_job_skip_completed",
      run: data.runId,
      key: data.key,
    });
    return;
  }

  await markJobActive(data.runId, queue, data.key);
  const startedAt = Date.now();
  try {
    const { db } = await getFinancialsDb();
    const companyId = await resolveCompanyId(db, data.ticker);
    if (!companyId) {
      throw new Error(
        `company not ingested (no ticker/alias match for ${data.ticker})`,
      );
    }
    const outcome = await runFinancials({
      db,
      companyId,
      ticker: data.ticker,
      code: data.code,
      market: data.market,
      force: Boolean(data.force || data.bypassCache),
      ...(job.signal ? { signal: job.signal } : {}),
    });
    if (outcome.written === 0 && outcome.error) {
      throw new Error(outcome.error);
    }
    await markJobCompleted(data.runId, queue, data.key);
    log({
      event: "financials_job_completed",
      run: data.runId,
      key: data.key,
      market: data.market,
      status: outcome.status,
      written: outcome.written,
      f10Facts: outcome.f10?.facts ?? 0,
      edgarFacts: outcome.edgar?.facts ?? 0,
      compared: outcome.comparison?.compared ?? 0,
      differing: outcome.comparison?.differing ?? 0,
      durationMs: Date.now() - startedAt,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markJobFailed(data.runId, queue, data.key, message);
    log({
      event: "financials_job_failed",
      run: data.runId,
      key: data.key,
      durationMs: Date.now() - startedAt,
      error: message,
      retryCount: job.retryCount,
    });
    throw error;
  }
}

function log(payload: Record<string, unknown>): void {
  console.error(JSON.stringify(payload));
}

import type { Job } from "pg-boss";

import type { Market } from "@occ/core";
import {
  createDb,
  getFinancialsRefreshState,
  markFinancialsRefreshApplied,
  markFinancialsRefreshFailed,
  markFinancialsRefreshRetry,
  maxFinancialFactPeriodEnd,
  resolveCompanyId,
  type Db,
} from "@occ/db";

import { config } from "../config.js";
import {
  getJobRow,
  markJobActive,
  markJobCompleted,
  markJobFailed,
} from "../db.js";
import { QUEUES } from "../queues.js";
import { financialsVerification } from "../data/verify.js";
import { runFinancials } from "../financials/run.js";

export interface FinancialsJobData {
  runId: string;
  key: string;
  ticker: string;
  code: string;
  market: Market;
  /** Display name for the task dock (P1.5 follow-up). */
  name?: string;
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
  let companyId: string | null = null;
  try {
    const { db } = await getFinancialsDb();
    companyId = await resolveCompanyId(db, data.ticker);
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
    const verification = await verifyFinancialsRefresh({
      db,
      companyId,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
    await markJobCompleted(
      data.runId,
      queue,
      data.key,
      verification
        ? {
            financialsStatus: verification.status,
            expectedPeriodEnd: verification.expectedPeriodEnd,
            maxPeriodEnd: verification.maxPeriodEnd,
          }
        : undefined,
    );
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
    if (companyId) {
      const { db } = await getFinancialsDb();
      await recordFinancialsFailure(db, companyId, message).catch(() => undefined);
    }
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

/**
 * P1.5 follow-up: a periodic report was detected, but the expected period may
 * not be in F10 yet. Verify against stored facts; keep the row `pending` with
 * a bounded retry instead of trusting a "successful" one-shot run.
 */
async function verifyFinancialsRefresh(input: {
  db: Db;
  companyId: string;
  error?: string;
}): Promise<{
  status: "applied" | "pending" | "failed";
  expectedPeriodEnd: string;
  maxPeriodEnd: string | null;
} | null> {
  try {
    const state = await getFinancialsRefreshState(input.db, input.companyId);
    if (!state || state.status !== "pending") return null;
    const maxPeriodEnd = await maxFinancialFactPeriodEnd(
      input.db,
      input.companyId,
    );
    const now = new Date();
    const decision = financialsVerification({
      expectedPeriodEnd: state.expectedPeriodEnd,
      maxPeriodEnd,
      attempts: state.attempts,
      firstSeenAt: state.firstSeenAt,
      now,
      maxDays: config.dataFinancialsRetryMaxDays,
    });
    await applyVerification(input.db, input.companyId, state, decision, input.error);
    log({
      event:
        decision.status === "applied"
          ? "financials_verified"
          : decision.status === "pending"
            ? "financials_verify_pending"
            : "financials_verify_failed",
      companyId: input.companyId,
      expected: state.expectedPeriodEnd,
      maxPeriodEnd,
      attempts: decision.attempts,
      nextRetryAt: decision.nextRetryAt?.toISOString() ?? null,
    });
    return {
      status: decision.status,
      expectedPeriodEnd: state.expectedPeriodEnd,
      maxPeriodEnd,
    };
  } catch (error) {
    // Verification is bookkeeping; a failure here must not fail the job.
    log({
      event: "financials_verify_error",
      companyId: input.companyId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** A failed financials run keeps the expectation pending with backoff. */
async function recordFinancialsFailure(
  db: Db,
  companyId: string,
  error: string,
): Promise<void> {
  const state = await getFinancialsRefreshState(db, companyId);
  if (!state || state.status !== "pending") return;
  const decision = financialsVerification({
    expectedPeriodEnd: state.expectedPeriodEnd,
    maxPeriodEnd: null,
    attempts: state.attempts,
    firstSeenAt: state.firstSeenAt,
    now: new Date(),
    maxDays: config.dataFinancialsRetryMaxDays,
  });
  await applyVerification(db, companyId, state, decision, error);
  log({
    event: "financials_verify_retry",
    companyId,
    expected: state.expectedPeriodEnd,
    attempts: decision.attempts,
    status: decision.status,
    nextRetryAt: decision.nextRetryAt?.toISOString() ?? null,
  });
}

async function applyVerification(
  db: Db,
  companyId: string,
  state: { expectedPeriodEnd: string },
  decision: ReturnType<typeof financialsVerification>,
  error?: string,
): Promise<void> {
  if (decision.status === "applied") {
    await markFinancialsRefreshApplied(db, companyId);
    return;
  }
  if (decision.status === "failed") {
    await markFinancialsRefreshFailed(db, {
      companyId,
      attempts: decision.attempts,
      error:
        error ??
        `expected period ${state.expectedPeriodEnd} not in structured financials after ${config.dataFinancialsRetryMaxDays} days`,
    });
    return;
  }
  await markFinancialsRefreshRetry(db, {
    companyId,
    attempts: decision.attempts,
    nextRetryAt: decision.nextRetryAt ?? new Date(),
    error: error ?? null,
  });
}

function log(payload: Record<string, unknown>): void {
  console.error(JSON.stringify(payload));
}

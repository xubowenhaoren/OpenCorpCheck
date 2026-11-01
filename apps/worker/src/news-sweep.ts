/**
 * Automatic news sweep — the single producer for `news.company`.
 *
 * One sweep selects companies whose `global_news_last_update.next_due_at` has
 * passed, leases each row (claim timeout), creates a `news` run and enqueues
 * one `news.company` job per company. Fetching stays in the existing worker
 * job; the API never fetches news.
 */
import { randomUUID } from "node:crypto";

import {
  getNewsDueSummary,
  getNewsStateTotals,
  leaseNewsCompany,
  listDueNewsCompanies,
  type DueNewsCompany,
} from "@occ/db";
import { QUEUES, sendJob, type JobSpec } from "@occ/jobs";
import {
  NEWS_COLD_START_MAX_ITEMS,
  NEWS_STEADY_MAX_ITEMS,
  newsFetchWindow,
} from "@occ/sources-news";
import type { Job, PgBoss } from "pg-boss";

import { config } from "./config.js";
import { createRun, markJobFailed, store } from "./db.js";
import { getIngestContext } from "./ingest-runtime.js";
import type { NewsJobData } from "./jobs/news.js";

export interface NewsSweepData {
  /** schedule | ui | cli */
  source?: string;
}

export interface NewsSweepResult {
  skipped: boolean;
  runId: string | null;
  due: number;
  enqueued: number;
  pruned: number;
}

const ADVISORY_LOCK = "occ:news:sweep";

export async function handleNewsSweepJobs(
  jobs: Job<NewsSweepData>[],
  deps: { boss: PgBoss },
): Promise<void> {
  for (const job of jobs) {
    try {
      const result = await runNewsSweep({ boss: deps.boss, source: job.data?.source });
      log({ event: "news_sweep", jobId: job.id, source: job.data?.source, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log({ event: "news_sweep_failed", jobId: job.id, error: message });
      throw error;
    }
  }
}

export async function runNewsSweep(deps: {
  boss: PgBoss;
  source?: string;
}): Promise<NewsSweepResult> {
  const client = await store.pool.connect();
  let locked = false;
  try {
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [ADVISORY_LOCK],
    );
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) return empty({ skipped: true });

    const pruned = await store.pruneNewsRuns(config.newsHistoryMs);
    const ctx = await getIngestContext();
    const due = await listDueNewsCompanies(ctx.db, {
      limit: config.newsSweepBatch,
    });
    if (due.length === 0) return empty({ pruned });

    // Lease before enqueue. The lease is the dedupe guard for overlapping
    // producers; a job lost with a worker crash becomes due again when it
    // expires, so no manual reset is needed.
    const claimed: Array<{ company: DueNewsCompany; payload: NewsJobData }> = [];
    for (const company of due) {
      const leased = await leaseNewsCompany(ctx.db, {
        companyId: company.companyId,
        key: company.key,
        ticker: company.ticker,
        name: company.name,
        claimTimeoutMs: config.newsClaimTimeoutMs,
      });
      if (!leased) continue;
      const window = newsFetchWindow({
        lastUpdateAt: company.lastUpdateAt,
        newestPublishedAt: company.newestPublishedAt,
      });
      claimed.push({
        company,
        payload: {
          runId: "",
          key: company.key,
          companyId: company.companyId,
          ticker: company.ticker,
          name: company.name,
          market: company.market,
          maxItems: window.maxItems,
          sinceDays: window.sinceDays,
          ttlMs: config.newsTtlMs,
          force: false,
          source: "auto",
        },
      });
    }
    if (claimed.length === 0) {
      return { skipped: false, runId: null, due: due.length, enqueued: 0, pruned };
    }

    const runId = randomUUID();
    const specs: JobSpec[] = claimed.map(({ company, payload }) => ({
      queue: QUEUES.NEWS,
      jobKey: company.key,
      companyId: company.key,
      payload: { ...payload, runId },
    }));
    await createRun(
      "news",
      {
        source: "auto",
        sweepSource: deps.source ?? "schedule",
        sweepId: runId,
        ttlMs: config.newsTtlMs,
        claimTimeoutMs: config.newsClaimTimeoutMs,
        batch: config.newsSweepBatch,
        historyMs: config.newsHistoryMs,
        maxItemsCold: NEWS_COLD_START_MAX_ITEMS,
        maxItemsSteady: NEWS_STEADY_MAX_ITEMS,
        concurrency: config.newsConcurrency,
      },
      specs,
      runId,
    );

    let enqueued = 0;
    for (const spec of specs) {
      try {
        const sent = await sendJob(deps.boss, spec.queue, spec.payload, {
          key: `${runId}:${spec.jobKey}`,
          priority: 50,
        });
        if (sent) enqueued += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await markJobFailed(runId, spec.queue, spec.jobKey, `enqueue failed: ${message}`);
        log({ event: "news_sweep_enqueue_failed", runId, key: spec.jobKey, error: message });
      }
    }

    log({
      event: "news_sweep_created",
      runId,
      due: due.length,
      claimed: claimed.length,
      enqueued,
      pruned,
    });
    return {
      skipped: false,
      runId,
      due: due.length,
      enqueued,
      pruned,
    };
  } finally {
    if (locked) {
      await client
        .query("SELECT pg_advisory_unlock(hashtext($1))", [ADVISORY_LOCK])
        .catch(() => undefined);
    }
    client.release();
  }
}

/** Operator CLI: due backlog, cursor health and recent sweeps. */
export async function newsSweepStatus(): Promise<Record<string, unknown>> {
  const ctx = await getIngestContext();
  const [due, totals] = await Promise.all([
    getNewsDueSummary(ctx.db),
    getNewsStateTotals(ctx.db),
  ]);
  const sweeps = await store.listNewsSweeps(config.newsHistoryMs, 10);
  return {
    due,
    states: totals,
    paused: totals.byStatus.paused ?? 0,
    ttlMs: config.newsTtlMs,
    sweepCron: config.newsSweepCron,
    historyMs: config.newsHistoryMs,
    sweeps,
  };
}

function empty(partial: Partial<NewsSweepResult>): NewsSweepResult {
  return {
    skipped: false,
    runId: null,
    due: 0,
    enqueued: 0,
    pruned: 0,
    ...partial,
  };
}

function log(payload: Record<string, unknown>): void {
  console.error(JSON.stringify(payload));
}

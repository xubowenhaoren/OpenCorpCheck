/**
 * Automatic daily company-data sweep (P1.5) — the single producer for
 * `data.source.check`.
 *
 * Like `news.sweep`, this is a singleton producer: it plans due
 * (company, source) pairs, leases each `company_filing_state` row, creates one
 * `data` run and enqueues checks. It never fetches a filing itself; the worker
 * job does the deterministic adapter call and follow-ups.
 */
import { randomUUID } from "node:crypto";

import {
  getFilingStateTotals,
  getFinancialsRefreshTotals,
  leaseFilingSource,
  leaseFinancialsRefresh,
  listDueFinancialsRefreshes,
  listEntityCompanies,
  listFilingStates,
  resolveCompanyId,
} from "@occ/db";
import { QUEUES, sendJob, type JobSpec } from "@occ/jobs";
import type { Job, PgBoss } from "pg-boss";

import { config } from "./config.js";
import { DATA_SOURCES, planFilingChecks } from "./data/plan.js";
import type { DataSourceCheckJobData } from "./data/types.js";
import { createRun, markJobFailed, store } from "./db.js";
import type { FinancialsJobData } from "./jobs/financials.js";
import { getIngestContext } from "./ingest-runtime.js";

export interface DataSweepData {
  /** schedule | cli */
  source?: string;
}

export interface DataSweepOptions {
  boss: PgBoss;
  source?: string;
  now?: Date;
  limit?: number;
  companyRefs?: string[];
  sources?: string[];
}

export interface DataSweepResult {
  skipped: boolean;
  runId: string | null;
  due: number;
  claimed: number;
  enqueued: number;
  /** P1.5 follow-up: pending financials verifications retried by this sweep. */
  catchUp: number;
  pruned: number;
}

const ADVISORY_LOCK = "occ:data:sweep";

export async function handleDataSweepJobs(
  jobs: Job<DataSweepData>[],
  deps: { boss: PgBoss },
): Promise<void> {
  for (const job of jobs) {
    try {
      const result = await runDataSweep({
        boss: deps.boss,
        source: job.data?.source,
      });
      log({ event: "data_sweep", jobId: job.id, source: job.data?.source, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log({ event: "data_sweep_failed", jobId: job.id, error: message });
      throw error;
    }
  }
}

export async function runDataSweep(
  options: DataSweepOptions,
): Promise<DataSweepResult> {
  const client = await store.pool.connect();
  let locked = false;
  try {
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [ADVISORY_LOCK],
    );
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) return empty({ skipped: true });

    const pruned = await store.pruneRuns("data", config.dataHistoryMs);
    const requestedSources = options.sources?.length
      ? new Set(options.sources)
      : undefined;
    if (requestedSources) {
      for (const source of requestedSources) {
        if (!DATA_SOURCES.includes(source as (typeof DATA_SOURCES)[number])) {
          throw new Error(
            `unknown source ${source}; use ${DATA_SOURCES.join(", ")}`,
          );
        }
      }
    }
    const ctx = await getIngestContext();
    const companies = await listEntityCompanies(ctx.db);

    let companyIds: Set<string> | undefined;
    if (options.companyRefs?.length) {
      companyIds = new Set<string>();
      for (const ref of options.companyRefs) {
        const id = await resolveCompanyId(ctx.db, ref);
        if (!id) throw new Error(`company not found: ${ref}`);
        companyIds.add(id);
      }
    }
    const states = await listFilingStates(
      ctx.db,
      companies.map((company) => company.id),
    );
    const planned = planFilingChecks(companies, states, {
      ...(options.now ? { now: options.now } : {}),
      limit: options.limit ?? config.dataSweepBatch,
      ...(companyIds ? { companyIds } : {}),
      ...(requestedSources ? { sources: requestedSources } : {}),
    });

    // P1.5 follow-up: catch-up pass. A detected periodic report whose expected
    // period did not land in structured financials stays `pending`; retry it
    // here without re-fetching the filing index or re-ingesting documents.
    const now = options.now ?? new Date();
    const dueFinancials = (
      await listDueFinancialsRefreshes(ctx.db, now, config.dataSweepBatch)
    ).filter((state) => {
      if (companyIds && !companyIds.has(state.companyId)) return false;
      if (requestedSources && !requestedSources.has(state.source)) return false;
      return true;
    });

    if (planned.length === 0 && dueFinancials.length === 0) {
      return empty({ pruned });
    }

    const runId = randomUUID();
    const claimed: DataSourceCheckJobData[] = [];
    for (const candidate of planned) {
      const leased = await leaseFilingSource(ctx.db, {
        companyId: candidate.companyId,
        source: candidate.source,
        market: candidate.market,
        code: candidate.code,
        claimTimeoutMs: config.dataClaimTimeoutMs,
        runId,
      });
      if (!leased) continue;
      claimed.push({
        runId,
        key: `${candidate.companyId}:${candidate.source}`,
        companyId: candidate.companyId,
        source: candidate.source,
        market: candidate.market,
        ticker: candidate.ticker,
        name: candidate.name,
        code: candidate.code,
        ...(candidate.cik ? { cik: candidate.cik } : {}),
        lastCheckedAt: candidate.lastCheckedAt?.toISOString() ?? null,
        cursor: candidate.cursor,
        claimTimeoutMs: config.dataClaimTimeoutMs,
        ttlMs: config.dataTtlMs,
        coldDays: config.dataColdDays,
        maxDays: config.dataMaxSteadyDays,
        maxItems: config.dataMaxItems,
      });
    }

    const catchUps: FinancialsJobData[] = [];
    for (const state of dueFinancials) {
      const leased = await leaseFinancialsRefresh(ctx.db, {
        companyId: state.companyId,
        claimTimeoutMs: config.dataClaimTimeoutMs,
      });
      if (!leased) continue;
      const key = `${leased.market}:${leased.ticker}`;
      catchUps.push({
        runId,
        key,
        companyId: leased.companyId,
        ticker: leased.ticker,
        code: leased.code,
        market: leased.market as FinancialsJobData["market"],
        ...(leased.name ? { name: leased.name } : {}),
        force: false,
        bypassCache: true,
        reopenCompleted: false,
      });
    }

    if (claimed.length === 0 && catchUps.length === 0) {
      return {
        skipped: false,
        runId: null,
        due: planned.length,
        claimed: 0,
        enqueued: 0,
        catchUp: 0,
        pruned,
      };
    }

    const checkSpecs: JobSpec[] = claimed.map((payload) => ({
      queue: QUEUES.DATA_SOURCE_CHECK,
      jobKey: payload.key,
      companyId: payload.companyId,
      payload: payload as unknown as Record<string, unknown>,
    }));
    const catchUpSpecs: JobSpec[] = catchUps.map((payload) => ({
      queue: QUEUES.FINANCIALS,
      jobKey: payload.key,
      companyId: payload.companyId ?? payload.key,
      payload: payload as unknown as Record<string, unknown>,
    }));
    const specs = [...checkSpecs, ...catchUpSpecs];
    await createRun(
      "data",
      {
        source: "auto",
        sweepSource: options.source ?? "schedule",
        sweepId: runId,
        ttlMs: config.dataTtlMs,
        claimTimeoutMs: config.dataClaimTimeoutMs,
        batch: config.dataSweepBatch,
        historyMs: config.dataHistoryMs,
        coldDays: config.dataColdDays,
        maxDays: config.dataMaxSteadyDays,
        maxItems: config.dataMaxItems,
        concurrency: config.dataConcurrency,
        catchUp: catchUps.length,
        ...(companyIds
          ? { companyRefs: [...companyIds] }
          : {}),
        ...(requestedSources
          ? { sources: [...requestedSources] }
          : {}),
      },
      specs,
      runId,
    );

    let enqueued = 0;
    for (const spec of specs) {
      try {
        const sent = await sendJob(options.boss, spec.queue, spec.payload, {
          key:
            spec.queue === QUEUES.FINANCIALS
              ? `${runId}:${spec.jobKey}:financials`
              : `${runId}:${spec.jobKey}`,
          priority: 45,
        });
        if (sent) enqueued += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await markJobFailed(runId, spec.queue, spec.jobKey, `enqueue failed: ${message}`);
        log({ event: "data_sweep_enqueue_failed", runId, key: spec.jobKey, error: message });
      }
    }

    log({
      event: "data_sweep_created",
      runId,
      due: planned.length,
      claimed: claimed.length,
      catchUp: catchUps.length,
      enqueued,
      pruned,
    });
    return {
      skipped: false,
      runId,
      due: planned.length,
      claimed: claimed.length,
      enqueued,
      catchUp: catchUps.length,
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

/** Operator CLI: due backlog, cursor health and recent data runs. */
export async function dataSweepStatus(): Promise<Record<string, unknown>> {
  const ctx = await getIngestContext();
  const states = await getFilingStateTotals(ctx.db);
  const financials = await getFinancialsRefreshTotals(ctx.db);
  const runs = await store.listRunsByKind("data", 10);
  return {
    due: states,
    paused: states.byStatus.paused ?? 0,
    financials,
    ttlMs: config.dataTtlMs,
    sweepCron: config.dataSweepCron,
    historyMs: config.dataHistoryMs,
    concurrency: config.dataConcurrency,
    retryMaxDays: config.dataFinancialsRetryMaxDays,
    runs,
  };
}

function empty(partial: Partial<DataSweepResult>): DataSweepResult {
  return {
    skipped: false,
    runId: null,
    due: 0,
    claimed: 0,
    enqueued: 0,
    catchUp: 0,
    pruned: 0,
    ...partial,
  };
}

function log(payload: Record<string, unknown>): void {
  console.error(JSON.stringify(payload));
}

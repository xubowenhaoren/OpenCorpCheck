/**
 * Read-only news refresh status for the UI, plus a lazy server-side trigger.
 *
 * The public UI has no refresh control (decision 34). The task dock and the
 * company News tab call this endpoint; if companies are due and the last sweep
 * is not already pending, the API enqueues the single `news.sweep` producer.
 * The worker does all fetching.
 */
import { AppError } from "@occ/core";
import {
  getNewsCompanyKey,
  getNewsDueSummary,
  getNewsRefreshState,
  resolveCompanyId,
  type Db,
} from "@occ/db";
import { QUEUES, queueCounts, sendJob, type JobStore } from "@occ/jobs";
import type { PgBoss } from "pg-boss";

import { config } from "../config.js";

export interface NewsSweepView {
  runId: string;
  status: string;
  total: number;
  done: number;
  failed: number;
  inserted: number;
  skipped: number;
  startedAt: string;
  finishedAt: string | null;
  elapsedMs: number | null;
  source: string | null;
  sweepSource: string | null;
  active: boolean;
}

export interface NewsCompanyStatusView {
  key: string;
  ticker: string;
  market: string;
  lastUpdateAt: string | null;
  lastStatus: string;
  nextDueAt: string | null;
  lastInserted: number;
  lastSkipped: number;
  consecutiveFailures: number;
  run: {
    runId: string;
    runStatus: string;
    jobStatus: string;
    inserted: number;
    skipped: number;
    startedAt: string | null;
    finishedAt: string | null;
  } | null;
}

export interface NewsStatusView {
  active: NewsSweepView | null;
  lastSweep: NewsSweepView | null;
  sweeps: NewsSweepView[];
  dueCount: number;
  nextDueAt: string | null;
  totalCompanies: number;
  ttlMs: number;
  sweepCron: string;
  historyMs: number;
  serverTime: string;
  /** True when this request found due companies (a sweep is queued or about
   * to appear); the dock polls faster so the first sweep shows up promptly. */
  triggered: boolean;
  /** True when a `news.sweep` job is queued/active but no run exists yet. */
  pendingSweep: boolean;
  company?: NewsCompanyStatusView;
}

export interface NewsServiceDeps {
  db: Db;
  store: JobStore;
  boss: PgBoss;
}

export class NewsService {
  constructor(private readonly deps: NewsServiceDeps) {}

  async getStatus(companyRef?: string): Promise<NewsStatusView> {
    const pendingSweep = await this.ensureSweep();

    const [due, sweepRows] = await Promise.all([
      getNewsDueSummary(this.deps.db),
      this.deps.store.listNewsSweeps(config.newsHistoryMs, 20),
    ]);
    const sweeps = sweepRows.map((row) => toSweepView(row));
    const active = sweeps.find((sweep) => sweep.active) ?? null;
    const base: NewsStatusView = {
      active,
      lastSweep: sweeps[0] ?? null,
      sweeps,
      dueCount: due.dueCount,
      nextDueAt: iso(due.nextDueAt),
      totalCompanies: due.total,
      ttlMs: config.newsTtlMs,
      sweepCron: config.newsSweepCron,
      historyMs: config.newsHistoryMs,
      serverTime: new Date().toISOString(),
      triggered: due.dueCount > 0,
      pendingSweep,
    };
    if (!companyRef) return base;

    const companyId = await resolveCompanyId(this.deps.db, companyRef);
    if (!companyId) {
      throw new AppError("not_found", `company not found: ${companyRef}`);
    }
    const key = await getNewsCompanyKey(this.deps.db, companyId);
    if (!key) {
      throw new AppError("not_found", `company not found: ${companyRef}`);
    }
    const [state, run] = await Promise.all([
      getNewsRefreshState(this.deps.db, companyId),
      this.deps.store.getNewsJobForCompany(key.key),
    ]);
    const company: NewsCompanyStatusView = {
      key: key.key,
      ticker: key.ticker,
      market: key.market,
      lastUpdateAt: iso(state?.lastUpdateAt),
      lastStatus: state?.lastStatus ?? "never",
      nextDueAt: iso(state?.nextDueAt),
      lastInserted: state?.lastInserted ?? 0,
      lastSkipped: state?.lastSkipped ?? 0,
      consecutiveFailures: state?.consecutiveFailures ?? 0,
      run: run
        ? {
            runId: String(run.run_id),
            runStatus: String(run.run_status),
            jobStatus: String(run.job_status),
            inserted: Number(asRecord(run.meta).inserted ?? 0),
            skipped: Number(asRecord(run.meta).skipped ?? 0),
            startedAt: iso(run.started_at),
            finishedAt: iso(run.finished_at),
          }
        : null,
    };
    return { ...base, company };
  }

  /**
   * Enqueue the sweep producer when companies are due. pg-boss's `short`
   * policy and the sweep's advisory lock make this idempotent; `sendJob`
   * returns null when a sweep is already pending. Returns whether a sweep job
   * is pending (the dock can show `排队中` before a run row exists).
   */
  private async ensureSweep(): Promise<boolean> {
    if (!config.newsSweepEnabled) return false;
    try {
      const [sweepQueue] = await queueCounts(this.deps.boss, [
        QUEUES.NEWS_SWEEP,
      ]);
      const pending =
        !!sweepQueue &&
        sweepQueue.created + sweepQueue.retry + sweepQueue.active > 0;

      const due = await getNewsDueSummary(this.deps.db);
      if (due.dueCount === 0) return pending;
      // A long sweep keeps its early companies leased until the claim timeout
      // even though their jobs may already be running; do not start a second
      // sweep while the current run is still progressing. A dead worker leaves
      // `updated_at` frozen, so the next attempt after the lease is allowed.
      const latest = await this.deps.store.getLatestNewsSweep();
      if (latest) {
        const status = String(latest.status ?? "");
        const updatedAt = new Date(String(latest.updated_at)).getTime();
        if (
          (status === "queued" || status === "running") &&
          Number.isFinite(updatedAt) &&
          Date.now() - updatedAt < config.newsClaimTimeoutMs
        ) {
          return pending;
        }
      }
      // The `short` policy only limits queued jobs; once one starts, a second
      // no-op sweep could still be queued. Skip while any sweep is pending.
      if (pending) return true;
      await sendJob(
        this.deps.boss,
        QUEUES.NEWS_SWEEP,
        { source: "ui", requestedAt: new Date().toISOString(), due: due.dueCount },
        { key: "news-sweep", priority: 80 },
      );
      return true;
    } catch (error) {
      // A status request must still render if pg-boss is briefly unavailable.
      console.error(
        JSON.stringify({
          event: "news_sweep_ensure_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return false;
    }
  }
}

function toSweepView(row: Record<string, unknown>): NewsSweepView {
  const status = String(row.status ?? "queued");
  const active = status === "queued" || status === "running";
  const createdAt = iso(row.created_at) ?? new Date(0).toISOString();
  const updatedAt = iso(row.updated_at);
  const options = asRecord(row.options);
  return {
    runId: String(row.id ?? ""),
    status,
    total: Number(row.total_jobs ?? 0),
    done: Number(row.completed_jobs ?? 0),
    failed: Number(row.failed_jobs ?? 0),
    inserted: Number(row.inserted ?? 0),
    skipped: Number(row.skipped ?? 0),
    startedAt: createdAt,
    finishedAt: active ? null : updatedAt,
    elapsedMs: active
      ? null
      : Math.max(0, new Date(updatedAt ?? createdAt).getTime() - new Date(createdAt).getTime()),
    source: typeof options.source === "string" ? options.source : null,
    sweepSource:
      typeof options.sweepSource === "string" ? options.sweepSource : null,
    active,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function iso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

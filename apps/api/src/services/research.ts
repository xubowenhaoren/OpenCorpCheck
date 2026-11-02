import {
  AppError,
  type EnqueueResearchView,
  type ResearchRequest,
  type ResearchRunView,
  type RunJobStatus,
  type RunStatus,
} from "@occ/core";
import {
  getCompanyBundle,
  resolveCompanyId,
  type CompanyBundle,
  type Db,
} from "@occ/db";
import { QUEUES, sendJob, type JobStore } from "@occ/jobs";
import type { PgBoss } from "pg-boss";

import { config } from "../config.js";

const MAG7 = new Set(["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"]);

const MARKET_BY_EXCHANGE: Record<string, "A" | "HK" | "US"> = {
  SSE: "A",
  SZSE: "A",
  BSE: "A",
  HKEX: "HK",
  NASDAQ: "US",
  NYSE: "US",
  AMEX: "US",
  CBOE: "US",
};

export interface ResearchServiceDeps {
  db: Db;
  store: JobStore;
  boss: PgBoss;
}

/**
 * Queues company-profile research for agents (`deep_research` MCP tool) and
 * exposes run status. It writes the same `backfill_runs` / `backfill_jobs` rows
 * and pg-boss payload as `occ-backfill enqueue research`, so the worker
 * executes it with no special case.
 */
export class ResearchService {
  constructor(private readonly deps: ResearchServiceDeps) {}

  async enqueue(
    request: ResearchRequest,
  ): Promise<EnqueueResearchView> {
    const companyId = await resolveCompanyId(this.deps.db, request.company);
    if (!companyId) {
      throw new AppError("not_found", `company not found: ${request.company}`);
    }
    const bundle = await getCompanyBundle(this.deps.db, companyId);
    if (!bundle) {
      throw new AppError("not_found", `company not found: ${request.company}`);
    }

    const listing = pickListing(bundle);
    if (!listing) {
      throw new AppError(
        "bad_request",
        `${bundle.company.displayName} has no supported listing; profile research needs a ticker with a known exchange`,
      );
    }

    const skill = MAG7.has(listing.ticker) ? "mag7-profile" : "company-profile";
    const jobKey = `${listing.market}:${listing.code}`;
    const runId = crypto.randomUUID();
    const payload = {
      runId,
      key: jobKey,
      ticker: listing.ticker,
      name: bundle.company.displayName,
      market: listing.market,
      code: listing.code,
      exchange: listing.exchange,
      skill,
      ...(request.focus ? { focus: request.focus } : {}),
      force: request.force,
      mock: false,
      includeF10: request.include_f10,
      ingest: true,
      coverageTier: bundle.company.coverageTier,
    };

    await this.deps.store.createRun(
      "research",
      {
        source: "agent",
        company: request.company,
        companyId,
        focus: request.focus ?? null,
        includeF10: request.include_f10,
        force: request.force,
        model: config.researchModel,
      },
      [
        {
          queue: QUEUES.RESEARCH,
          jobKey,
          companyId,
          payload,
        },
      ],
      runId,
    );
    const sent = await sendJob(this.deps.boss, QUEUES.RESEARCH, payload, {
      key: `${runId}:${jobKey}`,
      priority: MAG7.has(listing.ticker) ? 60 : 50,
    }).catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.store.markJobFailed(
        runId,
        QUEUES.RESEARCH,
        jobKey,
        `enqueue failed: ${message}`,
      );
      throw new AppError("upstream_error", `failed to queue research: ${message}`);
    });

    return {
      runId,
      jobKey,
      company: {
        id: bundle.company.id,
        slug: bundle.company.slug,
        displayName: bundle.company.displayName,
        ticker: listing.ticker,
        market: listing.market,
        skill,
      },
      status: "queued",
      queued: sent !== null,
      ...(sent === null
        ? {
            message:
              "an identical job is already queued (singleton key); poll the run with get_run",
          }
        : {}),
    };
  }

  async getRun(runId: string): Promise<ResearchRunView> {
    const detail = await this.deps.store.getRunDetail(runId);
    if (!detail.run) {
      throw new AppError("not_found", `run not found: ${runId}`);
    }
    return toRunView(detail);
  }

  async listRuns(limit: number): Promise<ResearchRunView[]> {
    const rows = await this.deps.store.listRuns(limit);
    return rows.map((row) => toRunView({ run: row, jobs: [] }));
  }
}

interface Listing {
  ticker: string;
  code: string;
  exchange: string;
  market: "A" | "HK" | "US";
}

function pickListing(bundle: CompanyBundle): Listing | null {
  for (const security of bundle.securities) {
    const market = MARKET_BY_EXCHANGE[security.exchange.toUpperCase()];
    if (!market) continue;
    return {
      ticker: security.ticker,
      code: security.ticker,
      exchange: security.exchange.toUpperCase(),
      market,
    };
  }
  return null;
}

type RunDetailJob = {
  queue: string;
  job_key: string;
  company_id: string;
  status: string;
  attempts: number;
  last_error: string | null;
  duration_ms: number | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  payload?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

function toRunView(detail: {
  run: Record<string, unknown> | null;
  jobs: RunDetailJob[];
  summary?: {
    counts: Record<string, number>;
    durationMs: { p50: number | null; p95: number | null; avg: number | null };
    tokens: { input: number; output: number };
    news?: { inserted: number; skipped: number };
    failed: Array<{
      company_id: string;
      page: string | null;
      attempts: number;
      last_error: string | null;
    }>;
  };
}): ResearchRunView {
  const run = detail.run ?? {};
  return {
    id: String(run.id ?? ""),
    kind: String(run.kind ?? "research") as ResearchRunView["kind"],
    status: String(run.status ?? "queued") as RunStatus,
    totalJobs: Number(run.total_jobs ?? 0),
    completedJobs: Number(run.completed_jobs ?? 0),
    failedJobs: Number(run.failed_jobs ?? 0),
    options: (run.options as Record<string, unknown> | undefined) ?? {},
    createdAt: iso(run.created_at),
    updatedAt: iso(run.updated_at),
    jobs: detail.jobs.map((job) => ({
      queue: job.queue,
      jobKey: job.job_key,
      companyId: job.company_id,
      status: job.status as RunJobStatus,
      attempts: job.attempts,
      ...(job.last_error ? { lastError: job.last_error } : {}),
      ...(job.duration_ms !== null ? { durationMs: job.duration_ms } : {}),
      ...(job.started_at ? { startedAt: iso(job.started_at) } : {}),
      ...(job.finished_at ? { finishedAt: iso(job.finished_at) } : {}),
      ...(job.payload ? { payload: job.payload } : {}),
      ...(job.meta ? { meta: job.meta } : {}),
    })),
    ...(detail.summary ? { summary: detail.summary } : {}),
  };
}

function iso(value: unknown): string {
  if (!value) return new Date(0).toISOString();
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

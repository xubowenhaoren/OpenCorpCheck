import type { Job } from "pg-boss";

import {
  getFilingState,
  leaseFilingSource,
  listEntityCompanies,
  resolveCompanyId,
} from "@occ/db";

import { config } from "./config.js";
import { candidatesForCompany } from "./data/plan.js";
import {
  createFollowUpJob,
  markJobDeadByKey,
  resetJobForRetry,
  upsertCompanyState,
} from "./db.js";
import { handleDataSweepJobs, type DataSweepData } from "./data-sweep.js";
import type { DataSourceCheckJobData, FilingIngestJobData } from "./data/types.js";
import {
  handleDataSourceCheckJobs,
  type DataSourceCheckDeps,
} from "./jobs/data-source-check.js";
import { handleF10Jobs, type F10JobData } from "./jobs/f10.js";
import {
  closeFinancialsRuntime,
  handleFinancialsJobs,
  type FinancialsJobData,
} from "./jobs/financials.js";
import { handleFilingIngestJobs } from "./jobs/filing-ingest.js";
import { handleIngestJobs, type IngestJobData } from "./jobs/ingest.js";
import { handleNewsJobs, type NewsJobData } from "./jobs/news.js";
import { handleNewsSweepJobs, type NewsSweepData } from "./news-sweep.js";
import { handleResearchJobs, type ResearchJobData } from "./jobs/research.js";
import {
  handleReviewJobs,
  type ReviewJobData,
} from "./jobs/review.js";
import { closeIngestRuntime, getIngestContext } from "./ingest-runtime.js";
import { stopNimGateway } from "./nim-gateway.js";
import {
  QUEUES,
  pendingJobs,
  queueCounts,
  registerDataSweepSchedule,
  registerNewsSweepSchedule,
  sendJob,
  startBoss,
} from "./queues.js";

export type QueueKind =
  | "research"
  | "ingest"
  | "review"
  | "news"
  | "f10"
  | "financials"
  | "data";

export interface WorkerOptions {
  queues: QueueKind[];
  drain?: boolean;
}

interface DeadJobData {
  runId?: string;
  key?: string;
}

export async function runWorkers(options: WorkerOptions): Promise<void> {
  const boss = await startBoss();
  const kinds = new Set(options.queues);

  const enqueueIngest = async (data: IngestJobData): Promise<void> => {
    await resetJobForRetry(data.runId, QUEUES.INGEST, data.key);
    await createFollowUpJob({
      runId: data.runId,
      queue: QUEUES.INGEST,
      jobKey: data.key,
      companyId: data.key,
      payload: data,
    });
    await sendJob(boss, QUEUES.INGEST, data, {
      key: `${data.runId}:${data.key}:ingest:${data.reviewAttempt ?? 0}`,
      priority: 50,
    });
  };

  const enqueueReview = async (
    data: ReviewJobData,
    delayMs = 0,
  ): Promise<void> => {
    await resetJobForRetry(data.runId, QUEUES.REVIEW, data.key);
    await createFollowUpJob({
      runId: data.runId,
      queue: QUEUES.REVIEW,
      jobKey: data.key,
      companyId: data.key,
      payload: data,
    });
    await sendJob(boss, QUEUES.REVIEW, data, {
      key: `${data.runId}:${data.key}:review:${data.reviewAttempt ?? 0}`,
      priority: 40,
      ...(delayMs > 0 ? { startAfter: Math.ceil(delayMs / 1_000) } : {}),
    });
  };

  const enqueueFinancials = async (
    data: FinancialsJobData,
    options?: { keySuffix?: string },
  ): Promise<void> => {
    // The ingest path reopens a completed row for a re-ingest; the P1.5 data
    // path sets reopenCompleted=false so a check retry cannot redo the run.
    if (data.reopenCompleted !== false) {
      await resetJobForRetry(data.runId, QUEUES.FINANCIALS, data.key);
    }
    await createFollowUpJob({
      runId: data.runId,
      queue: QUEUES.FINANCIALS,
      jobKey: data.key,
      companyId: data.companyId ?? data.key,
      payload: data,
    });
    await sendJob(boss, QUEUES.FINANCIALS, data, {
      // A review-routed rerun must not collide with the original ingest
      // financials singleton key when that job is still active.
      key: `${data.runId}:${data.key}:financials${options?.keySuffix ?? ""}`,
      priority: 45,
    });
  };

  const enqueueFilingIngest = async (
    data: FilingIngestJobData,
  ): Promise<void> => {
    // Never reopen a completed row: a check retry must not re-ingest filings
    // that were already applied. The handler also skips completed rows.
    await createFollowUpJob({
      runId: data.runId,
      queue: QUEUES.FILING_INGEST,
      jobKey: data.key,
      companyId: data.companyId,
      payload: data,
    });
    await sendJob(boss, QUEUES.FILING_INGEST, data, {
      key: `${data.runId}:${data.key}:filing`,
      priority: 50,
    });
  };

  const dataDeps: DataSourceCheckDeps = {
    enqueueFinancials,
    enqueueFilingIngest,
  };

  const enqueueResearchRevision = async (
    data: ReviewJobData,
    feedback: string,
    nextAttempt: number,
  ): Promise<void> => {
    const base: ResearchJobData =
      data.researchPayload ?? {
        runId: data.runId,
        key: data.key,
        ticker: data.ticker,
        name: data.name,
        ...(data.market ? { market: data.market } : {}),
      };
    const payload: ResearchJobData = {
      ...base,
      runId: data.runId,
      key: data.key,
      ticker: data.ticker,
      name: data.name,
      feedback,
      review: true,
      reviewAttempt: nextAttempt,
      force: true,
    };
    // Reuse the company's existing research row; the reviewer's revision is
    // the same unit of work, not a second company.
    await resetJobForRetry(data.runId, QUEUES.RESEARCH, data.key);
    await sendJob(boss, QUEUES.RESEARCH, payload, {
      key: `${data.runId}:${data.key}:revise:${nextAttempt}`,
      priority: 30,
    });
  };

  /**
   * Route a `financials` review issue to the deterministic statement layer.
   * The review follow-up is scheduled by the review job itself (delayed), so a
   * separate data/financials worker process can execute this job and the loop
   * still resumes.
   */
  const enqueueFinancialsRerun = async (
    data: ReviewJobData,
    nextAttempt: number,
  ): Promise<void> => {
    const market = data.market ?? marketFromKey(data.key);
    if (!market) {
      throw new Error(`cannot route a financials issue: unknown market for ${data.key}`);
    }
    const payload: FinancialsJobData = {
      runId: data.runId,
      key: data.key,
      ticker: data.ticker,
      code: data.ticker,
      market,
      force: true,
      bypassCache: true,
      reopenCompleted: true,
      ...(data.name ? { name: data.name } : {}),
    };
    log({
      event: "review_route_financials",
      run: data.runId,
      key: data.key,
      attempt: nextAttempt,
    });
    await enqueueFinancials(payload, {
      keySuffix: `:review:${nextAttempt}`,
    });
  };

  /**
   * Route a `filings` review issue to the P1.5 index check + ingest pipeline.
   * The check may itself enqueue financials for a new periodic report; that is
   * fine because the follow-up review is time-delayed, not completion-bound.
   */
  const enqueueFilingsRefresh = async (
    data: ReviewJobData,
    nextAttempt: number,
  ): Promise<void> => {
    const ctx = await getIngestContext();
    const companyId = await resolveCompanyId(ctx.db, data.ticker);
    if (!companyId) {
      throw new Error(
        `cannot route a filings issue: company not found for ${data.ticker}`,
      );
    }
    const market = data.market ?? marketFromKey(data.key);
    const companies = await listEntityCompanies(ctx.db);
    const company = companies.find((candidate) => candidate.id === companyId);
    const candidates = company ? candidatesForCompany(company) : [];
    const candidate =
      candidates.find((entry) => entry.market === market) ?? candidates[0];
    if (!candidate) {
      throw new Error(
        `cannot route a filings issue: no official filing source for ${data.key}`,
      );
    }
    const state = await getFilingState(ctx.db, companyId, candidate.source);
    const payload: DataSourceCheckJobData = {
      runId: data.runId,
      key: `${companyId}:${candidate.source}`,
      companyId,
      source: candidate.source,
      market: candidate.market,
      ticker: candidate.ticker,
      ...(data.name ? { name: data.name } : {}),
      code: candidate.code,
      ...(candidate.cik ? { cik: candidate.cik } : {}),
      lastCheckedAt: state?.lastCheckedAt?.toISOString() ?? null,
      cursor: state?.cursor ?? null,
      claimTimeoutMs: config.dataClaimTimeoutMs,
      ttlMs: config.dataTtlMs,
      coldDays: config.dataColdDays,
      maxDays: config.dataMaxSteadyDays,
      maxItems: config.dataMaxItems,
      force: true,
    };
    // Claim the source so a concurrent daily sweep does not double-check it.
    // A live lease means a check is already running; enqueueing this one is
    // still correct for the review loop and the mark-completed guard dedupes.
    await leaseFilingSource(ctx.db, {
      companyId,
      source: candidate.source,
      market: candidate.market,
      code: candidate.code,
      claimTimeoutMs: config.dataClaimTimeoutMs,
      runId: data.runId,
    });
    await createFollowUpJob({
      runId: data.runId,
      queue: QUEUES.DATA_SOURCE_CHECK,
      jobKey: payload.key,
      companyId,
      payload,
    });
    await sendJob(boss, QUEUES.DATA_SOURCE_CHECK, payload, {
      key: `${data.runId}:${payload.key}:review:${nextAttempt}`,
      priority: 35,
    });
    log({
      event: "review_route_filings",
      run: data.runId,
      key: data.key,
      attempt: nextAttempt,
      source: candidate.source,
    });
  };

  const enqueueReviewFollowUp = async (
    data: ReviewJobData,
    nextAttempt: number,
  ): Promise<void> => {
    await enqueueReview(
      { ...data, reviewAttempt: nextAttempt },
      config.reviewRouteDelayMs,
    );
  };

  if (kinds.has("research")) {
    await boss.work<ResearchJobData>(
      QUEUES.RESEARCH,
      {
        batchSize: 1,
        localConcurrency: config.researchConcurrency,
        pollingIntervalSeconds: 2,
      },
      (jobs) => handleResearchJobs(jobs, { enqueueIngest }),
    );
    await boss.work<DeadJobData>(
      QUEUES.RESEARCH_DEAD,
      { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 },
      handleDead,
    );
  }
  if (kinds.has("ingest")) {
    await boss.work<IngestJobData>(
      QUEUES.INGEST,
      {
        batchSize: 1,
        localConcurrency: config.ingestConcurrency,
        pollingIntervalSeconds: 2,
      },
      (jobs) => handleIngestJobs(jobs, { enqueueReview, enqueueFinancials }),
    );
    await boss.work<DeadJobData>(
      QUEUES.INGEST_DEAD,
      { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 },
      handleDead,
    );
  }
  if (kinds.has("review")) {
    await boss.work<ReviewJobData>(
      QUEUES.REVIEW,
      {
        batchSize: 1,
        localConcurrency: config.reviewConcurrency,
        pollingIntervalSeconds: 2,
      },
      (jobs) => handleReviewJobs(jobs, {
        enqueueResearchRevision,
        enqueueFinancialsRerun,
        enqueueFilingsRefresh,
        enqueueReviewFollowUp,
      }),
    );
    await boss.work<DeadJobData>(
      QUEUES.REVIEW_DEAD,
      { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 },
      handleDead,
    );
  }
  if (kinds.has("news")) {
    await boss.work<NewsJobData>(
      QUEUES.NEWS,
      {
        batchSize: 1,
        localConcurrency: config.newsConcurrency,
        pollingIntervalSeconds: 2,
      },
      handleNewsJobs,
    );
    await boss.work<NewsSweepData>(
      QUEUES.NEWS_SWEEP,
      { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 5 },
      (jobs) => handleNewsSweepJobs(jobs, { boss }),
    );
    await boss.work<DeadJobData>(
      QUEUES.NEWS_DEAD,
      { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 },
      handleDead,
    );
    if (config.newsSweepEnabled) {
      await registerNewsSweepSchedule(
        boss,
        config.newsSweepCron,
        config.newsSweepTz,
      );
    }
  }
  if (kinds.has("f10")) {
    await boss.work<F10JobData>(
      QUEUES.F10,
      {
        batchSize: 1,
        localConcurrency: config.f10Concurrency,
        pollingIntervalSeconds: 2,
      },
      handleF10Jobs,
    );
    await boss.work<DeadJobData>(
      QUEUES.F10_DEAD,
      { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 },
      handleDead,
    );
  }
  if (kinds.has("financials")) {
    await boss.work<FinancialsJobData>(
      QUEUES.FINANCIALS,
      {
        batchSize: 1,
        localConcurrency: config.financialsConcurrency,
        pollingIntervalSeconds: 2,
      },
      handleFinancialsJobs,
    );
    await boss.work<DeadJobData>(
      QUEUES.FINANCIALS_DEAD,
      { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 },
      handleDead,
    );
  }
  if (kinds.has("data")) {
    await boss.work<DataSweepData>(
      QUEUES.DATA_SWEEP,
      { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 5 },
      (jobs) => handleDataSweepJobs(jobs, { boss }),
    );
    await boss.work<DataSourceCheckJobData>(
      QUEUES.DATA_SOURCE_CHECK,
      {
        batchSize: 1,
        localConcurrency: config.dataConcurrency,
        pollingIntervalSeconds: 2,
      },
      (jobs) => handleDataSourceCheckJobs(jobs, dataDeps),
    );
    await boss.work<FilingIngestJobData>(
      QUEUES.FILING_INGEST,
      {
        batchSize: 1,
        localConcurrency: config.filingsConcurrency,
        pollingIntervalSeconds: 2,
      },
      handleFilingIngestJobs,
    );
    await boss.work<DeadJobData>(
      QUEUES.DATA_SOURCE_CHECK_DEAD,
      { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 },
      handleDead,
    );
    await boss.work<DeadJobData>(
      QUEUES.FILING_INGEST_DEAD,
      { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 },
      handleDead,
    );
    if (config.dataSweepEnabled) {
      await registerDataSweepSchedule(
        boss,
        config.dataSweepCron,
        config.dataSweepTz,
      );
    }
  }

  log({
    event: "worker_started",
    queues: options.queues,
    researchConcurrency: config.researchConcurrency,
    ingestConcurrency: config.ingestConcurrency,
    reviewMaxCycles: config.reviewMaxCycles,
    reviewConcurrency: config.reviewConcurrency,
    newsConcurrency: config.newsConcurrency,
    f10Concurrency: config.f10Concurrency,
    financialsConcurrency: config.financialsConcurrency,
    dataConcurrency: config.dataConcurrency,
    filingsConcurrency: config.filingsConcurrency,
    drain: Boolean(options.drain),
  });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log({ event: "worker_stopping", signal });
    await boss.stop({ graceful: true, timeout: 30_000 });
    await closeIngestRuntime();
    await closeFinancialsRuntime();
    await stopNimGateway();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  if (options.drain) {
    await waitForDrain(boss, queueNamesFor(options.queues));
    log({ event: "worker_drained" });
    await boss.stop({ graceful: true, timeout: 30_000 });
    await closeIngestRuntime();
    await closeFinancialsRuntime();
    await stopNimGateway();
    return;
  }

  // Keep the process alive; workers poll in the background.
  await new Promise<void>(() => {});
}

async function handleDead(jobs: Job<DeadJobData>[]): Promise<void> {
  for (const job of jobs) {
    const data = job.data;
    if (data.runId && data.key) {
      // Scope to the originating queue: financials reuses the company key, so
      // an unscoped update would mark the research/ingest row dead too.
      const sourceQueue = job.name.replace(/\.dead$/, "");
      await markJobDeadByKey(data.runId, data.key, sourceQueue);
      // Only the research pipeline owns company_research_state. A dead
      // financials/news/f10 job is an enrichment gap, not a failed profile.
      if (
        job.name === QUEUES.RESEARCH_DEAD ||
        job.name === QUEUES.INGEST_DEAD
      ) {
        await upsertCompanyState({
          companyId: data.key,
          status: "failed",
          runId: data.runId,
          lastError: `dead-lettered from ${job.name}`,
        });
      } else if (job.name === QUEUES.REVIEW_DEAD) {
        await upsertCompanyState({
          companyId: data.key,
          status: "needs_review",
          runId: data.runId,
          lastError: `dead-lettered from ${job.name}`,
        });
      }
    }
    log({
      event: "job_dead_lettered",
      queue: job.name,
      run: data.runId ?? null,
      key: data.key ?? null,
    });
  }
}

function queueNamesFor(kinds: QueueKind[]): string[] {
  const names: string[] = [];
  for (const kind of kinds) {
    if (kind === "research") names.push(QUEUES.RESEARCH, QUEUES.RESEARCH_DEAD);
    if (kind === "ingest") names.push(QUEUES.INGEST, QUEUES.INGEST_DEAD);
    if (kind === "review") names.push(QUEUES.REVIEW, QUEUES.REVIEW_DEAD);
    if (kind === "news") {
      names.push(
        QUEUES.NEWS,
        QUEUES.NEWS_DEAD,
        QUEUES.NEWS_SWEEP,
      );
    }
    if (kind === "f10") names.push(QUEUES.F10, QUEUES.F10_DEAD);
    if (kind === "financials") {
      names.push(QUEUES.FINANCIALS, QUEUES.FINANCIALS_DEAD);
    }
    if (kind === "data") {
      names.push(
        QUEUES.DATA_SWEEP,
        QUEUES.DATA_SOURCE_CHECK,
        QUEUES.DATA_SOURCE_CHECK_DEAD,
        QUEUES.FILING_INGEST,
        QUEUES.FILING_INGEST_DEAD,
      );
    }
  }
  return names;
}

async function waitForDrain(
  boss: Awaited<ReturnType<typeof startBoss>>,
  names: string[],
): Promise<void> {
  let iterations = 0;
  for (;;) {
    const counts = await queueCounts(boss, names);
    const pending = pendingJobs(counts);
    if (pending === 0) {
      // One extra turn catches retries scheduled in the same instant.
      await sleep(1_000);
      const recheck = await queueCounts(boss, names);
      if (pendingJobs(recheck) === 0) return;
      continue;
    }
    iterations += 1;
    if (iterations % 5 === 1) {
      log({
        event: "worker_drain_wait",
        pending,
        queues: counts,
      });
    }
    await sleep(2_000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Company keys are `A:600519`, `HK:00700`, `US:AAPL`, or `NAME:<slug>`. */
function marketFromKey(key: string): "A" | "HK" | "US" | undefined {
  const prefix = key.split(":")[0];
  return prefix === "A" || prefix === "HK" || prefix === "US"
    ? prefix
    : undefined;
}

function log(payload: Record<string, unknown>): void {
  console.error(JSON.stringify(payload));
}

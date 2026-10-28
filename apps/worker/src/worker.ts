import type { Job } from "pg-boss";

import { config } from "./config.js";
import { createFollowUpJob, markJobDeadByKey } from "./db.js";
import { handleF10Jobs, type F10JobData } from "./jobs/f10.js";
import { handleIngestJobs, type IngestJobData } from "./jobs/ingest.js";
import { handleResearchJobs, type ResearchJobData } from "./jobs/research.js";
import { closeIngestRuntime } from "./ingest-runtime.js";
import {
  QUEUES,
  pendingJobs,
  queueCounts,
  sendJob,
  startBoss,
} from "./queues.js";

export type QueueKind = "research" | "ingest" | "f10";

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
    await createFollowUpJob({
      runId: data.runId,
      queue: QUEUES.INGEST,
      jobKey: data.key,
      companyId: data.key,
      payload: data,
    });
    await sendJob(boss, QUEUES.INGEST, data, {
      key: `${data.runId}:${data.key}:ingest`,
      priority: 50,
    });
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
      handleIngestJobs,
    );
    await boss.work<DeadJobData>(
      QUEUES.INGEST_DEAD,
      { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 },
      handleDead,
    );
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

  log({
    event: "worker_started",
    queues: options.queues,
    researchConcurrency: config.researchConcurrency,
    ingestConcurrency: config.ingestConcurrency,
    f10Concurrency: config.f10Concurrency,
    drain: Boolean(options.drain),
  });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log({ event: "worker_stopping", signal });
    await boss.stop({ graceful: true, timeout: 30_000 });
    await closeIngestRuntime();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  if (options.drain) {
    await waitForDrain(boss, queueNamesFor(options.queues));
    log({ event: "worker_drained" });
    await boss.stop({ graceful: true, timeout: 30_000 });
    await closeIngestRuntime();
    return;
  }

  // Keep the process alive; workers poll in the background.
  await new Promise<void>(() => {});
}

async function handleDead(jobs: Job<DeadJobData>[]): Promise<void> {
  for (const job of jobs) {
    const data = job.data;
    if (data.runId && data.key) {
      await markJobDeadByKey(data.runId, data.key);
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
    if (kind === "f10") names.push(QUEUES.F10, QUEUES.F10_DEAD);
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

function log(payload: Record<string, unknown>): void {
  console.error(JSON.stringify(payload));
}

import type { Job } from "pg-boss";

import { config } from "./config.js";
import { markJobDeadByKey } from "./db.js";
import { handleF10Jobs, type F10JobData } from "./jobs/f10.js";
import { handleResearchJobs, type ResearchJobData } from "./jobs/research.js";
import {
  QUEUES,
  pendingJobs,
  queueCounts,
  startBoss,
} from "./queues.js";

export type QueueKind = "research" | "f10";

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

  if (kinds.has("research")) {
    await boss.work<ResearchJobData>(
      QUEUES.RESEARCH,
      {
        batchSize: 1,
        localConcurrency: config.researchConcurrency,
        pollingIntervalSeconds: 2,
      },
      handleResearchJobs,
    );
    await boss.work<DeadJobData>(
      QUEUES.RESEARCH_DEAD,
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
    f10Concurrency: config.f10Concurrency,
    drain: Boolean(options.drain),
  });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log({ event: "worker_stopping", signal });
    await boss.stop({ graceful: true, timeout: 30_000 });
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  if (options.drain) {
    await waitForDrain(boss);
    log({ event: "worker_drained" });
    await boss.stop({ graceful: true, timeout: 30_000 });
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

async function waitForDrain(boss: Awaited<ReturnType<typeof startBoss>>): Promise<void> {
  let iterations = 0;
  for (;;) {
    const counts = await queueCounts(boss);
    const pending = pendingJobs(counts);
    if (pending === 0) {
      // One extra turn catches retries scheduled in the same instant.
      await sleep(1_000);
      const recheck = await queueCounts(boss);
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

import type { PgBoss } from "pg-boss";

import {
  QUEUES,
  createBoss as createSharedBoss,
  pendingJobs,
  queueCounts,
  registerNewsSweepSchedule,
  sendJob,
  startBoss as startSharedBoss,
} from "@occ/jobs";

import { config } from "./config.js";

export {
  QUEUES,
  NEWS_SWEEP_SCHEDULE,
  pendingJobs,
  queueCounts,
  registerNewsSweepSchedule,
  sendJob,
} from "@occ/jobs";
export type { QueueCounts } from "@occ/jobs";

export function createBoss(): PgBoss {
  return createSharedBoss({
    connectionString: config.databaseUrl,
    applicationName: "occ-worker",
  });
}

export async function startBoss(): Promise<PgBoss> {
  return startSharedBoss({
    connectionString: config.databaseUrl,
    applicationName: "occ-worker",
  });
}

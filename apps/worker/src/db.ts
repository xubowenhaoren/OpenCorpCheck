import { JobStore } from "@occ/jobs";

import { config } from "./config.js";

/**
 * Worker view of the shared run store.
 *
 * The implementation lives in `@occ/jobs` so the API can enqueue research and
 * read run status with exactly the same schema and SQL as the worker.
 */
export const store = new JobStore(config.databaseUrl, 10, "occ-worker");

export const pool = store.pool;
export const query = store.query.bind(store);
export const migrate = store.migrate.bind(store);
export const createRun = store.createRun.bind(store);
export const getJobRow = store.getJobRow.bind(store);
export const createFollowUpJob = store.createFollowUpJob.bind(store);
export const markJobActive = store.markJobActive.bind(store);
export const markJobCompleted = store.markJobCompleted.bind(store);
export const markJobFailed = store.markJobFailed.bind(store);
export const markJobDead = store.markJobDead.bind(store);
export const markJobDeadByKey = store.markJobDeadByKey.bind(store);
export const resetJobForRetry = store.resetJobForRetry.bind(store);
export const refreshRun = store.refreshRun.bind(store);
export const getResearchCache = store.getResearchCache.bind(store);
export const upsertResearchCache = store.upsertResearchCache.bind(store);
export const upsertCompanyState = store.upsertCompanyState.bind(store);
export const getCompanyState = store.getCompanyState.bind(store);
export const listCompanyStates = store.listCompanyStates.bind(store);
export const upsertF10Page = store.upsertF10Page.bind(store);
export const getRunSummary = store.getRunSummary.bind(store);
export const listRuns = store.listRuns.bind(store);
export const closePool = store.close.bind(store);

export type {
  BackfillJobRow,
  CompanyResearchStateRow,
  CompanyResearchStatus,
  JobSpec,
  ResearchCacheRow,
  RunDetail,
  RunKind,
  RunSummary,
} from "@occ/jobs";

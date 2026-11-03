import type { DataMarket, DataSource } from "./plan.js";

/** One official-source check for one company (P1.5). */
export type DataSourceCheckJobData = {
  runId: string;
  /** `${companyId}:${source}` */
  key: string;
  companyId: string;
  source: DataSource;
  market: DataMarket;
  ticker: string;
  /** Display name for the task dock; optional for older queued payloads. */
  name?: string;
  /** Adapter code: CIK-backed ticker (US) or numeric ticker (A/HK). */
  code: string;
  cik?: string;
  /** State before this run; null = cold start (baseline only). */
  lastCheckedAt?: string | null;
  cursor?: string | null;
  claimTimeoutMs: number;
  ttlMs: number;
  coldDays: number;
  maxDays: number;
  maxItems: number;
  force?: boolean;
};

/** Follow-up: turn newly detected `filings` rows into P1.4 documents. */
export type FilingIngestJobData = {
  runId: string;
  /** `${companyId}:${source}:filing` */
  key: string;
  companyId: string;
  source: DataSource;
  market: DataMarket;
  /** `filings.id` values inserted by the check. */
  filingIds: string[];
  force?: boolean;
};

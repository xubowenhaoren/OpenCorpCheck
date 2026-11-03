import { z } from "zod";

/**
 * Agent-triggered research contracts.
 *
 * `deep_research` queues the same company-profile job the batch backfill uses.
 * It is asynchronous by design: the caller gets a run id and polls `get_run`.
 */
export const ResearchRequestSchema = z.object({
  company: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("Company ULID, slug or ticker (AAPL, 600519, 00700)"),
  /** Narrow the profile research brief, e.g. "only cloud revenue and AI capex". */
  focus: z.string().trim().min(1).max(500).optional(),
  /** Attach Eastmoney F10 tools (A/HK preferred; US cross-check). */
  include_f10: z.boolean().default(false),
  /** Ignore the research cache and regenerate the profile. */
  force: z.boolean().default(false),
});
export type ResearchRequest = z.infer<typeof ResearchRequestSchema>;

export const ResearchRunQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ResearchRunQuery = z.infer<typeof ResearchRunQuerySchema>;

export type RunStatus = "queued" | "running" | "completed" | "partial" | "failed";
export type RunJobStatus = "queued" | "active" | "completed" | "failed" | "dead";

export interface ResearchJobView {
  queue: string;
  jobKey: string;
  companyId: string;
  status: RunJobStatus;
  attempts: number;
  lastError?: string;
  durationMs?: number;
  startedAt?: string;
  finishedAt?: string;
  /** Job input; for news jobs it carries `ticker` / `name` / `market`. */
  payload?: Record<string, unknown>;
  /** Job result summary; news jobs record `inserted` / `skipped`. */
  meta?: Record<string, unknown>;
}

export interface ResearchRunView {
  id: string;
  kind: "research" | "f10" | "news" | "financials" | "data";
  status: RunStatus;
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  options: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  jobs?: ResearchJobView[];
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
}

export interface EnqueueResearchView {
  runId: string;
  jobKey: string;
  company: {
    id: string;
    slug: string;
    displayName: string;
    ticker: string;
    market: string;
    skill: string;
  };
  status: "queued";
  queued: boolean;
  /** False when an identical completed job was found and no new work was needed. */
  message?: string;
}

export interface RunResponse {
  data: ResearchRunView;
  meta: {
    request_id: string;
    as_of: string;
    took_ms: number;
  };
}

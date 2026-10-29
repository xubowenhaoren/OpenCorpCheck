import type { Job } from "pg-boss";

import { resolveCompanyId } from "@occ/db";
import { companies } from "@occ/db";
import { ingestNews } from "@occ/ingest";
import { fetchGoogleNews } from "@occ/sources-news";
import { eq } from "drizzle-orm";

import { getJobRow, markJobActive, markJobCompleted, markJobFailed } from "../db.js";
import { getIngestContext } from "../ingest-runtime.js";
import { QUEUES } from "../queues.js";

export interface NewsJobData {
  runId: string;
  key: string;
  ticker: string;
  name: string;
  market?: "A" | "HK" | "US";
  /** Search query override; defaults to the company display name. */
  query?: string;
  maxItems?: number;
  sinceDays?: number;
  force?: boolean;
}

export async function handleNewsJobs(jobs: Job<NewsJobData>[]): Promise<void> {
  for (const job of jobs) {
    await processNewsJob(job);
  }
}

async function processNewsJob(job: Job<NewsJobData>): Promise<void> {
  const data = job.data;
  const queue = QUEUES.NEWS;
  const row = await getJobRow(data.runId, queue, data.key);
  if (!row) {
    log({ event: "news_job_missing", run: data.runId, key: data.key });
    return;
  }
  if (row.status === "completed" && !data.force) {
    log({ event: "news_job_skip_completed", run: data.runId, key: data.key });
    return;
  }

  await markJobActive(data.runId, queue, data.key);
  const startedAt = Date.now();
  try {
    const ctx = await getIngestContext();
    const companyId = await resolveCompanyId(ctx.db, data.ticker);
    if (!companyId) {
      throw new Error(
        `company not found for ${data.ticker}; ingest a research profile before news ingestion`,
      );
    }
    const companyRows = await ctx.db
      .select({
        displayName: companies.displayName,
        legalName: companies.legalName,
      })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    const company = companyRows[0];
    if (!company) throw new Error(`company row missing: ${companyId}`);

    const query = data.query?.trim() || company.displayName;
    const locale = data.market === "A" || data.market === "HK" ? "zh-CN" : "en-US";
    const articles = await fetchGoogleNews(query, {
      limit: data.maxItems ?? 10,
      sinceDays: data.sinceDays ?? 30,
      locale,
    });
    const result = await ingestNews(ctx, {
      companyId,
      companyName: company.displayName,
      articles,
      market: data.market ?? "US",
      language: locale === "zh-CN" ? "zh" : "en",
      query,
      force: Boolean(data.force),
    });

    await markJobCompleted(data.runId, queue, data.key);
    log({
      event: "news_job_completed",
      run: data.runId,
      key: data.key,
      companyId,
      query,
      articles: result.articles,
      inserted: result.inserted,
      updated: result.updated,
      skipped: result.skipped,
      indexedChunks: result.indexedChunks,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markJobFailed(data.runId, queue, data.key, message);
    log({
      event: "news_job_failed",
      run: data.runId,
      key: data.key,
      durationMs: Date.now() - startedAt,
      error: message,
      retryCount: job.retryCount,
    });
    throw error;
  }
}

function log(payload: Record<string, unknown>): void {
  console.error(JSON.stringify(payload));
}

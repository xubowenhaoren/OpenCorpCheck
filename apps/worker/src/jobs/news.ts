import type { Job } from "pg-boss";

import { resolveCompanyId } from "@occ/db";
import { companies, markNewsFailure, markNewsSuccess } from "@occ/db";
import { ingestNews } from "@occ/ingest";
import { fetchGoogleNews } from "@occ/sources-news";
import { eq } from "drizzle-orm";

import { config } from "../config.js";
import { getJobRow, markJobActive, markJobCompleted, markJobFailed } from "../db.js";
import { getIngestContext } from "../ingest-runtime.js";
import { QUEUES } from "../queues.js";

export interface NewsJobData {
  runId: string;
  key: string;
  /** Real `companies.id`; present for automatic sweeps so `NAME:` targets work. */
  companyId?: string;
  ticker: string;
  name: string;
  market?: "A" | "HK" | "US";
  /** Search query override; defaults to the company display name. */
  query?: string;
  maxItems?: number;
  sinceDays?: number;
  /** Next-due horizon stamped on success (set by the automatic sweep). */
  ttlMs?: number;
  /** auto = produced by `news.sweep`; cli = operator backfill. */
  source?: "auto" | "cli";
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
  let resolvedCompanyId: string | null = data.companyId ?? null;
  let companyName = data.name;
  try {
    const ctx = await getIngestContext();
    const companyId =
      (data.companyId ? await verifyCompany(ctx.db, data.companyId) : null) ??
      (await resolveCompanyId(ctx.db, data.ticker)) ??
      (await resolveCompanyId(ctx.db, data.name));
    if (!companyId) {
      throw new Error(
        `company not found for ${data.key}; ingest a research profile before news ingestion`,
      );
    }
    resolvedCompanyId = companyId;
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
    companyName = company.displayName;

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

    const newestPublishedAt = newestArticleDate(articles);
    const status = articles.length === 0 ? "empty" : "ok";
    await markNewsSuccess(ctx.db, {
      companyId,
      key: data.key,
      ticker: data.ticker,
      name: company.displayName,
      runId: data.runId,
      status,
      inserted: result.inserted,
      skipped: result.skipped,
      newestPublishedAt,
      ttlMs: data.ttlMs ?? config.newsTtlMs,
    });

    await markJobCompleted(data.runId, queue, data.key, {
      articles: result.articles,
      inserted: result.inserted,
      updated: result.updated,
      skipped: result.skipped,
      indexedChunks: result.indexedChunks,
      query,
      ...(newestPublishedAt
        ? { newestPublishedAt: newestPublishedAt.toISOString() }
        : {}),
    });
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
    if (resolvedCompanyId) {
      try {
        const ctx = await getIngestContext();
        await markNewsFailure(ctx.db, {
          companyId: resolvedCompanyId,
          key: data.key,
          ticker: data.ticker,
          name: companyName,
          runId: data.runId,
          ttlMs: data.ttlMs ?? config.newsTtlMs,
          pauseAfterFailures: config.newsPauseAfterFailures,
        });
      } catch {
        // Stamping the cursor is best-effort; the job error is what matters.
      }
    }
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

/** Pick the newest pub date actually seen; null when the feed has none. */
function newestArticleDate(
  articles: Array<{ publishedAt?: string }>,
): Date | null {
  let newest: number | null = null;
  for (const article of articles) {
    if (!article.publishedAt) continue;
    const time = new Date(article.publishedAt).getTime();
    if (Number.isNaN(time)) continue;
    if (newest === null || time > newest) newest = time;
  }
  return newest === null ? null : new Date(newest);
}

async function verifyCompany(
  db: Awaited<ReturnType<typeof getIngestContext>>["db"],
  companyId: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return rows[0]?.id ?? null;
}

function log(payload: Record<string, unknown>): void {
  console.error(JSON.stringify(payload));
}

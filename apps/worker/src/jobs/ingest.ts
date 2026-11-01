import fs from "node:fs";
import path from "node:path";

import type { Job } from "pg-boss";

import {
  DeepSeekClient,
  extractCompany,
  type ExtractResult,
} from "@occ/extract";
import {
  exchangeForMarket,
  ingestSection,
  parseSectionMarkdown,
  type IngestTarget,
} from "@occ/ingest";
import type { CoverageTier, Market } from "@occ/core";
import type { Db } from "@occ/db";

import { config } from "../config.js";
import {
  getJobRow,
  markJobActive,
  markJobCompleted,
  markJobFailed,
  upsertCompanyState,
} from "../db.js";
import { getIngestContext } from "../ingest-runtime.js";
import { QUEUES } from "../queues.js";
import { extractF10Relations } from "../research/f10-relations.js";
import type { FinancialsJobData } from "./financials.js";
import type { ReviewJobData } from "./review.js";

export interface IngestJobData {
  runId: string;
  key: string;
  ticker: string;
  name: string;
  market?: Market;
  code?: string;
  exchange?: string;
  sectionPath?: string;
  indexCode?: string;
  indexAsOf?: string;
  coverageTier?: CoverageTier;
  force?: boolean;
  /** Run deterministic extraction after ingest (default true). */
  extract?: boolean;
  /** Enqueue the hidden reviewer after ingest (default true). */
  review?: boolean;
  reviewAttempt?: number;
  /** Original research job data, used to enqueue a bounded revision. */
  researchPayload?: import("./research.js").ResearchJobData;
}

export interface IngestJobContext {
  enqueueReview?: (data: ReviewJobData) => Promise<void>;
  enqueueFinancials?: (data: FinancialsJobData) => Promise<void>;
}

export async function handleIngestJobs(
  jobs: Job<IngestJobData>[],
  context: IngestJobContext = {},
): Promise<void> {
  for (const job of jobs) {
    await processIngestJob(job, context);
  }
}

async function processIngestJob(
  job: Job<IngestJobData>,
  context: IngestJobContext,
): Promise<void> {
  const data = job.data;
  const queue = QUEUES.INGEST;
  const row = await getJobRow(data.runId, queue, data.key);
  if (!row) {
    log({ event: "ingest_job_missing", run: data.runId, key: data.key });
    return;
  }
  if (row.status === "completed" && !data.force) {
    log({ event: "ingest_job_skip_completed", run: data.runId, key: data.key });
    return;
  }

  const sectionPath = data.sectionPath ?? defaultSectionPath(data.ticker);
  if (!fs.existsSync(sectionPath)) {
    const message = `section not found: ${sectionPath}`;
    await markJobFailed(data.runId, queue, data.key, message);
    throw new Error(message);
  }

  const market: Market = data.market ?? "US";
  const code = data.code ?? data.ticker;
  const target: IngestTarget = {
    key: data.key,
    ticker: data.ticker,
    name: data.name,
    market,
    code,
    exchange: data.exchange ?? exchangeForMarket(market, code),
    coverageTier: data.coverageTier,
    indexCode: data.indexCode,
    indexAsOf: data.indexAsOf,
  };

  await markJobActive(data.runId, queue, data.key);
  const startedAt = Date.now();
  try {
    const ctx = await getIngestContext();
    const result = await ingestSection(ctx, {
      sectionPath,
      target,
      force: data.force,
      model: config.model,
    });
    const extraction = data.extract === false
      ? null
      : await runExtraction(ctx.db, {
          companyId: result.companyId,
          slug: result.slug,
          sectionPath,
          ticker: data.ticker,
          market,
          runId: data.runId,
          key: data.key,
        });
    const f10Relations = await extractF10Relations({
      db: ctx.db,
      companyId: result.companyId,
      ticker: data.ticker,
      code,
      market,
      ...(job.signal ? { signal: job.signal } : {}),
    });
    // Structured statements are a separate queue so EDGAR/F10 failures retry
    // independently and never fail the profile ingest.
    let financialsQueued = false;
    if (
      config.financials !== "none" &&
      context.enqueueFinancials &&
      (data.reviewAttempt ?? 0) === 0
    ) {
      try {
        await context.enqueueFinancials({
          runId: data.runId,
          key: data.key,
          ticker: data.ticker,
          code,
          market,
        });
        financialsQueued = true;
      } catch (error) {
        log({
          event: "financials_enqueue_failed",
          run: data.runId,
          key: data.key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await markJobCompleted(data.runId, queue, data.key);
    if (data.review !== false && context.enqueueReview) {
      await context.enqueueReview({
        runId: data.runId,
        key: data.key,
        ticker: data.ticker,
        name: data.name,
        ...(data.market ? { market: data.market } : {}),
        sectionPath,
        reviewAttempt: data.reviewAttempt ?? 0,
        ...(data.researchPayload
          ? { researchPayload: data.researchPayload }
          : {}),
      });
      await upsertCompanyState({
        companyId: data.key,
        status: "reviewing",
        runId: data.runId,
        reviewAttempts: data.reviewAttempt ?? 0,
      });
    }
    log({
      event: "ingest_job_completed",
      run: data.runId,
      key: data.key,
      slug: result.slug,
      skipped: result.skipped,
      chunks: result.chunks,
      indexedChunks: result.indexedChunks,
      durationMs: Date.now() - startedAt,
      extraction,
      f10Relations,
      financialsQueued,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markJobFailed(data.runId, queue, data.key, message);
    await upsertCompanyState({
      companyId: data.key,
      status: "failed",
      runId: data.runId,
      reviewAttempts: data.reviewAttempt ?? 0,
      lastError: message.slice(0, 4_000),
    });
    log({
      event: "ingest_job_failed",
      run: data.runId,
      key: data.key,
      durationMs: Date.now() - startedAt,
      error: message,
      retryCount: job.retryCount,
    });
    throw error;
  }
}

async function runExtraction(
  db: Db,
  params: {
    companyId: string;
    slug: string;
    sectionPath: string;
    ticker: string;
    market: Market;
    runId: string;
    key: string;
  },
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  try {
    const markdown = fs.readFileSync(params.sectionPath, "utf8");
    const parsed = parseSectionMarkdown(markdown);
    const chat =
      config.extractRelations === "llm" && config.deepseekApiKey
        ? new DeepSeekClient({
            apiKey: config.deepseekApiKey,
            model: config.extractModel,
          })
        : undefined;
    const result: ExtractResult = await extractCompany({
      db,
      companyId: params.companyId,
      markdown,
      parsed,
      market: params.market,
      companyTicker: params.ticker,
      profileSourceId: `src_research_${params.slug}`,
      relations: config.extractRelations,
      chat,
      model: config.extractModel,
    });
    log({
      event: "extract_completed",
      run: params.runId,
      key: params.key,
      financialFacts: result.financialFacts,
      facts: result.facts,
      relations: result.relations,
      relationsSkipped: result.relationsSkipped,
      errors: result.errors,
      durationMs: Date.now() - startedAt,
    });
    return {
      financialFacts: result.financialFacts,
      facts: result.facts,
      relations: result.relations,
      skipped: result.skipped,
      relationsSkipped: result.relationsSkipped,
      errors: result.errors.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Extraction is a follow-up enrichment: never fail the ingest job for it.
    log({
      event: "extract_failed",
      run: params.runId,
      key: params.key,
      error: message,
      durationMs: Date.now() - startedAt,
    });
    return { error: message };
  }
}

function defaultSectionPath(ticker: string): string {
  const safeTicker = ticker.replace(/[^A-Za-z0-9.-]+/g, "_");
  return path.join(config.sectionsDir, `${safeTicker}.md`);
}

function log(payload: Record<string, unknown>): void {
  console.error(JSON.stringify(payload));
}

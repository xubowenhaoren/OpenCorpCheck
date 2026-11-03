import type { Job } from "pg-boss";

import { documents, listFilingsByIds, markFilingsApplied, type FilingRow } from "@occ/db";
import { ingestFilings } from "@occ/ingest";
import {
  createFilingContentLoader,
  type FilingItem,
  type FilingTrustTier,
} from "@occ/sources-filings";
import { inArray } from "drizzle-orm";

import { config } from "../config.js";
import { getJobRow, markJobActive, markJobCompleted, markJobFailed } from "../db.js";
import type { FilingIngestJobData } from "../data/types.js";
import { getIngestContext } from "../ingest-runtime.js";
import { QUEUES } from "../queues.js";

/**
 * `ingest.filing` (P1.5): turn newly detected `filings` rows into the same
 * `documents`/`chunks`/Qdrant shape as the P1.4 operator command.
 *
 * Content following is shared with the CLI through
 * `createFilingContentLoader`; EDGAR stays link-only unless
 * `OCC_FILINGS_FULL_TEXT=1`. A detected row is marked `applied` only after its
 * document is written, never optimistically.
 */
export async function handleFilingIngestJobs(
  jobs: Job<FilingIngestJobData>[],
): Promise<void> {
  for (const job of jobs) {
    await processFilingIngest(job);
  }
}

async function processFilingIngest(
  job: Job<FilingIngestJobData>,
): Promise<void> {
  const data = job.data;
  const queue = QUEUES.FILING_INGEST;
  const row = await getJobRow(data.runId, queue, data.key);
  if (!row) {
    log({ event: "filing_ingest_missing", run: data.runId, key: data.key });
    return;
  }
  if (row.status === "completed" && !data.force) {
    log({ event: "filing_ingest_skip_completed", run: data.runId, key: data.key });
    return;
  }

  await markJobActive(data.runId, queue, data.key);
  const startedAt = Date.now();
  const ctx = await getIngestContext();
  const rows = (await listFilingsByIds(ctx.db, data.filingIds)).filter(
    (filing) =>
      filing.companyId === data.companyId && filing.source === data.source,
  );
  if (rows.length === 0) {
    await markJobCompleted(data.runId, queue, data.key, {
      items: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      chunks: 0,
    });
    return;
  }

  try {
    const loadContent = createFilingContentLoader({
      dir: config.filingsDir,
      sidecarUrl: config.financeAnalystUrl,
      userAgent: config.edgarUserAgent,
      maxPages: config.filingsMaxPages,
      fullText: config.filingsFullText,
    });
    const items = rows.map((filing) => toFilingItem(filing, data.market));
    const result = await ingestFilings(ctx, {
      companyId: data.companyId,
      companyName: data.companyId,
      market: data.market,
      items,
      loadContent,
      allowHtmlContent: config.filingsFullText,
      force: Boolean(data.force),
      maxItems: items.length,
    });

    const documentIds = result.documents
      .map((document) => document.documentId)
      .filter(Boolean);
    const hashes = new Map<string, string | null>();
    if (documentIds.length > 0) {
      const documentRows = await ctx.db
        .select({ id: documents.id, sha256: documents.sha256 })
        .from(documents)
        .where(inArray(documents.id, documentIds));
      for (const document of documentRows) {
        hashes.set(document.id, document.sha256);
      }
    }
    const byExternalId = new Map(
      result.documents.map((document) => [document.externalId, document]),
    );
    await markFilingsApplied(
      ctx.db,
      rows.map((filing) => {
        const document = byExternalId.get(filing.accession);
        if (!document || document.status === "failed") {
          return {
            id: filing.id,
            status: "failed" as const,
            error:
              document?.error ??
              (document ? "filing document failed" : "filing document missing"),
          };
        }
        return {
          id: filing.id,
          status: "applied" as const,
          contentHash: hashes.get(document.documentId) ?? null,
        };
      }),
    );

    await markJobCompleted(data.runId, queue, data.key, {
      items: result.items,
      inserted: result.inserted,
      updated: result.updated,
      skipped: result.skipped,
      failed: result.failed,
      linkOnly: result.linkOnly,
      chunks: result.chunks,
      indexedChunks: result.indexedChunks,
    });
    log({
      event: "filing_ingest_completed",
      run: data.runId,
      key: data.key,
      source: data.source,
      items: result.items,
      inserted: result.inserted,
      updated: result.updated,
      skipped: result.skipped,
      failed: result.failed,
      linkOnly: result.linkOnly,
      chunks: result.chunks,
      indexedChunks: result.indexedChunks,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await markFilingsApplied(
        ctx.db,
        rows.map((filing) => ({
          id: filing.id,
          status: "failed" as const,
          error: message,
        })),
      );
    } catch {
      // Best-effort status; the job error is what matters.
    }
    await markJobFailed(data.runId, queue, data.key, message);
    log({
      event: "filing_ingest_failed",
      run: data.runId,
      key: data.key,
      source: data.source,
      durationMs: Date.now() - startedAt,
      error: message,
      retryCount: job.retryCount,
    });
    throw error;
  }
}

function toFilingItem(
  filing: FilingRow,
  market: "A" | "HK" | "US",
): FilingItem {
  const metadata = filing.metadata ?? {};
  const language =
    metadata.language === "zh" || metadata.language === "en"
      ? metadata.language
      : undefined;
  const trustTier = isTrustTier(metadata.trustTier)
    ? metadata.trustTier
    : "official";
  return {
    source: filing.source as FilingItem["source"],
    market,
    externalId: filing.accession,
    title: filing.title,
    url: filing.url,
    ...(filing.pdfUrl ? { pdfUrl: filing.pdfUrl } : {}),
    ...(filing.form ? { form: filing.form } : {}),
    ...(filing.category ? { category: filing.category } : {}),
    ...(filing.filedAt
      ? { publishedAt: filing.filedAt.toISOString() }
      : {}),
    ...(filing.periodEnd ? { periodEnd: filing.periodEnd } : {}),
    ...(language ? { language } : {}),
    trustTier,
    metadata,
  };
}

function isTrustTier(value: unknown): value is FilingTrustTier {
  return value === "official" || value === "company_ir" || value === "media";
}

function log(payload: Record<string, unknown>): void {
  console.error(JSON.stringify(payload));
}

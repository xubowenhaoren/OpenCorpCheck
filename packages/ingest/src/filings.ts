import { canonicalizeUrl, chunks, documents, sources } from "@occ/db";
import {
  ensureCollections,
  indexChunks,
  toPointId,
  type IndexableChunk,
} from "@occ/retrieval";
import {
  pdfPageText,
  type FilingItem,
  type PdfTable,
} from "@occ/sources-filings";
import { eq, inArray, sql } from "drizzle-orm";

import { sha256Text, type IngestContext } from "./ingest.js";
import { chunkText, estimateTokens } from "./sections.js";

/**
 * Turn official filing items into `documents`/`chunks` (P1.4).
 *
 * Filings share the existing document model with news and research sections:
 * one source row, one document (`doc_type='filing'`), page-numbered chunks and
 * Qdrant points. `listEvents` surfaces them as `filing` events.
 *
 * Idempotency is by canonical URL + source id: the document id is derived from
 * `(source, externalId, canonicalUrl)`, and an existing complete document is
 * not re-fetched or re-parsed. `force` re-ingests it.
 */

export interface FilingContentPage {
  page: number;
  text: string;
  tables?: PdfTable[];
}

export interface FilingContent {
  pages: FilingContentPage[];
  mime?: string;
  /** SHA-256 of the raw bytes when available (PDF/HTML). */
  rawSha256?: string;
  warnings?: string[];
  truncated?: boolean;
}

export type LoadFilingContent = (
  item: FilingItem,
) => Promise<FilingContent | null>;

export interface IngestFilingsOptions {
  companyId: string;
  companyName: string;
  market: string;
  items: FilingItem[];
  /** Optional PDF/HTML fetch + extract. Omit for link-only ingestion. */
  loadContent?: LoadFilingContent;
  /** Skip content fetching entirely (operator `--skip-pdf`). */
  skipContent?: boolean;
  /** Allow the content loader to follow EDGAR HTML (`--full-text`). */
  allowHtmlContent?: boolean;
  now?: Date;
  force?: boolean;
  /** Hard cap per company run (default 30). */
  maxItems?: number;
  /** Stop one document after this many chunks (default 240). */
  maxChunksPerDocument?: number;
}

export interface FilingDocumentResult {
  externalId: string;
  documentId: string;
  status: "inserted" | "updated" | "skipped" | "failed";
  pages: number;
  chunks: number;
  linkOnly: boolean;
  error?: string;
}

export interface IngestFilingsResult {
  companyId: string;
  items: number;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  linkOnly: number;
  chunks: number;
  indexedChunks: number;
  documents: FilingDocumentResult[];
}

interface PendingChunk {
  documentId: string;
  chunk: IndexableChunk;
}

export async function ingestFilings(
  ctx: IngestContext,
  options: IngestFilingsOptions,
): Promise<IngestFilingsResult> {
  const now = options.now ?? new Date();
  const limit = options.maxItems && options.maxItems > 0 ? options.maxItems : 30;
  const maxChunks = options.maxChunksPerDocument ?? 240;
  const unique = new Map<string, FilingItem>();
  for (const item of options.items) {
    const id = filingDocumentId(item, options.companyId);
    if (!unique.has(id)) unique.set(id, item);
  }
  const items = [...unique.values()].slice(0, limit);
  const result: IngestFilingsResult = {
    companyId: options.companyId,
    items: items.length,
    inserted: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    linkOnly: 0,
    chunks: 0,
    indexedChunks: 0,
    documents: [],
  };
  const pending: PendingChunk[] = [];

  for (const item of items) {
    try {
      const canonicalUrl = canonicalizeUrl(item.url);
      const documentId = filingDocumentId(item, options.companyId, canonicalUrl);
      const sourceId = `src_filing_${sha256Text(canonicalUrl).slice(0, 24)}`;
      const existing = await ctx.db
        .select({ sha256: documents.sha256, metadata: documents.metadata })
        .from(documents)
        .where(eq(documents.id, documentId))
        .limit(1);
      const previous = existing[0];
      const previousMeta = (previous?.metadata ?? {}) as Record<string, unknown>;
      const previousLinkOnly = Boolean(previousMeta.linkOnly);
      const previousAttempted = previousMeta.contentAttempted === true;
      const previousContentError =
        typeof previousMeta.contentError === "string" &&
        previousMeta.contentError.length > 0;
      // Old rows without `indexed` are treated as indexed so this change does
      // not re-ingest the whole corpus.
      const previousIndexed = previousMeta.indexed !== false;
      const contentAvailable =
        Boolean(item.pdfUrl) ||
        (Boolean(options.allowHtmlContent) && item.source === "edgar");
      const shouldRetry =
        Boolean(options.force) ||
        !previous ||
        !previousIndexed ||
        (previousLinkOnly &&
          !options.skipContent &&
          contentAvailable &&
          (!previousAttempted || previousContentError));
      if (!shouldRetry) {
        result.skipped += 1;
        result.documents.push({
          externalId: item.externalId,
          documentId,
          status: "skipped",
          pages: Number(previousMeta.pages ?? 0),
          chunks: 0,
          linkOnly: previousLinkOnly,
        });
        continue;
      }

      let content: FilingContent | null = null;
      let contentError: string | null = null;
      const warnings: string[] = [];
      if (options.loadContent && !options.skipContent) {
        try {
          content = await options.loadContent(item);
        } catch (error) {
          contentError = `content fetch failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
          warnings.push(contentError);
        }
      }
      warnings.push(...(content?.warnings ?? []));
      const pages = (content?.pages ?? []).filter(
        (page) => pageText(page).length > 0,
      );
      // A failed refresh must never replace a good document with a link-only
      // one. Keep the existing chunks/points and report it as skipped.
      if (previous && !previousLinkOnly && pages.length === 0) {
        result.skipped += 1;
        result.documents.push({
          externalId: item.externalId,
          documentId,
          status: "skipped",
          pages: Number(previousMeta.pages ?? 0),
          chunks: 0,
          linkOnly: false,
          error:
            contentError ??
            (options.skipContent
              ? "content skipped; existing document preserved"
              : "no text extracted; existing document preserved"),
        });
        continue;
      }
      const contentAttempted =
        Boolean(options.loadContent) &&
        !options.skipContent &&
        (content !== null || contentError !== null);
      const linkOnly = pages.length === 0;
      const pageChunks = buildPageChunks(pages, maxChunks);
      if (pageChunks.chunks.length === 0) {
        pageChunks.chunks.push({
          ordinal: 0,
          page: null,
          section: "公告",
          text: linkOnlyText(item),
        });
        pageChunks.linkOnly = true;
      }
      const text = pageChunks.chunks.map((chunk) => chunk.text).join("\n\n");
      const textSha = sha256Text(text);
      const rawSha = content?.rawSha256 ?? textSha;
      const metadata = {
        ...item.metadata,
        source: item.source,
        sourceName:
          typeof item.metadata?.source === "string"
            ? item.metadata.source
            : null,
        market: options.market,
        externalId: item.externalId,
        canonicalUrl,
        form: item.form ?? null,
        category: item.category ?? null,
        pdfUrl: item.pdfUrl ?? null,
        trustTier: item.trustTier ?? "official",
        linkOnly,
        contentAttempted,
        contentError,
        indexed: false,
        pages: pages.length,
        pageCount: content?.pages.length ?? pages.length,
        truncated: Boolean(content?.truncated) || pageChunks.truncated,
        warnings,
        textSha256: textSha,
        rawSha256: rawSha,
      };
      const publishedAt = item.publishedAt
        ? new Date(item.publishedAt)
        : undefined;
      const validPublishedAt =
        publishedAt && !Number.isNaN(publishedAt.getTime())
          ? publishedAt
          : null;
      const chunkRows = pageChunks.chunks.map((chunk) => {
        const chunkId = `${documentId}_c${chunk.ordinal}`;
        const pointId = toPointId(chunkId);
        return {
          row: {
            id: chunkId,
            documentId,
            companyId: options.companyId,
            ordinal: chunk.ordinal,
            page: chunk.page,
            section: chunk.section,
            text: chunk.text,
            tokenCount: estimateTokens(chunk.text),
            qdrantPointId: pointId,
            embeddingVersion: ctx.embeddingVersion,
          } satisfies typeof chunks.$inferInsert,
          chunk: {
            id: chunkId,
            documentId,
            companyId: options.companyId,
            text: chunk.text,
            title: item.title,
            docType: "filing",
            market: options.market,
            lang: item.language ?? null,
            sourceUrl: item.url,
            page: chunk.page,
            section: chunk.section,
            publishedAt: item.publishedAt ?? now.toISOString(),
            isFixture: false,
          } satisfies IndexableChunk,
        };
      });

      await ctx.db.transaction(async (tx) => {
        await tx
          .insert(sources)
          .values({
            id: sourceId,
            url: item.url,
            canonicalUrl,
            domain: domainOf(canonicalUrl),
            title: item.title,
            fetchedAt: now,
            httpStatus: 200,
            contentHash: textSha,
            trustTier: item.trustTier ?? "official",
            license: "official filing · link-only · no bulk redistribution",
            robotsOk: true,
          })
          .onConflictDoUpdate({
            target: sources.id,
            set: {
              url: item.url,
              canonicalUrl,
              domain: domainOf(canonicalUrl),
              title: item.title,
              fetchedAt: now,
              contentHash: textSha,
              trustTier: item.trustTier ?? "official",
            },
          });

        await tx
          .insert(documents)
          .values({
            id: documentId,
            sourceId,
            companyId: options.companyId,
            docType: "filing",
            mime: content?.mime ?? "text/plain",
            storageKey: null,
            sha256: rawSha,
            language: item.language ?? null,
            pageCount: pages.length || null,
            extractorVersion: `filing-${item.source}-v1`,
            title: item.title,
            publishedAt: validPublishedAt,
            isFixture: false,
            metadata,
          })
          .onConflictDoUpdate({
            target: documents.id,
            set: {
              sourceId,
              companyId: options.companyId,
              docType: "filing",
              mime: content?.mime ?? "text/plain",
              sha256: rawSha,
              language: item.language ?? null,
              pageCount: pages.length || null,
              extractorVersion: `filing-${item.source}-v1`,
              title: item.title,
              publishedAt: validPublishedAt,
              isFixture: false,
              metadata,
            },
          });

        await tx.delete(chunks).where(eq(chunks.documentId, documentId));
        if (chunkRows.length > 0) {
          await tx.insert(chunks).values(chunkRows.map((entry) => entry.row));
        }
      });
      // Index only after the transaction commits; a rolled-back document must
      // never leave Qdrant points behind.
      for (const entry of chunkRows) {
        pending.push({ documentId, chunk: entry.chunk });
      }

      const isUpdate = Boolean(previous);
      if (isUpdate) result.updated += 1;
      else result.inserted += 1;
      if (linkOnly) result.linkOnly += 1;
      result.chunks += pageChunks.chunks.length;
      result.documents.push({
        externalId: item.externalId,
        documentId,
        status: isUpdate ? "updated" : "inserted",
        pages: pages.length,
        chunks: pageChunks.chunks.length,
        linkOnly,
      });
    } catch (error) {
      result.failed += 1;
      result.documents.push({
        externalId: item.externalId,
        documentId: "",
        status: "failed",
        pages: 0,
        chunks: 0,
        linkOnly: true,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (pending.length > 0 && !ctx.skipIndex) {
    const documentIds = [...new Set(pending.map((entry) => entry.documentId))];
    await ensureCollections(ctx.qdrant, ctx.collections, ctx.embeddingDim);
    for (const documentId of documentIds) {
      await ctx.qdrant.deleteByFilter(ctx.collections.documents, {
        must: [{ key: "document_id", match: { value: documentId } }],
      });
    }
    result.indexedChunks = await indexChunks(
      ctx.qdrant,
      ctx.embeddings,
      ctx.collections,
      pending.map((entry) => entry.chunk),
    );
    // Mark after a successful index. A later run retries any document whose
    // index failed (or was skipped) instead of reporting it as complete.
    await ctx.db
      .update(documents)
      .set({
        metadata: sql`${documents.metadata} || '{"indexed": true}'::jsonb`,
      })
      .where(inArray(documents.id, documentIds));
  }

  return result;
}

export function filingDocumentId(
  item: Pick<FilingItem, "source" | "externalId" | "url">,
  companyId = "",
  canonicalUrl = canonicalizeUrl(item.url),
): string {
  const key = `${companyId}|${item.source}|${item.externalId}|${canonicalUrl}`;
  return `doc_filing_${sha256Text(key).slice(0, 24)}`;
}

function buildPageChunks(
  pages: FilingContentPage[],
  maxChunks: number,
): {
  chunks: Array<{
    ordinal: number;
    page: number | null;
    section: string;
    text: string;
  }>;
  linkOnly: boolean;
  truncated: boolean;
} {
  const out: Array<{
    ordinal: number;
    page: number | null;
    section: string;
    text: string;
  }> = [];
  let truncated = false;
  for (const page of pages) {
    const text = pageText(page);
    if (!text) continue;
    const pieces = chunkText(text);
    for (const piece of pieces) {
      if (out.length >= maxChunks) {
        truncated = true;
        return { chunks: out, linkOnly: false, truncated };
      }
      out.push({
        ordinal: out.length,
        page: page.page,
        section: `文件第 ${page.page} 页`,
        text: piece,
      });
    }
  }
  return { chunks: out, linkOnly: out.length === 0, truncated };
}

function pageText(page: FilingContentPage): string {
  return pdfPageText({
    page: page.page,
    text: page.text,
    tables: page.tables ?? [],
  }).replace(/\u0000/g, "");
}

function linkOnlyText(item: FilingItem): string {
  return [
    item.title,
    item.category ? `分类：${item.category}` : "",
    item.form ? `类型：${item.form}` : "",
    `来源：${item.url}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function domainOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** Counts for `occ filings coverage`; no new table. */
export async function filingCoverage(
  db: IngestContext["db"],
  options: { limit?: number } = {},
): Promise<
  Array<{
    source: string;
    market: string | null;
    documents: number;
    chunks: number;
    linkOnly: number;
    latest: string | null;
  }>
> {
  const rows = await db
    .select({
      source: sql<string>`coalesce(${documents.metadata}->>'source', 'unknown')`,
      market: sql<string | null>`${documents.metadata}->>'market'`,
      documents: sql<number>`count(distinct ${documents.id})::int`,
      chunks: sql<number>`count(${chunks.id})::int`,
      linkOnly: sql<number>`count(distinct ${documents.id}) filter (where (${documents.metadata}->>'linkOnly')::boolean is true)::int`,
      latest: sql<string | null>`max(${documents.publishedAt})::text`,
    })
    .from(documents)
    .leftJoin(chunks, eq(chunks.documentId, documents.id))
    .where(eq(documents.docType, "filing"))
    .groupBy(
      sql`coalesce(${documents.metadata}->>'source', 'unknown')`,
      sql`${documents.metadata}->>'market'`,
    )
    .orderBy(sql`count(distinct ${documents.id}) desc`)
    .limit(options.limit ?? 100);
  return rows;
}

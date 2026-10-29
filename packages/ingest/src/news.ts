import { chunks, documents, sources } from "@occ/db";
import {
  ensureCollections,
  indexChunks,
  toPointId,
  type IndexableChunk,
} from "@occ/retrieval";
import type { NewsArticle } from "@occ/sources-news";
import { eq, sql } from "drizzle-orm";

import { sha256Text, type IngestContext } from "./ingest.js";
import { estimateTokens } from "./sections.js";

export interface IngestNewsOptions {
  companyId: string;
  companyName: string;
  articles: NewsArticle[];
  market?: string;
  language?: string;
  /** Search query used for the feed, stored for audit. */
  query?: string;
  now?: Date;
  force?: boolean;
}

export interface NewsIngestResult {
  companyId: string;
  articles: number;
  inserted: number;
  updated: number;
  skipped: number;
  chunks: number;
  indexedChunks: number;
}

interface PendingChunk {
  documentId: string;
  chunk: IndexableChunk;
}

/**
 * Store Google News RSS items as `news` documents: one source row, one
 * document, one chunk per article. Idempotent by the title+snippet hash, so a
 * repeated fetch with unchanged items makes no embedding call.
 *
 * Link-only policy: we keep the headline, publisher, date and feed snippet and
 * always link to the original URL. Article bodies are not fetched.
 */
export async function ingestNews(
  ctx: IngestContext,
  options: IngestNewsOptions,
): Promise<NewsIngestResult> {
  const now = options.now ?? new Date();
  const language = options.language ?? "en";
  const pending: PendingChunk[] = [];
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const article of options.articles) {
    const urlHash = sha256Text(article.url).slice(0, 24);
    const sourceId = `src_news_${urlHash}`;
    const documentId = `doc_news_${urlHash}`;
    const text = newsText(article);
    if (!text) continue;
    const textSha = sha256Text(text);
    const publishedAt = article.publishedAt
      ? new Date(article.publishedAt)
      : null;

    const changed = await ctx.db.transaction(async (tx) => {
      await tx
        .insert(sources)
        .values({
          id: sourceId,
          url: article.url,
          canonicalUrl: article.url,
          domain: domainOf(article.url),
          title: article.publisher ?? article.title,
          fetchedAt: now,
          httpStatus: 200,
          contentHash: textSha,
          trustTier: "news",
          license: "link-only",
          robotsOk: true,
        })
        .onConflictDoUpdate({
          target: sources.id,
          set: {
            url: article.url,
            canonicalUrl: article.url,
            domain: domainOf(article.url),
            title: article.publisher ?? article.title,
            fetchedAt: now,
            contentHash: textSha,
            trustTier: "news",
          },
        });

      const existing = await tx
        .select({ sha256: documents.sha256 })
        .from(documents)
        .where(eq(documents.id, documentId))
        .limit(1);

      if (!options.force && existing[0]?.sha256 === textSha) {
        const count = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(chunks)
          .where(eq(chunks.documentId, documentId));
        if ((count[0]?.count ?? 0) === 1) return "skipped" as const;
      }

      const metadata = {
        source: "google-news-rss",
        query: options.query ?? null,
        publisher: article.publisher ?? null,
        articleUrl: article.url,
        companyName: options.companyName,
      };

      await tx
        .insert(documents)
        .values({
          id: documentId,
          sourceId,
          companyId: options.companyId,
          docType: "news",
          mime: "text/plain",
          storageKey: null,
          sha256: textSha,
          language,
          pageCount: null,
          extractorVersion: "news-rss-v1",
          title: article.title,
          publishedAt,
          isFixture: false,
          metadata,
        })
        .onConflictDoUpdate({
          target: documents.id,
          set: {
            sourceId,
            companyId: options.companyId,
            docType: "news",
            mime: "text/plain",
            sha256: textSha,
            language,
            extractorVersion: "news-rss-v1",
            title: article.title,
            publishedAt,
            isFixture: false,
            metadata,
          },
        });

      await tx.delete(chunks).where(eq(chunks.documentId, documentId));
      const chunkId = `${documentId}_c0`;
      await tx.insert(chunks).values({
        id: chunkId,
        documentId,
        companyId: options.companyId,
        ordinal: 0,
        page: null,
        section: "新闻摘要",
        text,
        tokenCount: estimateTokens(text),
        qdrantPointId: toPointId(chunkId),
        embeddingVersion: ctx.embeddingVersion,
      });

      pending.push({
        documentId,
        chunk: {
          id: chunkId,
          documentId,
          companyId: options.companyId,
          text,
          title: article.title,
          docType: "news",
          market: options.market ?? null,
          lang: language,
          sourceUrl: article.url,
          page: null,
          section: "新闻摘要",
          publishedAt: article.publishedAt ?? now.toISOString(),
          isFixture: false,
        },
      });

      return existing[0] ? ("updated" as const) : ("inserted" as const);
    });

    if (changed === "skipped") skipped += 1;
    else if (changed === "updated") updated += 1;
    else inserted += 1;
  }

  if (pending.length === 0 || ctx.skipIndex) {
    return {
      companyId: options.companyId,
      articles: options.articles.length,
      inserted,
      updated,
      skipped,
      chunks: pending.length,
      indexedChunks: 0,
    };
  }

  await ensureCollections(ctx.qdrant, ctx.collections, ctx.embeddingDim);
  for (const documentId of new Set(pending.map((entry) => entry.documentId))) {
    await ctx.qdrant.deleteByFilter(ctx.collections.documents, {
      must: [{ key: "document_id", match: { value: documentId } }],
    });
  }
  const indexedChunks = await indexChunks(
    ctx.qdrant,
    ctx.embeddings,
    ctx.collections,
    pending.map((entry) => entry.chunk),
  );

  return {
    companyId: options.companyId,
    articles: options.articles.length,
    inserted,
    updated,
    skipped,
    chunks: pending.length,
    indexedChunks,
  };
}

export function newsText(article: NewsArticle): string {
  const parts = [article.title.trim(), (article.summary ?? "").trim()].filter(
    Boolean,
  );
  return parts.join("\n\n");
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "news.google.com";
  }
}

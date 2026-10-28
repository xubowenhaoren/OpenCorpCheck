import { eq, inArray } from "drizzle-orm";

import type { Db } from "../client.js";
import { chunks, companies, documents, sources } from "../schema.js";

export interface ChunkWithSource {
  chunkId: string;
  documentId: string;
  companyId: string | null;
  companyDisplayName: string | null;
  text: string;
  ordinal: number;
  page: number | null;
  section: string | null;
  title: string | null;
  docType: string | null;
  lang: string | null;
  publishedAt: Date | null;
  sourceId: string | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
  fetchedAt: Date | null;
}

export async function getChunksWithSources(
  db: Db,
  chunkIds: string[],
): Promise<Map<string, ChunkWithSource>> {
  const unique = [...new Set(chunkIds)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({
      chunkId: chunks.id,
      documentId: chunks.documentId,
      companyId: chunks.companyId,
      companyDisplayName: companies.displayName,
      text: chunks.text,
      ordinal: chunks.ordinal,
      page: chunks.page,
      section: chunks.section,
      title: documents.title,
      docType: documents.docType,
      lang: documents.language,
      publishedAt: documents.publishedAt,
      sourceId: sources.id,
      sourceUrl: sources.url,
      sourceTitle: sources.title,
      fetchedAt: sources.fetchedAt,
    })
    .from(chunks)
    .innerJoin(documents, eq(chunks.documentId, documents.id))
    .leftJoin(companies, eq(chunks.companyId, companies.id))
    .leftJoin(sources, eq(documents.sourceId, sources.id))
    .where(inArray(chunks.id, unique));

  return new Map(rows.map((row) => [row.chunkId, row]));
}

import type { EmbeddingClient } from "./embedding.js";
import type { QdrantClient, QdrantPoint } from "./qdrant.js";
import { toPointId } from "./qdrant.js";
import { encodeSparse } from "./sparse.js";

export interface RetrievalCollections {
  companies: string;
  documents: string;
}

export const DEFAULT_COLLECTIONS: RetrievalCollections = {
  companies: "occ_companies",
  documents: "occ_documents",
};

export interface IndexableCompany {
  id: string;
  slug: string;
  displayName: string;
  legalName: string;
  aliases: string[];
  description?: string | null;
  sector?: string | null;
  country?: string | null;
  coverageTier: string;
  tickers: string[];
  markets: string[];
  indices: string[];
  marketCapBucket?: string | null;
  /** Titles/snippets of the company's documents, for company-level recall. */
  documentText?: string | null;
  updatedAt?: string | null;
}

export interface IndexableChunk {
  id: string;
  documentId: string;
  companyId: string;
  text: string;
  title?: string | null;
  docType?: string | null;
  market?: string | null;
  lang?: string | null;
  sourceUrl?: string | null;
  page?: number | null;
  section?: string | null;
  publishedAt?: string | null;
}

export async function ensureCollections(
  qdrant: QdrantClient,
  collections: RetrievalCollections,
  denseDim: number,
): Promise<void> {
  await qdrant.createCollection(collections.companies, { denseDim });
  await qdrant.createCollection(collections.documents, { denseDim });
}

export function companyIndexText(company: IndexableCompany): string {
  return [
    company.displayName,
    company.legalName,
    ...company.aliases,
    company.description,
    company.sector,
    company.documentText,
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join("\n");
}

export function chunkIndexText(chunk: IndexableChunk): string {
  return [chunk.title, chunk.section, chunk.text]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join("\n");
}

export async function indexCompanies(
  qdrant: QdrantClient,
  embeddings: EmbeddingClient,
  collections: RetrievalCollections,
  companies: IndexableCompany[],
): Promise<number> {
  if (companies.length === 0) return 0;
  const texts = companies.map(companyIndexText);
  const dense = await embeddings.embed(texts);
  const points: QdrantPoint[] = companies.map((company, index) => ({
    id: toPointId(company.id),
    vector: {
      dense: dense[index],
      sparse: encodeSparse(texts[index]),
    },
    payload: {
      company_id: company.id,
      slug: company.slug,
      display_name: company.displayName,
      legal_name: company.legalName,
      aliases: company.aliases,
      description: company.description ?? null,
      sector: company.sector ?? null,
      country: company.country ?? null,
      coverage_tier: company.coverageTier,
      tickers: company.tickers,
      markets: company.markets,
      indices: company.indices,
      market_cap_bucket: company.marketCapBucket ?? null,
      updated_at: company.updatedAt ?? new Date().toISOString(),
      embedding_version: embeddings.version,
    },
  }));
  await qdrant.upsert(collections.companies, points);
  return points.length;
}

export async function indexChunks(
  qdrant: QdrantClient,
  embeddings: EmbeddingClient,
  collections: RetrievalCollections,
  chunks: IndexableChunk[],
): Promise<number> {
  if (chunks.length === 0) return 0;
  const texts = chunks.map(chunkIndexText);
  const dense = await embeddings.embed(texts);
  const points: QdrantPoint[] = chunks.map((chunk, index) => ({
    id: toPointId(chunk.id),
    vector: {
      dense: dense[index],
      sparse: encodeSparse(texts[index]),
    },
    payload: {
      chunk_id: chunk.id,
      document_id: chunk.documentId,
      company_id: chunk.companyId,
      title: chunk.title ?? null,
      doc_type: chunk.docType ?? null,
      market: chunk.market ?? null,
      lang: chunk.lang ?? null,
      source_url: chunk.sourceUrl ?? null,
      page: chunk.page ?? null,
      section: chunk.section ?? null,
      published_at: chunk.publishedAt ?? null,
      text: chunk.text,
      embedding_version: embeddings.version,
    },
  }));
  await qdrant.upsert(collections.documents, points);
  return points.length;
}

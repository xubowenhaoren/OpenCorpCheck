import { z } from "zod";

export const MarketSchema = z.enum(["A", "HK", "US"]);
export type Market = z.infer<typeof MarketSchema>;

export const CoverageTierSchema = z.enum([
  "index_member",
  "ai_watchlist",
  "discovered",
  "stub",
]);
export type CoverageTier = z.infer<typeof CoverageTierSchema>;

export const SearchModeSchema = z.enum(["hybrid", "keyword", "semantic"]);
export type SearchMode = z.infer<typeof SearchModeSchema>;

export const MatchTypeSchema = z.enum([
  "identifier",
  "alias",
  "fuzzy",
  "hybrid",
  "keyword",
  "semantic",
]);
export type MatchType = z.infer<typeof MatchTypeSchema>;

/** Query-string boolean: "true"/"1" → true, "false"/"0"/"" → false. */
const queryBoolean = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  return value === "true" || value === "1";
}, z.boolean());

export const SearchCompaniesQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  mode: SearchModeSchema.default("hybrid"),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  market: z.string().trim().optional(),
  index: z.string().trim().optional(),
  coverage: CoverageTierSchema.optional(),
  /** Include the synthetic development corpus (default: hidden). */
  include_fixtures: queryBoolean.default(false),
  explain: queryBoolean.default(false),
  rerank: queryBoolean.optional(),
});
export type SearchCompaniesQuery = z.infer<typeof SearchCompaniesQuerySchema>;

export const SearchDocumentsQuerySchema = z.object({
  q: z.string().trim().min(1).max(400),
  mode: SearchModeSchema.default("hybrid"),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  company_id: z.string().trim().optional(),
  doc_type: z.string().trim().optional(),
  lang: z.string().trim().optional(),
  /** Include the synthetic development corpus (default: hidden). */
  include_fixtures: queryBoolean.default(false),
  explain: queryBoolean.default(false),
  rerank: queryBoolean.optional(),
});
export type SearchDocumentsQuery = z.infer<typeof SearchDocumentsQuerySchema>;

export interface Citation {
  url: string;
  title?: string;
  retrievedAt?: string;
  source?: string;
}

export interface BranchExplain {
  sparseRank?: number;
  sparseScore?: number;
  denseRank?: number;
  denseScore?: number;
  fusedScore: number;
  rerankScore?: number;
  matchedTerms?: string[];
}

export interface SearchExplain {
  normalizedQuery: string;
  tokens: string[];
  branches: {
    bm25: Array<{ id: string; rank: number; score: number }>;
    dense: Array<{ id: string; rank: number; score: number }>;
  };
  fusion: { method: "rrf" | "dbsf"; k?: number; score: number; id: string }[];
  rerank?: Array<{ id: string; before: number; after: number; score: number }>;
  timings: { plannerMs: number; qdrantMs: number; rerankMs: number };
}

export interface CompanyTicker {
  ticker: string;
  exchange: string;
  currency?: string;
}

export interface CompanyHit {
  id: string;
  slug: string;
  legalName: string;
  displayName: string;
  country?: string;
  website?: string;
  coverageTier: CoverageTier;
  /** Only present when the caller opted into `include_fixtures`. */
  isFixture?: boolean;
  description?: string;
  sector?: string;
  marketCapBucket?: string;
  aliases: string[];
  tickers: CompanyTicker[];
  indices: string[];
  markets: Market[];
  matchType: MatchType;
  score: number;
  explain?: BranchExplain;
}

export interface DocumentHit {
  chunkId: string;
  documentId: string;
  companyId: string;
  companyDisplayName?: string;
  isFixture?: boolean;
  text: string;
  title?: string;
  docType?: string;
  lang?: string;
  page?: number;
  section?: string;
  source?: Citation;
  matchType: MatchType;
  score: number;
  explain?: BranchExplain;
}

export interface SearchMeta {
  request_id: string;
  as_of: string;
  took_ms: number;
  query: string;
  normalized_query: string;
  mode: SearchMode;
  total: number;
  embedding_version?: string;
  fusion?: "rrf" | "dbsf";
  rerank: boolean;
  citations: Citation[];
}

export interface SearchResponse<T> {
  data: { hits: T[]; explain?: SearchExplain };
  meta: SearchMeta;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    traceId?: string;
  };
}

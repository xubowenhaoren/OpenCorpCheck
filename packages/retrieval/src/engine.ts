import type { SearchMode } from "@occ/core";

import type { EmbeddingClient } from "./embedding.js";
import { fuse, rrfFuse, type FusedItem } from "./fusion.js";
import {
  DEFAULT_COLLECTIONS,
  type RetrievalCollections,
} from "./indexer.js";
import type {
  QdrantClient,
  QdrantFilter,
  QdrantHit,
  QdrantQueryBody,
} from "./qdrant.js";
import { encodeSparse } from "./sparse.js";
import { normalizeText, tokenSet } from "./tokenizer.js";

export interface SearchEngineConfig {
  qdrant: QdrantClient;
  embeddings: EmbeddingClient;
  collections?: RetrievalCollections;
  fusion?: "rrf" | "dbsf";
  rrfK?: number;
  prefetchLimit?: number;
}

export interface EngineRequest {
  q: string;
  mode: SearchMode;
  limit?: number;
  filter?: QdrantFilter;
  explain?: boolean;
}

export interface EngineExplain {
  normalizedQuery: string;
  tokens: string[];
  bm25: QdrantHit[];
  dense: QdrantHit[];
  fused: FusedItem[];
  fusionMethod: "rrf" | "dbsf";
  timings: { qdrantMs: number };
}

export interface EngineResult {
  hits: QdrantHit[];
  explain?: EngineExplain;
}

/**
 * Runs the Qdrant side of a search request. DB hydration and ranking boosts
 * belong to the API layer; this class is deterministic and HTTP-free.
 */
export class SearchEngine {
  private readonly collections: RetrievalCollections;
  private readonly fusion: "rrf" | "dbsf";
  private readonly rrfK: number;
  private readonly prefetchLimit: number;

  constructor(private readonly config: SearchEngineConfig) {
    this.collections = config.collections ?? DEFAULT_COLLECTIONS;
    this.fusion = config.fusion ?? "rrf";
    this.rrfK = config.rrfK ?? 60;
    this.prefetchLimit = config.prefetchLimit ?? 100;
  }

  async searchCompanies(request: EngineRequest): Promise<EngineResult> {
    return this.search(this.collections.companies, request);
  }

  async searchDocuments(request: EngineRequest): Promise<EngineResult> {
    return this.search(this.collections.documents, request);
  }

  async search(collection: string, request: EngineRequest): Promise<EngineResult> {
    const query = request.q.trim();
    const limit = request.limit ?? 10;
    const normalizedQuery = normalizeText(query);
    const tokens = tokenSet(query);
    const sparse = encodeSparse(query);
    const dense = (await this.config.embeddings.embed([query]))[0];

    const started = performance.now();
    const hits = await this.runMode(collection, request.mode, {
      sparse,
      dense,
      limit,
      filter: request.filter,
    });
    const qdrantMs = Math.round(performance.now() - started);

    if (!request.explain) return { hits };

    const [bm25, semantic] = await Promise.all([
      request.mode === "hybrid" || request.mode === "keyword"
        ? this.config.qdrant.query(collection, {
            query: sparse,
            using: "sparse",
            limit: this.prefetchLimit,
            with_payload: true,
            filter: request.filter,
          })
        : Promise.resolve([]),
      request.mode === "hybrid" || request.mode === "semantic"
        ? this.config.qdrant.query(collection, {
            query: dense,
            using: "dense",
            limit: this.prefetchLimit,
            with_payload: true,
            filter: request.filter,
          })
        : Promise.resolve([]),
    ]);

    const fused = fuse(
      [
        bm25.map((hit) => ({ id: hit.id, score: hit.score })),
        semantic.map((hit) => ({ id: hit.id, score: hit.score })),
      ],
      this.fusion,
      this.rrfK,
    ).slice(0, this.prefetchLimit);

    return {
      hits,
      explain: {
        normalizedQuery,
        tokens,
        bm25: bm25.slice(0, 20),
        dense: semantic.slice(0, 20),
        fused,
        fusionMethod: this.fusion,
        timings: { qdrantMs },
      },
    };
  }

  private async runMode(
    collection: string,
    mode: SearchMode,
    input: {
      sparse: ReturnType<typeof encodeSparse>;
      dense: number[];
      limit: number;
      filter?: QdrantFilter;
    },
  ): Promise<QdrantHit[]> {
    if (mode === "keyword") {
      return this.config.qdrant.query(collection, {
        query: input.sparse,
        using: "sparse",
        limit: input.limit,
        with_payload: true,
        filter: input.filter,
      });
    }
    if (mode === "semantic") {
      return this.config.qdrant.query(collection, {
        query: input.dense,
        using: "dense",
        limit: input.limit,
        with_payload: true,
        filter: input.filter,
      });
    }
    const body: QdrantQueryBody = {
      prefetch: [
        {
          query: input.sparse,
          using: "sparse",
          limit: this.prefetchLimit,
        },
        {
          query: input.dense,
          using: "dense",
          limit: this.prefetchLimit,
        },
      ],
      query: { fusion: this.fusion },
      limit: input.limit,
      with_payload: true,
      filter: input.filter,
    };
    return this.config.qdrant.query(collection, body);
  }
}

/** Client-side RRF for explain display when the server response is fused. */
export function explainFusion(
  bm25: QdrantHit[],
  dense: QdrantHit[],
  k = 60,
): FusedItem[] {
  return rrfFuse(
    [
      bm25.map((hit) => ({ id: hit.id, score: hit.score })),
      dense.map((hit) => ({ id: hit.id, score: hit.score })),
    ],
    k,
  );
}

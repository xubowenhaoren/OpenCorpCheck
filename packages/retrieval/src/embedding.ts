import { AppError } from "@occ/core";

import { tokenize } from "./tokenizer.js";
import { fnv1a32 } from "./sparse.js";

export interface EmbeddingClient {
  readonly dim: number;
  readonly version: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface HttpEmbeddingOptions {
  baseUrl: string;
  model?: string;
  dim?: number;
  version?: string;
  timeoutMs?: number;
  batchSize?: number;
  retries?: number;
}

/**
 * TEI-compatible embedding client.
 *
 * The local `services/embeddings` sidecar implements the same `/embed`
 * contract as HuggingFace TEI, so production (BGE-M3 via TEI) and development
 * (sentence-transformers on the laptop) share one code path.
 */
export class HttpEmbeddingClient implements EmbeddingClient {
  readonly dim: number;
  readonly version: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly batchSize: number;
  private readonly retries: number;

  constructor(options: HttpEmbeddingOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model ?? "BAAI/bge-m3";
    this.dim = options.dim ?? 1024;
    this.version = options.version ?? `bge-m3@1024`;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.batchSize = options.batchSize ?? 16;
    this.retries = options.retries ?? 1;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let start = 0; start < texts.length; start += this.batchSize) {
      const batch = texts.slice(start, start + this.batchSize);
      const vectors = await this.embedBatch(batch);
      out.push(...vectors);
    }
    return out;
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const response = await fetch(`${this.baseUrl}/embed`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ inputs: texts, model: this.model }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`embedding HTTP ${response.status}: ${body.slice(0, 300)}`);
        }
        const json: unknown = await response.json();
        return parseEmbeddingResponse(json, texts.length, this.dim);
      } catch (error) {
        lastError = error;
        if (attempt < this.retries) {
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        }
      }
    }
    throw new AppError(
      "upstream_error",
      `embedding service failed at ${this.baseUrl}: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }
}

function parseEmbeddingResponse(
  json: unknown,
  expected: number,
  dim: number,
): number[][] {
  let vectors: number[][] | undefined;
  if (Array.isArray(json)) {
    vectors = json as number[][];
  } else if (json && typeof json === "object") {
    const record = json as Record<string, unknown>;
    if (Array.isArray(record.embeddings)) {
      vectors = record.embeddings as number[][];
    } else if (Array.isArray(record.data)) {
      vectors = (record.data as Array<{ embedding: number[] }>).map(
        (item) => item.embedding,
      );
    }
  }
  if (!vectors || vectors.length !== expected) {
    throw new Error(
      `embedding response shape mismatch: expected ${expected} vectors`,
    );
  }
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length !== dim) {
      throw new Error(
        `embedding dimension mismatch: expected ${dim}, got ${vector?.length}`,
      );
    }
  }
  return vectors;
}

/**
 * Deterministic local embedding for unit tests and CI without a model.
 * Not semantically meaningful; never enable it for real search.
 */
export class HashEmbeddingClient implements EmbeddingClient {
  readonly version: string;
  constructor(readonly dim = 64) {
    this.version = `hash@${dim}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => hashEmbed(text, this.dim));
  }
}

export function hashEmbed(text: string, dim: number): number[] {
  const vector = new Array<number>(dim).fill(0);
  const tokens = tokenize(text);
  for (const token of tokens) {
    const index = fnv1a32(`v1:${token}`) % dim;
    const sign = fnv1a32(`s:${token}`) % 2 === 0 ? 1 : -1;
    vector[index] += sign;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return vector;
  return vector.map((value) => Number((value / norm).toFixed(6)));
}

export interface RerankResult {
  index: number;
  score: number;
}

export interface RerankClient {
  readonly enabled: boolean;
  readonly version: string;
  rerank(query: string, documents: string[], topN?: number): Promise<RerankResult[]>;
}

export class HttpRerankClient implements RerankClient {
  readonly enabled = true;
  readonly version: string;
  constructor(
    private readonly baseUrl: string,
    private readonly model = "BAAI/bge-reranker-v2-m3",
    private readonly timeoutMs = 120_000,
  ) {
    this.version = `rerank:${model}`;
  }

  async rerank(
    query: string,
    documents: string[],
    topN?: number,
  ): Promise<RerankResult[]> {
    if (documents.length === 0) return [];
    const response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/rerank`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query,
        documents,
        top_n: topN ?? documents.length,
        model: this.model,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new AppError("upstream_error", `rerank HTTP ${response.status}`);
    }
    const json = (await response.json()) as {
      results?: RerankResult[];
      data?: Array<{ index: number; score?: number; relevance_score?: number }>;
    };
    if (Array.isArray(json.results)) return json.results;
    if (Array.isArray(json.data)) {
      return json.data.map((item) => ({
        index: item.index,
        score: item.score ?? item.relevance_score ?? 0,
      }));
    }
    throw new AppError("upstream_error", "unexpected rerank response");
  }
}

export class NoopRerankClient implements RerankClient {
  readonly enabled = false;
  readonly version = "disabled";
  async rerank(): Promise<RerankResult[]> {
    return [];
  }
}

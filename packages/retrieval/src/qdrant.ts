import { createHash } from "node:crypto";

import { AppError } from "@occ/core";

import type { SparseVector } from "./sparse.js";

export interface QdrantConfig {
  url: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface QdrantPoint {
  id: string;
  vector: { dense: number[]; sparse: SparseVector };
  payload: Record<string, unknown>;
}

export interface QdrantMatch {
  value?: string | number | boolean;
  any?: Array<string | number | boolean>;
  except?: Array<string | number | boolean>;
}

export interface QdrantCondition {
  key: string;
  match?: QdrantMatch;
  range?: Record<string, number>;
}

export interface QdrantFilter {
  must?: QdrantCondition[];
  should?: QdrantCondition[];
  must_not?: QdrantCondition[];
}

export interface QdrantQueryBody {
  prefetch?: Array<Record<string, unknown>>;
  query?: unknown;
  using?: string;
  limit?: number;
  offset?: number;
  with_payload?: boolean;
  with_vector?: boolean;
  filter?: QdrantFilter;
  score_threshold?: number;
}

export interface QdrantHit {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

export class QdrantClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(config: QdrantConfig) {
    this.baseUrl = config.url.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  async health(): Promise<boolean> {
    try {
      const response = await this.request("/readyz", { method: "GET" }, 3_000);
      return response.ok;
    } catch {
      return false;
    }
  }

  async collectionExists(name: string): Promise<boolean> {
    const response = await this.request(
      `/collections/${encodeURIComponent(name)}`,
      { method: "GET" },
    );
    if (response.status === 404) return false;
    if (!response.ok) await this.fail(response, "collection info");
    return true;
  }

  async createCollection(
    name: string,
    options: { denseDim: number },
  ): Promise<void> {
    if (await this.collectionExists(name)) return;
    const response = await this.request(
      `/collections/${encodeURIComponent(name)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          vectors: {
            dense: { size: options.denseDim, distance: "Cosine" },
          },
          sparse_vectors: {
            sparse: { modifier: "idf" },
          },
        }),
      },
    );
    if (!response.ok) await this.fail(response, "create collection");
  }

  async deleteCollection(name: string): Promise<void> {
    const response = await this.request(
      `/collections/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
    if (!response.ok && response.status !== 404) {
      await this.fail(response, "delete collection");
    }
  }

  async upsert(
    name: string,
    points: QdrantPoint[],
    wait = true,
  ): Promise<void> {
    if (points.length === 0) return;
    const response = await this.request(
      `/collections/${encodeURIComponent(name)}/points?wait=${wait ? "true" : "false"}`,
      {
        method: "PUT",
        body: JSON.stringify({ points }),
      },
      60_000,
    );
    if (!response.ok) await this.fail(response, "upsert points");
  }

  async query(name: string, body: QdrantQueryBody): Promise<QdrantHit[]> {
    const response = await this.request(
      `/collections/${encodeURIComponent(name)}/points/query`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) await this.fail(response, "query points");
    const json = (await response.json()) as {
      result?: { points?: QdrantHit[] } | QdrantHit[];
    };
    const result = json.result;
    const points = Array.isArray(result) ? result : (result?.points ?? []);
    return points.map((point) => ({
      id: String(point.id),
      score: Number(point.score ?? 0),
      payload: point.payload ?? {},
    }));
  }

  async count(name: string): Promise<number> {
    const response = await this.request(
      `/collections/${encodeURIComponent(name)}/points/count`,
      {
        method: "POST",
        body: JSON.stringify({ exact: true }),
      },
    );
    if (!response.ok) await this.fail(response, "count points");
    const json = (await response.json()) as {
      result?: { count?: number };
    };
    return Number(json.result?.count ?? 0);
  }

  /** Delete points matching a payload filter (e.g. one document's chunks). */
  async deleteByFilter(name: string, filter: QdrantFilter): Promise<void> {
    const response = await this.request(
      `/collections/${encodeURIComponent(name)}/points/delete?wait=true`,
      {
        method: "POST",
        body: JSON.stringify({ filter }),
      },
      60_000,
    );
    if (!response.ok) await this.fail(response, "delete points");
  }

  private async request(
    path: string,
    init: RequestInit,
    timeoutMs = this.timeoutMs,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    };
    if (this.apiKey) headers["api-key"] = this.apiKey;
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  private async fail(response: Response, action: string): Promise<never> {
    const body = await response.text().catch(() => "");
    throw new AppError(
      "upstream_error",
      `qdrant ${action} failed (${response.status}): ${body.slice(0, 400)}`,
    );
  }
}

/**
 * Qdrant point ids must be UUIDs or unsigned integers. Our entities use
 * ULIDs, so derive a stable UUID v5-shaped id from the entity id.
 */
export function toPointId(id: string): string {
  const hex = createHash("sha1").update(`occ:${id}`).digest("hex");
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

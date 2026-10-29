import {
  AppError,
  CompanyCardQuerySchema,
  ReviewProposalSchema,
  ReviewQueueQuerySchema,
  SearchCompaniesQuerySchema,
  SearchDocumentsQuerySchema,
  toAppError,
  type CompanyCardResponse,
  type CompanyHit,
  type DocumentHit,
  type SearchResponse,
} from "@occ/core";
import { Hono } from "hono";

import { config } from "./config.js";
import { openApiDocument } from "./openapi.js";
import type { CompanyService } from "./services/company.js";
import type { ReviewService } from "./services/review.js";
import type { SearchService } from "./services/search.js";

export interface HealthReport {
  ok: boolean;
  database: { ok: boolean; error?: string };
  qdrant: { ok: boolean };
  embeddings: { ok: boolean; model?: string; loaded?: boolean; error?: string };
}

export interface AppDeps {
  search: SearchService;
  company: CompanyService;
  review: ReviewService;
  health: () => Promise<HealthReport>;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/v1/health", async (c) => {
    const report = await deps.health();
    return c.json(report, report.ok ? 200 : 503);
  });

  app.get("/v1/search/companies", async (c) => {
    const parsed = SearchCompaniesQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    if (!parsed.success) throw badRequest(parsed.error.issues);
    const requestId = crypto.randomUUID();
    const started = performance.now();
    const result = await deps.search.searchCompanies(parsed.data);
    const tookMs = Math.round(performance.now() - started);
    const body: SearchResponse<CompanyHit> = {
      data: {
        hits: result.hits,
        ...(result.explain ? { explain: result.explain } : {}),
      },
      meta: meta(requestId, parsed.data.q, parsed.data.mode, result, tookMs),
    };
    c.header("x-request-id", requestId);
    return c.json(body);
  });

  app.get("/v1/search/documents", async (c) => {
    const parsed = SearchDocumentsQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    if (!parsed.success) throw badRequest(parsed.error.issues);
    const requestId = crypto.randomUUID();
    const started = performance.now();
    const result = await deps.search.searchDocuments(parsed.data);
    const tookMs = Math.round(performance.now() - started);
    const body: SearchResponse<DocumentHit> = {
      data: {
        hits: result.hits,
        ...(result.explain ? { explain: result.explain } : {}),
      },
      meta: meta(requestId, parsed.data.q, parsed.data.mode, result, tookMs),
    };
    c.header("x-request-id", requestId);
    return c.json(body);
  });

  app.get("/v1/companies/:id", async (c) => {
    const parsed = CompanyCardQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    if (!parsed.success) throw badRequest(parsed.error.issues);
    const requestId = crypto.randomUUID();
    const started = performance.now();
    const card = await deps.company.getCard(c.req.param("id"), parsed.data);
    const body: CompanyCardResponse = {
      data: card,
      meta: {
        request_id: requestId,
        as_of: new Date().toISOString(),
        took_ms: Math.round(performance.now() - started),
        company_ref: c.req.param("id"),
        include:
          parsed.data.include ?? ["financials", "facts", "relations", "events"],
      },
    };
    c.header("x-request-id", requestId);
    return c.json(body);
  });

  app.post("/v1/review/proposals", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new AppError("bad_request", "invalid JSON body");
    }
    const parsed = ReviewProposalSchema.safeParse(raw);
    if (!parsed.success) throw badRequest(parsed.error.issues);
    const requestId = crypto.randomUUID();
    const result = await deps.review.createProposal(parsed.data);
    c.header("x-request-id", requestId);
    return c.json(
      {
        data: result.item,
        meta: {
          request_id: requestId,
          as_of: new Date().toISOString(),
          created: result.created,
        },
      },
      result.created ? 201 : 200,
    );
  });

  app.get("/v1/review/queue", async (c) => {
    const parsed = ReviewQueueQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    if (!parsed.success) throw badRequest(parsed.error.issues);
    const requestId = crypto.randomUUID();
    const result = await deps.review.list(parsed.data);
    c.header("x-request-id", requestId);
    return c.json({
      data: { items: result.items, total: result.total },
      meta: {
        request_id: requestId,
        as_of: new Date().toISOString(),
        total: result.total,
      },
    });
  });

  app.get("/openapi.json", (c) => c.json(openApiDocument()));

  app.notFound((c) =>
    c.json(
      { error: { code: "not_found", message: `no route ${c.req.path}` } },
      404,
    ),
  );

  app.onError((error, c) => {
    const appError = toAppError(error);
    const traceId = c.req.header("x-request-id") ?? crypto.randomUUID();
    return new Response(
      JSON.stringify({
        error: {
          code: appError.code,
          message: appError.message,
          ...(appError.details ? { details: appError.details } : {}),
          traceId,
        },
      }),
      {
        status: appError.status,
        headers: {
          "content-type": "application/json",
          "x-request-id": traceId,
        },
      },
    );
  });

  return app;
}

function meta(
  requestId: string,
  query: string,
  mode: "hybrid" | "keyword" | "semantic",
  result: {
    hits: unknown[];
    citations: Array<{ url: string }>;
    normalizedQuery: string;
    rerank: boolean;
  },
  tookMs: number,
) {
  return {
    request_id: requestId,
    as_of: new Date().toISOString(),
    took_ms: tookMs,
    query,
    normalized_query: result.normalizedQuery,
    mode,
    total: result.hits.length,
    embedding_version: config.embeddingVersion,
    fusion: config.fusion,
    rerank: result.rerank,
    citations: result.citations,
  };
}

function badRequest(
  issues: Array<{ path: readonly PropertyKey[]; message: string }>,
): AppError {
  return new AppError(
    "bad_request",
    issues
      .map(
        (issue) =>
          `${issue.path.map((part) => String(part)).join(".") || "query"}: ${issue.message}`,
      )
      .join("; "),
    issues,
  );
}

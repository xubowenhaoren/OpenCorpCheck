import {
  AppError,
  CompanyCardQuerySchema,
  ResearchRequestSchema,
  ResearchRunQuerySchema,
  ReviewBatchDecisionSchema,
  ReviewDecisionSchema,
  ReviewProposalSchema,
  ReviewQueueQuerySchema,
  SearchCompaniesQuerySchema,
  SearchDocumentsQuerySchema,
  toAppError,
  type CompanyCardResponse,
  type CompanyHit,
  type DocumentHit,
  type EnqueueResearchView,
  type SearchResponse,
} from "@occ/core";
import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

import { agentUiHtml } from "./agent-ui.js";
import { config } from "./config.js";
import { openApiDocument } from "./openapi.js";
import { reviewUiHtml } from "./review-ui.js";
import type { AgentService } from "./services/agent.js";
import type { CompanyService } from "./services/company.js";
import type { ResearchService } from "./services/research.js";
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
  research: ResearchService;
  review: ReviewService;
  agent: AgentService;
  health: () => Promise<HealthReport>;
}

const AgentPromptSchema = z.object({
  message: z.string().trim().min(1).max(8_000),
});

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

  app.post("/v1/research", async (c) => {
    const parsed = ResearchRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) throw badRequest(parsed.error.issues);
    const requestId = crypto.randomUUID();
    const started = performance.now();
    const result = await deps.research.enqueue(parsed.data);
    c.header("x-request-id", requestId);
    const body: {
      data: EnqueueResearchView;
      meta: { request_id: string; as_of: string; took_ms: number };
    } = {
      data: result,
      meta: {
        request_id: requestId,
        as_of: new Date().toISOString(),
        took_ms: Math.round(performance.now() - started),
      },
    };
    return c.json(body, 202);
  });

  app.get("/v1/runs", async (c) => {
    const parsed = ResearchRunQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    if (!parsed.success) throw badRequest(parsed.error.issues);
    const requestId = crypto.randomUUID();
    const started = performance.now();
    const runs = await deps.research.listRuns(parsed.data.limit);
    c.header("x-request-id", requestId);
    return c.json({
      data: { runs },
      meta: {
        request_id: requestId,
        as_of: new Date().toISOString(),
        took_ms: Math.round(performance.now() - started),
      },
    });
  });

  app.get("/v1/runs/:id", async (c) => {
    const requestId = crypto.randomUUID();
    const started = performance.now();
    const run = await deps.research.getRun(c.req.param("id"));
    c.header("x-request-id", requestId);
    return c.json({
      data: run,
      meta: {
        request_id: requestId,
        as_of: new Date().toISOString(),
        took_ms: Math.round(performance.now() - started),
      },
    });
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

  app.post("/v1/review/items/:id/decision", async (c) => {
    const parsed = ReviewDecisionSchema.safeParse(await jsonBody(c));
    if (!parsed.success) throw badRequest(parsed.error.issues);
    const requestId = crypto.randomUUID();
    const result = await deps.review.decide(
      c.req.param("id"),
      parsed.data,
    );
    c.header("x-request-id", requestId);
    return c.json({
      data: result,
      meta: {
        request_id: requestId,
        as_of: new Date().toISOString(),
        updated: result.updated,
      },
    });
  });

  app.post("/v1/review/batch", async (c) => {
    const parsed = ReviewBatchDecisionSchema.safeParse(await jsonBody(c));
    if (!parsed.success) throw badRequest(parsed.error.issues);
    const requestId = crypto.randomUUID();
    const result = await deps.review.decideBatch(parsed.data);
    c.header("x-request-id", requestId);
    return c.json({
      data: result,
      meta: {
        request_id: requestId,
        as_of: new Date().toISOString(),
        decision: parsed.data.decision,
        updated: result.updated,
        skipped: result.skipped,
      },
    });
  });

  app.post("/v1/agent/sessions", async (c) => {
    const requestId = crypto.randomUUID();
    const result = await deps.agent.createSession();
    c.header("x-request-id", requestId);
    return c.json(
      {
        data: result,
        meta: {
          request_id: requestId,
          as_of: new Date().toISOString(),
        },
      },
      201,
    );
  });

  app.post("/v1/agent/sessions/:id/prompt", async (c) => {
    const parsed = AgentPromptSchema.safeParse(await jsonBody(c));
    if (!parsed.success) throw badRequest(parsed.error.issues);
    const sessionId = c.req.param("id");
    const abortSignal = c.req.raw.signal;
    return streamSSE(c, async (stream) => {
      const onAbort = (): void => {
        void deps.agent.cancel(sessionId);
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
      try {
        for await (const event of deps.agent.prompt(sessionId, parsed.data.message)) {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          });
        }
      } catch (error) {
        const message =
          error instanceof AppError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        await stream.writeSSE({
          event: "run.failed",
          data: JSON.stringify({ type: "run.failed", error: message }),
        });
      } finally {
        abortSignal.removeEventListener("abort", onAbort);
      }
    });
  });

  app.post("/v1/agent/sessions/:id/cancel", async (c) => {
    await deps.agent.cancel(c.req.param("id"));
    return c.json({ data: { cancelled: true } });
  });

  app.get("/v1/agent/ui", (c) => c.html(agentUiHtml()));

  // Minimal, dependency-free review console for local use. It calls the JSON
  // endpoints above; no build step and no external assets.
  app.get("/v1/review/ui", (c) => c.html(reviewUiHtml()));

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

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError("bad_request", "invalid JSON body");
  }
}

function badRequest(
  issues: Array<{ path: readonly PropertyKey[]; message: string }>,
): AppError {  return new AppError(
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

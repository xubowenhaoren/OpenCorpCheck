import { config } from "./config.js";

const errorResponse = {
  description: "Error envelope",
  content: {
    "application/json": {
      schema: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            required: ["code", "message"],
            properties: {
              code: { type: "string" },
              message: { type: "string" },
              details: {},
              traceId: { type: "string" },
            },
          },
        },
      },
    },
  },
};

const searchCommonParameters = [
  {
    name: "q",
    in: "query",
    required: true,
    schema: { type: "string", minLength: 1 },
    description: "Natural language, company name, alias, ticker, or identifier.",
  },
  {
    name: "mode",
    in: "query",
    schema: { type: "string", enum: ["hybrid", "keyword", "semantic"], default: "hybrid" },
  },
  {
    name: "limit",
    in: "query",
    schema: { type: "integer", minimum: 1, maximum: 50, default: 10 },
  },
  {
    name: "explain",
    in: "query",
    schema: { type: "boolean", default: false },
    description: "Run BM25 and dense branches separately and return rank explanations.",
  },
  {
    name: "include_fixtures",
    in: "query",
    schema: { type: "boolean", default: false },
    description:
      "Include the synthetic development corpus (fixture:// sources). Hidden by default.",
  },
];

export function openApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "OpenCorpCheck Search API",
      version: "0.1.0",
      description:
        "Provenance-first company search: Postgres truth + Qdrant hybrid retrieval (BGE-M3 dense + BM25 sparse, RRF).",
    },
    servers: [{ url: `http://127.0.0.1:${config.apiPort}` }],
    paths: {
      "/v1/health": {
        get: {
          operationId: "health",
          responses: { "200": { description: "Service health" } },
        },
      },
      "/v1/search/companies": {
        get: {
          operationId: "searchCompanies",
          parameters: [
            ...searchCommonParameters,
            {
              name: "market",
              in: "query",
              schema: { type: "string", description: "A, HK, US (comma-separated)" },
            },
            {
              name: "index",
              in: "query",
              schema: { type: "string", description: "Index codes, comma-separated" },
            },
            {
              name: "sector",
              in: "query",
              schema: { type: "string", description: "Exact sector label (e.g. 半导体)" },
            },
            {
              name: "coverage",
              in: "query",
              schema: {
                type: "string",
                enum: ["index_member", "ai_watchlist", "discovered", "stub"],
              },
            },
            {
              name: "rerank",
              in: "query",
              schema: { type: "boolean" },
            },
          ],
          responses: {
            "200": { description: "Company hits with citations and optional explain" },
            "400": errorResponse,
          },
        },
      },
      "/v1/search/documents": {
        get: {
          operationId: "searchDocuments",
          parameters: [
            ...searchCommonParameters,
            { name: "company_id", in: "query", schema: { type: "string" } },
            { name: "doc_type", in: "query", schema: { type: "string" } },
            { name: "lang", in: "query", schema: { type: "string" } },
            { name: "rerank", in: "query", schema: { type: "boolean" } },
          ],
          responses: {
            "200": { description: "Chunk hits with source citations" },
            "400": errorResponse,
          },
        },
      },
      "/v1/companies/{id}": {
        get: {
          operationId: "getCompany",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Internal ULID, slug or ticker (AAPL, 600519, 00700)",
            },
            {
              name: "include",
              in: "query",
              schema: { type: "string" },
              description:
                "Comma-separated: financials,facts,relations,events. Omit for all.",
            },
            {
              name: "financial_limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 200, default: 20 },
            },
            {
              name: "fact_limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 200, default: 30 },
            },
            {
              name: "relation_limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 200, default: 20 },
            },
            {
              name: "event_limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 100, default: 10 },
            },
            {
              name: "relation_status",
              in: "query",
              schema: {
                type: "string",
                enum: ["reported", "inferred", "verified", "rejected"],
              },
            },
          ],
          responses: {
            "200": {
              description:
                "Company card: profile, counts, financials, facts, relations (in/out), events",
            },
            "400": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/v1/graph": {
        get: {
          operationId: "getCompanyGraph",
          parameters: [
            {
              name: "company",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "Company ref (ULID, slug or ticker)",
            },
            {
              name: "depth",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 2, default: 1 },
            },
            {
              name: "status",
              in: "query",
              schema: {
                type: "string",
                enum: ["reported", "inferred", "verified", "rejected"],
              },
            },
            {
              name: "types",
              in: "query",
              schema: {
                type: "string",
                description: "Comma-separated relation types",
              },
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 500, default: 200 },
            },
          ],
          responses: {
            "200": {
              description:
                "Ego network: center, nodes, edges, depth, truncated",
            },
            "400": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/v1/indices/{code}": {
        get: {
          operationId: "getIndex",
          parameters: [
            {
              name: "code",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Index code (currently NDX)",
            },
          ],
          responses: {
            "200": { description: "Index constituents with tickers and as_of" },
            "404": errorResponse,
          },
        },
      },
      "/v1/sectors": {
        get: {
          operationId: "listSectors",
          responses: {
            "200": { description: "Distinct sectors visible in company search" },
          },
        },
      },
      "/v1/research": {
        post: {
          operationId: "enqueueResearch",
          description:
            "Queue one company-profile research job. Asynchronous: poll /v1/runs/{id}.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["company"],
                  properties: {
                    company: {
                      type: "string",
                      description: "Internal ULID, slug or ticker",
                    },
                    focus: { type: "string", maxLength: 500 },
                    include_f10: { type: "boolean", default: false },
                    force: { type: "boolean", default: false },
                  },
                },
              },
            },
          },
          responses: {
            "202": { description: "Run queued; returns runId and jobKey" },
            "400": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/v1/runs": {
        get: {
          operationId: "listRuns",
          parameters: [
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            },
          ],
          responses: { "200": { description: "Recent research/F10/news runs" } },
        },
      },
      "/v1/runs/{id}": {
        get: {
          operationId: "getRun",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": { description: "Run detail with per-job progress" },
            "404": errorResponse,
          },
        },
      },
      "/v1/agent/sessions": {
        get: {
          operationId: "listAgentSessions",
          description:
            "List persisted dsh sessions for the history menu, newest first.",
          responses: {
            "200": { description: "Persisted session summaries" },
          },
        },
        post: {
          operationId: "createAgentSession",
          description:
            "Start a dsh ACP session with the occ MCP server attached.",
          responses: {
            "201": { description: "Session created" },
            "502": errorResponse,
          },
        },
      },
      "/v1/agent/sessions/{id}/prompt": {
        post: {
          operationId: "promptAgentSession",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["message"],
                  properties: {
                    message: { type: "string", maxLength: 8000 },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "text/event-stream of AgentEvent frames (run.started, assistant.delta, tool.called, run.completed, ...)",
            },
            "404": errorResponse,
          },
        },
      },
      "/v1/agent/sessions/{id}/cancel": {
        post: {
          operationId: "cancelAgentSession",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: { "200": { description: "Cancellation requested" } },
        },
      },
      "/v1/agent/sessions/{id}/replay": {
        get: {
          operationId: "replayAgentSession",
          description:
            "Read dsh's persisted session log and return turns with tool calls for the sidebar trajectory.",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": { description: "Persisted turns and tool-call trajectory" },
            "404": errorResponse,
          },
        },
      },
      "/v1/agent/ui": {
        get: {
          operationId: "agentUi",
          responses: {
            "200": { description: "Dependency-free HTML agent sidebar" },
          },
        },
      },
      "/v1/review/proposals": {
        post: {
          operationId: "createReviewProposal",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["kind", "payload"],
                  properties: {
                    kind: { type: "string", enum: ["fact", "relation"] },
                    payload: { type: "object" },
                    evidence: { type: "object" },
                    idempotency_key: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "201": { description: "Proposal stored in the review queue" },
            "200": { description: "Idempotent replay of an existing proposal" },
            "400": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/v1/review/queue": {
        get: {
          operationId: "listReviewQueue",
          parameters: [
            {
              name: "status",
              in: "query",
              schema: {
                type: "string",
                enum: ["pending", "accepted", "rejected"],
              },
            },
            {
              name: "kind",
              in: "query",
              schema: { type: "string", enum: ["fact", "relation"] },
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            },
            {
              name: "offset",
              in: "query",
              schema: { type: "integer", minimum: 0, default: 0 },
            },
          ],
          responses: { "200": { description: "Review queue items" }, "400": errorResponse },
        },
      },
      "/v1/review/items/{id}/decision": {
        post: {
          operationId: "decideReviewItem",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["decision"],
                  properties: {
                    decision: {
                      type: "string",
                      enum: ["accepted", "rejected"],
                    },
                    reviewer: { type: "string", maxLength: 120 },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Decision stored; accepted items write canonical rows" },
            "400": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/v1/review/batch": {
        post: {
          operationId: "decideReviewBatch",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["decision"],
                  properties: {
                    decision: {
                      type: "string",
                      enum: ["accepted", "rejected"],
                    },
                    ids: {
                      type: "array",
                      maxItems: 500,
                      items: { type: "string" },
                    },
                    kind: { type: "string", enum: ["fact", "relation"] },
                    company: { type: "string" },
                    limit: {
                      type: "integer",
                      minimum: 1,
                      maximum: 500,
                      default: 200,
                    },
                    all: { type: "boolean", default: false },
                    reviewer: { type: "string", maxLength: 120 },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Batch decided; returns updated/skipped counts" },
            "400": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/v1/review/ui": {
        get: {
          operationId: "reviewUi",
          responses: {
            "200": {
              description:
                "Dependency-free HTML review console for the local API",
            },
          },
        },
      },
    },
  };
}

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
              description: "Internal ULID or slug",
            },
          ],
          responses: {
            "200": { description: "Company profile, aliases, listings, financials" },
            "404": errorResponse,
          },
        },
      },
    },
  };
}

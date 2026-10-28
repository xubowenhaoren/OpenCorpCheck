import { describe, expect, it } from "vitest";

import { createApp, type HealthReport } from "../src/app.js";
import type { SearchService } from "../src/services/search.js";

const hit = {
  id: "cmp_apple",
  slug: "apple",
  legalName: "Apple Inc.",
  displayName: "Apple Inc.",
  coverageTier: "index_member" as const,
  aliases: ["苹果", "AAPL"],
  tickers: [{ ticker: "AAPL", exchange: "NASDAQ", currency: "USD" }],
  indices: ["SPX", "NDX"],
  markets: ["US" as const],
  matchType: "alias" as const,
  score: 1,
};

const fakeSearch = {
  searchCompanies: async () => ({
    hits: [hit],
    citations: [],
    normalizedQuery: "apple",
    rerank: false,
    explain: {
      normalizedQuery: "apple",
      tokens: ["appl"],
      branches: { bm25: [], dense: [] },
      fusion: [],
      timings: { plannerMs: 1, qdrantMs: 1, rerankMs: 0 },
    },
  }),
  searchDocuments: async () => ({
    hits: [
      {
        chunkId: "chunk_1",
        documentId: "doc_1",
        companyId: "cmp_apple",
        text: "Apple designs iPhone.",
        matchType: "hybrid" as const,
        score: 0.03,
      },
    ],
    citations: [{ url: "https://fixture.local/apple" }],
    normalizedQuery: "iphone",
    rerank: false,
  }),
  getCompany: async () => null,
} as unknown as SearchService;

const healthy: HealthReport = {
  ok: true,
  database: { ok: true },
  qdrant: { ok: true },
  embeddings: { ok: true },
};

function app() {
  return createApp({ search: fakeSearch, health: async () => healthy });
}

describe("search API", () => {
  it("returns company hits with meta", async () => {
    const response = await app().request(
      "/v1/search/companies?q=apple&explain=true",
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.hits[0].slug).toBe("apple");
    expect(body.data.explain.tokens).toEqual(["appl"]);
    expect(body.meta.mode).toBe("hybrid");
    expect(body.meta.query).toBe("apple");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("rejects a missing query", async () => {
    const response = await app().request("/v1/search/companies");
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("bad_request");
  });

  it("returns document hits with citations", async () => {
    const response = await app().request("/v1/search/documents?q=iphone");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.hits[0].chunkId).toBe("chunk_1");
    expect(body.meta.citations[0].url).toBe("https://fixture.local/apple");
  });

  it("returns 404 for an unknown company", async () => {
    const response = await app().request("/v1/companies/missing");
    expect(response.status).toBe(404);
  });

  it("serves OpenAPI", async () => {
    const response = await app().request("/openapi.json");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.paths["/v1/search/companies"]).toBeTruthy();
  });
});

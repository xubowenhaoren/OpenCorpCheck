import { AppError, type CompanyCard } from "@occ/core";
import { describe, expect, it } from "vitest";

import { createApp, type HealthReport } from "../src/app.js";
import type { CompanyService } from "../src/services/company.js";
import type { ReviewService } from "../src/services/review.js";
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
} as unknown as SearchService;

function card(include?: string[]): CompanyCard {
  const all = !include;
  return {
    company: {
      id: "cmp_apple",
      slug: "apple",
      legalName: "Apple Inc.",
      displayName: "Apple Inc.",
      coverageTier: "index_member",
      aliases: ["苹果"],
      tickers: [{ ticker: "AAPL", exchange: "NASDAQ" }],
      indices: ["NDX"],
    },
    counts: {
      financials: 29,
      facts: 17,
      relationsOutgoing: 2,
      relationsIncoming: 0,
      events: 6,
    },
    ...(all || include?.includes("financials")
      ? {
          financials: [
            {
              id: "ff_1",
              companyId: "cmp_apple",
              statement: "income",
              item: "revenue",
              periodKind: "annual" as const,
              periodEnd: "2025-09-27",
              value: 416161000000,
              unit: "currency",
              currency: "USD",
              method: "deterministic_table_v1",
              sourceRefs: [3],
            },
          ],
        }
      : {}),
    ...(all || include?.includes("facts")
      ? {
          facts: [
            {
              id: "fact_1",
              companyId: "cmp_apple",
              predicate: "headquarters",
              value: { text: "Cupertino" },
              method: "deterministic_snapshot_v1",
              sourceRefs: [1],
            },
          ],
        }
      : {}),
    ...(all || include?.includes("relations")
      ? {
          relations: {
            outgoing: [
              {
                id: "rel_1",
                src: {
                  id: "cmp_apple",
                  slug: "apple",
                  displayName: "Apple Inc.",
                  tickers: [{ ticker: "AAPL", exchange: "NASDAQ" }],
                },
                dst: {
                  id: "cmp_googl",
                  slug: "alphabet",
                  displayName: "Alphabet Inc.",
                  tickers: [{ ticker: "GOOGL", exchange: "NASDAQ" }],
                },
                type: "buys_from" as const,
                label: "buys_from" as const,
                direction: "outgoing" as const,
                status: "inferred" as const,
                confidence: 0.8,
                evidence: [{ url: "https://example.com/source" }],
              },
            ],
            incoming: [],
          },
        }
      : {}),
    ...(all || include?.includes("events")
      ? {
          events: [
            {
              id: "fact_event",
              companyId: "cmp_apple",
              kind: "profile_event" as const,
              date: "2026-01-12",
              title: "Gemini Siri",
            },
          ],
        }
      : {}),
  };
}

const fakeCompany = {
  getCard: async (ref: string, query: { include?: string[] }) => {
    if (ref === "missing") {
      throw new AppError("not_found", "company not found: missing");
    }
    return card(query.include);
  },
} as unknown as CompanyService;

let created = true;
const fakeReview = {
  createProposal: async (proposal: { kind: string }) => ({
    item: {
      id: "rvw_1",
      kind: proposal.kind,
      payload: {},
      status: "pending",
      createdAt: new Date().toISOString(),
    },
    created,
  }),
  list: async () => ({
    items: [],
    total: 0,
  }),
} as unknown as ReviewService;

const healthy: HealthReport = {
  ok: true,
  database: { ok: true },
  qdrant: { ok: true },
  embeddings: { ok: true },
};

function app() {
  return createApp({
    search: fakeSearch,
    company: fakeCompany,
    review: fakeReview,
    health: async () => healthy,
  });
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
});

describe("company card API", () => {
  it("returns the full card by default", async () => {
    const response = await app().request("/v1/companies/AAPL");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.company.displayName).toBe("Apple Inc.");
    expect(body.data.counts.financials).toBe(29);
    expect(body.data.financials[0].item).toBe("revenue");
    expect(body.data.relations.outgoing[0].status).toBe("inferred");
    expect(body.meta.include).toEqual([
      "financials",
      "facts",
      "relations",
      "events",
    ]);
  });

  it("honours include and per-section limits", async () => {
    const response = await app().request(
      "/v1/companies/AAPL?include=facts&fact_limit=5",
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.facts).toHaveLength(1);
    expect(body.data.financials).toBeUndefined();
    expect(body.meta.include).toEqual(["facts"]);
  });

  it("rejects an invalid include value", async () => {
    const response = await app().request("/v1/companies/AAPL?include=bogus");
    expect(response.status).toBe(400);
  });

  it("returns 404 for an unknown company", async () => {
    const response = await app().request("/v1/companies/missing");
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("not_found");
  });

  it("serves OpenAPI", async () => {
    const response = await app().request("/openapi.json");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.paths["/v1/search/companies"]).toBeTruthy();
    expect(body.paths["/v1/companies/{id}"]).toBeTruthy();
    expect(body.paths["/v1/review/proposals"].post).toBeTruthy();
  });
});

describe("review proposals", () => {
  it("returns 201 when a proposal is created", async () => {
    created = true;
    const response = await app().request("/v1/review/proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "fact",
        payload: { company: "AAPL", predicate: "headquarters", value: "X" },
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data.status).toBe("pending");
    expect(body.meta.created).toBe(true);
  });

  it("returns 200 on an idempotent replay", async () => {
    created = false;
    const response = await app().request("/v1/review/proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "fact",
        payload: { company: "AAPL", predicate: "headquarters", value: "X" },
      }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).meta.created).toBe(false);
  });

  it("rejects an invalid body", async () => {
    const response = await app().request("/v1/review/proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "nope" }),
    });
    expect(response.status).toBe(400);
  });

  it("lists the review queue", async () => {
    const response = await app().request("/v1/review/queue?status=pending");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items).toEqual([]);
    expect(body.data.total).toBe(0);
  });
});

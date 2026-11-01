import { AppError, type CompanyCard } from "@occ/core";
import { describe, expect, it } from "vitest";

import { createApp, type HealthReport } from "../src/app.js";
import type { AgentService } from "../src/services/agent.js";
import type { CompanyService } from "../src/services/company.js";
import type { NewsService } from "../src/services/news.js";
import type { ResearchService } from "../src/services/research.js";
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
  decide: async (id: string, input: { decision: string }) => ({
    item: {
      id,
      kind: "relation",
      payload: {},
      status: input.decision,
      createdAt: new Date().toISOString(),
    },
    updated: true,
  }),
  decideBatch: async (input: {
    ids?: string[];
    kind?: string;
    company?: string;
    all?: boolean;
    decision: string;
  }) => {
    if (!input.all && !input.ids?.length && !input.kind && !input.company) {
      throw new AppError(
        "bad_request",
        "batch decision requires ids, kind, company or all=true",
      );
    }
    return {
      updated: input.ids?.length ?? 1,
      skipped: 0,
      items: [],
    };
  },
} as unknown as ReviewService;

const fakeResearch = {
  enqueue: async () => ({
    runId: "run_1",
    jobKey: "US:AAPL",
    company: {
      id: "cmp_apple",
      slug: "apple",
      displayName: "Apple Inc.",
      ticker: "AAPL",
      market: "US",
      skill: "mag7-profile",
    },
    status: "queued",
    queued: true,
  }),
  getRun: async (runId: string) => {
    if (runId === "missing") {
      throw new AppError("not_found", `run not found: ${runId}`);
    }
    return {
      id: runId,
      kind: "research",
      status: "queued",
      totalJobs: 1,
      completedJobs: 0,
      failedJobs: 0,
      options: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      jobs: [],
    };
  },
  listRuns: async () => [],
} as unknown as ResearchService;

const fakeAgent = {
  createSession: async () => ({ sessionId: "sess_1" }),
  prompt: async function* () {
    yield { type: "assistant.delta", text: "hi" };
    yield { type: "run.completed", stopReason: "end_turn" };
  },
  cancel: async () => undefined,
} as unknown as AgentService;

const fakeNews = {
  getStatus: async (company?: string) => {
    if (company === "missing") {
      throw new AppError("not_found", `company not found: ${company}`);
    }
    return {
      active: null,
      lastSweep: null,
      sweeps: [],
      dueCount: 0,
      nextDueAt: null,
      totalCompanies: 0,
      ttlMs: 82_800_000,
      sweepCron: "0 7 * * *",
      historyMs: 259_200_000,
      serverTime: new Date().toISOString(),
      triggered: false,
      pendingSweep: false,
    };
  },
} as unknown as NewsService;

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
    research: fakeResearch,
    review: fakeReview,
    agent: fakeAgent,
    news: fakeNews,
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
    expect(body.paths["/v1/review/batch"].post).toBeTruthy();
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

  it("decides one item", async () => {
    const response = await app().request("/v1/review/items/rvw_1/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "accepted", reviewer: "bowen" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.item.status).toBe("accepted");
    expect(body.meta.updated).toBe(true);
  });

  it("decides a filtered batch", async () => {
    const response = await app().request("/v1/review/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "rejected",
        ids: ["rvw_1", "rvw_2"],
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.updated).toBe(2);
    expect(body.meta.decision).toBe("rejected");
  });

  it("refuses an unfiltered batch", async () => {
    const response = await app().request("/v1/review/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "accepted" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("bad_request");
  });

  it("decides every pending item when all=true", async () => {
    const response = await app().request("/v1/review/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "accepted", all: true, limit: 10 }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).data.updated).toBe(1);
  });

  it("serves the local review console", async () => {
    const response = await app().request("/v1/review/ui");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Review queue");
  });
});

describe("research API", () => {
  it("queues a company research run", async () => {
    const response = await app().request("/v1/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ company: "AAPL", focus: "cloud revenue" }),
    });
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.data.runId).toBe("run_1");
    expect(body.data.jobKey).toBe("US:AAPL");
    expect(body.data.company.skill).toBe("mag7-profile");
  });

  it("returns run detail and 404 for an unknown run", async () => {
    const ok = await app().request("/v1/runs/run_1");
    expect(ok.status).toBe(200);
    expect((await ok.json()).data.status).toBe("queued");

    const missing = await app().request("/v1/runs/missing");
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("not_found");
  });

  it("rejects a research request without a company", async () => {
    const response = await app().request("/v1/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ focus: "x" }),
    });
    expect(response.status).toBe(400);
  });
});

describe("agent sidebar", () => {
  it("creates a session and streams normalized events", async () => {
    const created = await app().request("/v1/agent/sessions", {
      method: "POST",
    });
    expect(created.status).toBe(201);
    const sessionId = (await created.json()).data.sessionId;

    const response = await app().request(
      `/v1/agent/sessions/${sessionId}/prompt`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("event: assistant.delta");
    expect(text).toContain("event: run.completed");
  });

  it("serves the local sidebar console", async () => {
    const response = await app().request("/v1/agent/ui");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Agent Sidebar");
  });
});

describe("news status", () => {
  it("returns the sweep window without a refresh control", async () => {
    const response = await app().request("/v1/news/status");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.dueCount).toBe(0);
    expect(body.data.sweepCron).toBe("0 7 * * *");
    expect(body.meta.request_id).toBeTruthy();
  });

  it("returns 404 for an unknown company", async () => {
    const response = await app().request("/v1/news/status?company=missing");
    expect(response.status).toBe(404);
  });

  it("has no public refresh or sweep route", async () => {
    for (const path of [
      "/v1/news/refresh",
      "/v1/news/sweep",
      "/v1/companies/apple/news/refresh",
    ]) {
      const response = await app().request(path, { method: "POST" });
      expect(response.status).toBe(404);
    }
  });
});

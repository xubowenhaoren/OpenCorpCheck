#!/usr/bin/env node
/**
 * OpenCorpCheck MCP stdio server for Eastmoney F10.
 *
 * It is a thin bridge: the Python finance-analyst sidecar owns Playwright,
 * pacing and retries; this process only validates arguments, projects the
 * response for an agent context, and returns JSON text. Attach it to dsh with
 * `@deepseek-ai/dsh-mcp-client` (see phase0/f10-mcp.patch.yml).
 */

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { RelationTypeSchema } from "@occ/core";
import {
  FinanceAnalystClient,
  projectScrapeResult,
} from "@occ/sources-eastmoney-f10";
import { z } from "zod";

import { config } from "./config.js";

const VERSION = "0.1.0";
const SCRAPE_TIMEOUT_MS = 180_000;
const API_TIMEOUT_MS = 15_000;

const client = new FinanceAnalystClient();

function jsonResult(payload: unknown, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

function errorResult(tool: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return jsonResult(`${tool} failed: ${message}`, true);
}

async function apiRequest(
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${config.apiUrl.replace(/\/+$/, "")}${path}`, {
      ...init,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `OpenCorpCheck API unavailable at ${config.apiUrl} (${message}); start it with 'pnpm dev:api'`,
    );
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`API ${response.status}: ${text.slice(0, 500)}`);
  }
  return body;
}

async function apiGet(path: string): Promise<unknown> {
  return apiRequest(path);
}

async function apiPost(path: string, body: unknown): Promise<unknown> {
  return apiRequest(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function resolveCompanyRef(ref: string): Promise<string> {
  const body = (await apiGet(
    `/v1/companies/${encodeURIComponent(ref)}?include=`,
  )) as { data: { company: { id: string } } };
  return body.data.company.id;
}

const server = new McpServer({
  name: "occ-finance-analyst",
  version: VERSION,
});

server.registerTool(
  "f10_scrape",
  {
    title: "Eastmoney F10 company pages",
    description: [
      "Fetch structured Eastmoney F10 pages for one A-share, HK or US listed company.",
      "",
      "Use it for financial statements, shareholder structure, company profile, business",
      "analysis and analyst forecasts, especially for A-share and HK companies where",
      "official filings are hard to parse. For US companies treat F10 as a cross-check",
      "and cite SEC filings for material facts.",
      "",
      "Returns JSON: meta (market, normalized_code, fetched_at, pages_ok) and pages[]",
      "with label, page, url, http_status, text, tables ({caption, headers, rows}),",
      "table_count, XHR metadata, warnings and error. detail='summary' (default) caps",
      "text at 20k chars and table rows at 60 per table; use detail='full' only when a",
      "number you need is missing, because the payload can be very large.",
      "",
      "Citation rules: cite the page url and meta.fetched_at. F10 is a secondary,",
      "proprietary source (Eastmoney), not an audit-grade filing; never call a number",
      "audited unless SEC/CNINFO/HKEX confirms it. If pages[].error is set, say so",
      "instead of guessing.",
    ].join("\n"),
    inputSchema: z.object({
      market: z.enum(["A", "HK", "US"]).describe("Listing market"),
      code: z
        .string()
        .min(1)
        .max(20)
        .describe("Ticker or code: 600519, 00700, AAPL, BRK.B"),
      pages: z
        .array(z.string().min(1))
        .optional()
        .describe(
          "Page hashes, e.g. ['cwfx','gsgk']. Omit to use the market preset; see f10_pages.",
        ),
      preset: z
        .enum(["default", "minimal"])
        .optional()
        .describe("Preset when pages is omitted. default covers the core pages."),
      detail: z
        .enum(["summary", "full"])
        .optional()
        .default("summary")
        .describe("summary trims long text/tables; full returns everything."),
      include_xhr: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include raw XHR bodies in the result (large)."),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ market, code, pages, preset, detail, include_xhr }) => {
    try {
      const response = await client.scrape(
        { market, code, pages, preset, capture_xhr: true },
        { timeoutMs: SCRAPE_TIMEOUT_MS },
      );
      const projected = projectScrapeResult(response, {
        detail,
        includeXhrBodies: include_xhr,
      });
      const allFailed =
        response.pages.length > 0 && response.pages.every((page) => page.error);
      return jsonResult(projected, allFailed);
    } catch (error) {
      return errorResult("f10_scrape", error);
    }
  },
);

server.registerTool(
  "f10_pages",
  {
    title: "List Eastmoney F10 pages",
    description:
      "List valid F10 page hashes and presets for a market (A, HK, US). Call this " +
      "before f10_scrape when you need a page outside the default preset.",
    inputSchema: z.object({
      market: z.enum(["A", "HK", "US"]).describe("Listing market"),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ market }) => {
    try {
      return jsonResult(await client.pages(market));
    } catch (error) {
      return errorResult("f10_pages", error);
    }
  },
);

server.registerTool(
  "search_companies",
  {
    title: "Search companies",
    description:
      "Search the internal OpenCorpCheck company database by name, ticker, alias, " +
      "pinyin or natural language. Returns ranked candidates with matchType and score. " +
      "Call this first when you only have a name; then use get_company with the ticker/slug.",
    inputSchema: z.object({
      query: z.string().min(1).max(200).describe("Company name, ticker, alias or query"),
      mode: z
        .enum(["hybrid", "keyword", "semantic"])
        .optional()
        .default("hybrid"),
      limit: z.number().int().min(1).max(20).optional().default(5),
      market: z.string().optional().describe("A, HK, US (comma-separated)"),
      index: z.string().optional().describe("Index codes (comma-separated)"),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ query, mode, limit, market, index }) => {
    try {
      const url = new URL("/v1/search/companies", config.apiUrl);
      url.searchParams.set("q", query);
      url.searchParams.set("mode", mode);
      url.searchParams.set("limit", String(limit));
      if (market) url.searchParams.set("market", market);
      if (index) url.searchParams.set("index", index);
      return jsonResult(await apiGet(`${url.pathname}${url.search}`));
    } catch (error) {
      return errorResult("search_companies", error);
    }
  },
);

server.registerTool(
  "get_company",
  {
    title: "Get company card",
    description: [
      "Get one company card from the internal database: profile, counts, financials,",
      "facts, relations (outgoing/incoming) and recent events.",
      "",
      "Pass a ULID, slug or ticker (AAPL, 600519, 00700). Use include to trim heavy",
      "sections (exercise caution on token budget). Financial facts carry periodKind,",
      "periodLabel, sourceRefs and a source URL. Relations with status='inferred' are",
      "unreviewed machine extraction: cite their evidence quote/url and never present",
      "them as audited or verified.",
    ].join("\n"),
    inputSchema: z.object({
      company: z.string().min(1).describe("ULID, slug or ticker"),
      include: z
        .array(z.enum(["financials", "facts", "relations", "events"]))
        .optional()
        .describe("Sections to include; omit for all"),
      financial_limit: z.number().int().min(1).max(200).optional(),
      fact_limit: z.number().int().min(1).max(200).optional(),
      relation_limit: z.number().int().min(1).max(200).optional(),
      event_limit: z.number().int().min(1).max(100).optional(),
      relation_status: z
        .enum(["reported", "inferred", "verified", "rejected"])
        .optional(),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({
    company,
    include,
    financial_limit,
    fact_limit,
    relation_limit,
    event_limit,
    relation_status,
  }) => {
    try {
      const url = new URL(
        `/v1/companies/${encodeURIComponent(company)}`,
        config.apiUrl,
      );
      if (include) url.searchParams.set("include", include.join(","));
      if (financial_limit) {
        url.searchParams.set("financial_limit", String(financial_limit));
      }
      if (fact_limit) url.searchParams.set("fact_limit", String(fact_limit));
      if (relation_limit) {
        url.searchParams.set("relation_limit", String(relation_limit));
      }
      if (event_limit) url.searchParams.set("event_limit", String(event_limit));
      if (relation_status) {
        url.searchParams.set("relation_status", relation_status);
      }
      return jsonResult(await apiGet(`${url.pathname}${url.search}`));
    } catch (error) {
      return errorResult("get_company", error);
    }
  },
);

server.registerTool(
  "search_documents",
  {
    title: "Search research documents",
    description:
      "Search internal research chunks (company profiles today, news later). " +
      "Optionally restrict to one company by ticker/slug/id. Returns chunk text with " +
      "company and source metadata; cite the returned source URL.",
    inputSchema: z.object({
      query: z.string().min(1).max(400),
      company: z
        .string()
        .optional()
        .describe("Restrict to a company (ULID, slug or ticker)"),
      doc_type: z.string().optional(),
      mode: z
        .enum(["hybrid", "keyword", "semantic"])
        .optional()
        .default("hybrid"),
      limit: z.number().int().min(1).max(20).optional().default(5),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ query, company, doc_type, mode, limit }) => {
    try {
      const url = new URL("/v1/search/documents", config.apiUrl);
      url.searchParams.set("q", query);
      url.searchParams.set("mode", mode);
      url.searchParams.set("limit", String(limit));
      if (doc_type) url.searchParams.set("doc_type", doc_type);
      if (company) {
        url.searchParams.set("company_id", await resolveCompanyRef(company));
      }
      return jsonResult(await apiGet(`${url.pathname}${url.search}`));
    } catch (error) {
      return errorResult("search_documents", error);
    }
  },
);

server.registerTool(
  "deep_research",
  {
    title: "Queue company research",
    description: [
      "Queue a deep company-profile research job (BFS/DFS over web + official",
      "filings, or Eastmoney F10 when include_f10=true). This is asynchronous:",
      "it returns a runId and jobKey immediately. Poll get_run with the runId",
      "until status is completed (or failed/partial), then use get_company and",
      "search_documents to read the result.",
      "",
      "Use it when the database lacks a profile or the profile is stale for the",
      "question. Pass a focused brief (e.g. '只研究云业务收入与 AI capex') to keep",
      "the run small. Do not queue the same company repeatedly while a run is",
      "active; check get_run first. Research writes a cited profile into the",
      "database and review queue, never directly into verified facts.",
    ].join("\n"),
    inputSchema: z.object({
      company: z.string().min(1).describe("ULID, slug or ticker (AAPL, 600519, 00700)"),
      focus: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe("Narrow research brief; omit for the full profile"),
      include_f10: z
        .boolean()
        .optional()
        .default(false)
        .describe("Attach Eastmoney F10 tools (A/HK preferred, US cross-check)"),
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe("Ignore the research cache and regenerate the profile"),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ company, focus, include_f10, force }) => {
    try {
      return jsonResult(
        await apiPost("/v1/research", {
          company,
          ...(focus ? { focus } : {}),
          include_f10,
          force,
        }),
      );
    } catch (error) {
      return errorResult("deep_research", error);
    }
  },
);

server.registerTool(
  "get_run",
  {
    title: "Get research run status",
    description:
      "Return one research run: status, per-job progress, duration/tokens and " +
      "dead-letter errors. Poll this after deep_research. A completed run means " +
      "the profile was written and indexed; read it with get_company.",
    inputSchema: z.object({
      run_id: z.string().min(1).describe("runId returned by deep_research"),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ run_id }) => {
    try {
      return jsonResult(
        await apiGet(`/v1/runs/${encodeURIComponent(run_id)}`),
      );
    } catch (error) {
      return errorResult("get_run", error);
    }
  },
);

server.registerTool(
  "propose_fact",
  {
    title: "Propose a fact",
    description:
      "Propose a company fact for human review. This never writes the fact directly; " +
      "it returns a pending review id. Always include a literal quote and source_url " +
      "when available so the reviewer can verify it.",
    inputSchema: z.object({
      company: z.string().min(1).describe("ULID, slug or ticker"),
      predicate: z.string().min(1).max(64),
      value: z.unknown().describe("JSON value"),
      quote: z.string().optional(),
      source_url: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ company, predicate, value, quote, source_url, confidence }) => {
    try {
      return jsonResult(
        await apiPost("/v1/review/proposals", {
          kind: "fact",
          payload: { company, predicate, value, confidence },
          evidence: {
            ...(quote ? { quote } : {}),
            ...(source_url ? { sourceUrl: source_url } : {}),
          },
        }),
      );
    } catch (error) {
      return errorResult("propose_fact", error);
    }
  },
);

server.registerTool(
  "propose_relation",
  {
    title: "Propose a company relationship",
    description: [
      "Propose a company-to-company relationship for human review. This never writes",
      "the edge directly; it returns a pending review id.",
      "",
      "src is the subject and type encodes direction: 'supplies' = src supplies dst;",
      "'buys_from' = src buys from dst; 'owns' = src owns a stake in dst; 'parent_of'",
      "= src is dst's parent; 'competes_with'/'partners_with' are symmetric.",
      "",
      "Include the literal quote and source_url. Relations extracted by the system are",
      "stored as status='inferred' until a human accepts them.",
    ].join("\n"),
    inputSchema: z.object({
      src: z.string().min(1).describe("Subject company (ULID, slug or ticker)"),
      dst: z.string().min(1).describe("Object company (ULID, slug or ticker)"),
      type: RelationTypeSchema,
      quote: z.string().optional(),
      source_url: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ src, dst, type, quote, source_url, confidence }) => {
    try {
      return jsonResult(
        await apiPost("/v1/review/proposals", {
          kind: "relation",
          payload: { src, dst, type, confidence },
          evidence: {
            ...(quote ? { quote } : {}),
            ...(source_url ? { sourceUrl: source_url } : {}),
          },
        }),
      );
    } catch (error) {
      return errorResult("propose_relation", error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

// stdout is the MCP wire; diagnostics go to stderr.
console.error(
  `[occ-f10-mcp] ready (sidecar ${client.baseUrl}, version ${VERSION})`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}

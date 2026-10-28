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
import {
  FinanceAnalystClient,
  projectScrapeResult,
} from "@occ/sources-eastmoney-f10";
import { z } from "zod";

const VERSION = "0.1.0";
const SCRAPE_TIMEOUT_MS = 180_000;

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

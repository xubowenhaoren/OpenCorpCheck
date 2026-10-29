import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MCP_ENTRY = fileURLToPath(new URL("../dist/mcp.js", import.meta.url));

const scrapeRequests: unknown[] = [];
const apiRequests: string[] = [];
const proposalRequests: unknown[] = [];

const scrapeFixture = {
  meta: {
    market: "A",
    code: "600519",
    normalized_code: "SH600519",
    fetched_at: "2026-10-28T00:00:00.000Z",
    elapsed_ms: 1_234,
    pages_requested: 1,
    pages_ok: 1,
    concurrency: 2,
    rate_per_sec: 5,
  },
  pages: [
    {
      label: "财务分析",
      page: "cwfx",
      url: "https://emweb.eastmoney.com/PC_HSF10/pages/index.html?code=SH600519#/cwfx",
      final_url:
        "https://emweb.eastmoney.com/PC_HSF10/pages/index.html?code=SH600519#/cwfx",
      http_status: 200,
      text: "主要指标\n" + "营".repeat(25_000),
      text_chars: 25_005,
      truncated: false,
      tables: [
        {
          caption: "主要指标",
          headers: ["指标", "2025"],
          rows: Array.from({ length: 100 }, (_, index) => [
            `指标${index}`,
            String(index),
          ]),
        },
      ],
      table_count: 1,
      html_sha256: "abc123",
      storage_key: "f10/A/SH600519/cwfx/abc123.html",
      xhr: [
        {
          url: "https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_FINANCE_MAINFINADATA",
          status: 200,
          content_type: "text/plain;charset=UTF-8",
          json: { result: { data: [] } },
          text: null,
          truncated: false,
        },
      ],
      warnings: [],
      attempts: 1,
      elapsed_ms: 1_200,
      error: null,
    },
  ],
  errors: [],
};

let sidecar: Server;
let sidecarUrl = "";
let mcp: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  sidecar = createServer((request, response) => {
    if (request.url === "/health") {
      return sendJson(response, {
        status: "ok",
        browser: "ready",
        version: "0.1.0",
        settings: { max_concurrency: 2 },
      });
    }
    if (request.url?.startsWith("/v1/f10/pages/")) {
      return sendJson(response, {
        market: "A",
        pages: { 财务分析: "cwfx", 公司概况: "gsgk" },
        presets: { default: ["cwfx", "gsgk"] },
      });
    }
    if (request.url === "/v1/f10/scrape" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        scrapeRequests.push(JSON.parse(body));
        sendJson(response, scrapeFixture);
      });
      return;
    }

    const url = new URL(request.url ?? "/", "http://fixture");
    apiRequests.push(`${request.method} ${request.url}`);

    if (url.pathname === "/v1/search/companies") {
      return sendJson(response, {
        data: {
          hits: [
            {
              id: "cmp_aapl",
              slug: "apple",
              legalName: "Apple Inc.",
              displayName: "Apple Inc.",
              tickers: [{ ticker: "AAPL", exchange: "NASDAQ" }],
              matchType: "identifier",
              score: 1,
            },
          ],
        },
        meta: { total: 1 },
      });
    }
    if (url.pathname.startsWith("/v1/companies/")) {
      return sendJson(response, {
        data: {
          company: {
            id: "cmp_aapl",
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
            relationsOutgoing: 1,
            relationsIncoming: 0,
            events: 6,
          },
          financials: [
            {
              id: "ff_1",
              companyId: "cmp_aapl",
              statement: "income",
              item: "revenue",
              periodKind: "annual",
              periodEnd: "2025-09-27",
              value: 416161000000,
              unit: "currency",
              currency: "USD",
              method: "deterministic_table_v1",
              sourceRefs: [3],
            },
          ],
        },
        meta: { include: url.searchParams.get("include") },
      });
    }
    if (url.pathname === "/v1/search/documents") {
      return sendJson(response, {
        data: {
          hits: [
            {
              chunkId: "chunk_1",
              documentId: "doc_1",
              companyId: "cmp_aapl",
              companyDisplayName: "Apple Inc.",
              text: "Apple designs iPhone.",
              matchType: "hybrid",
              score: 0.03,
            },
          ],
        },
        meta: { total: 1, citations: [] },
      });
    }
    if (url.pathname === "/v1/review/proposals" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        proposalRequests.push(JSON.parse(body));
        response.statusCode = 201;
        sendJson(response, {
          data: {
            id: "rvw_1",
            kind: "relation",
            payload: {},
            status: "pending",
            createdAt: new Date().toISOString(),
          },
          meta: { created: true },
        });
      });
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => sidecar.listen(0, "127.0.0.1", resolve));
  const address = sidecar.address() as AddressInfo;
  sidecarUrl = `http://127.0.0.1:${address.port}`;

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_ENTRY],
    env: {
      ...(process.env as Record<string, string>),
      OCC_FINANCE_ANALYST_URL: sidecarUrl,
      OCC_API_URL: sidecarUrl,
    },
    stderr: "pipe",
  });
  mcp = new Client({ name: "occ-f10-test", version: "0.1.0" });
  await mcp.connect(transport);
});

afterAll(async () => {
  await mcp?.close();
  await new Promise<void>((resolve, reject) =>
    sidecar.close((error) => (error ? reject(error) : resolve())),
  );
});

describe("occ-f10 MCP server", () => {
  it("advertises F10 and company tools with citation guidance", async () => {
    const { tools } = await mcp.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "f10_pages",
      "f10_scrape",
      "get_company",
      "propose_fact",
      "propose_relation",
      "search_companies",
      "search_documents",
    ]);
    const scrape = tools.find((tool) => tool.name === "f10_scrape")!;
    expect(scrape.description).toMatch(/cite the page url/i);
    expect(scrape.inputSchema.required).toEqual(["market", "code"]);
    const company = tools.find((tool) => tool.name === "get_company")!;
    expect(company.description).toMatch(/unreviewed machine extraction/i);
    expect(company.description).toMatch(/never present/i);
  });

  it("lists pages for a market", async () => {
    const result = await mcp.callTool({
      name: "f10_pages",
      arguments: { market: "A" },
    });
    const text = contentText(result);
    expect(JSON.parse(text).pages["财务分析"]).toBe("cwfx");
  });

  it("projects a scrape for an agent context and forwards the request", async () => {
    scrapeRequests.length = 0;
    const result = await mcp.callTool({
      name: "f10_scrape",
      arguments: { market: "A", code: "600519", pages: ["cwfx"] },
    });
    expect(result.isError).toBeFalsy();

    const projected = JSON.parse(contentText(result));
    expect(projected.detail).toBe("summary");
    expect(projected.pages[0].text.length).toBe(20_000);
    expect(projected.pages[0].text_truncated).toBe(true);
    expect(projected.pages[0].tables[0].rows).toHaveLength(60);
    expect(projected.pages[0].xhr[0].report_name).toBe(
      "RPT_F10_FINANCE_MAINFINADATA",
    );

    expect(scrapeRequests[0]).toEqual({
      market: "A",
      code: "600519",
      pages: ["cwfx"],
      capture_xhr: true,
    });
  });

  it("returns a company card through the API", async () => {
    apiRequests.length = 0;
    const result = await mcp.callTool({
      name: "get_company",
      arguments: { company: "AAPL", include: ["financials"] },
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(contentText(result)) as {
      data: { company: { displayName: string } };
    };
    expect(payload.data.company.displayName).toBe("Apple Inc.");
    expect(apiRequests[0]).toContain("/v1/companies/AAPL");
    expect(apiRequests[0]).toContain("include=financials");
  });

  it("searches companies and documents", async () => {
    apiRequests.length = 0;
    const companies = await mcp.callTool({
      name: "search_companies",
      arguments: { query: "AAPL" },
    });
    expect(companies.isError).toBeFalsy();
    const companyPayload = JSON.parse(contentText(companies)) as {
      data: { hits: Array<{ id: string }> };
    };
    expect(companyPayload.data.hits[0]?.id).toBe("cmp_aapl");

    const documents = await mcp.callTool({
      name: "search_documents",
      arguments: { query: "iPhone", company: "AAPL" },
    });
    expect(documents.isError).toBeFalsy();
    expect(apiRequests.some((entry) => entry.includes("/v1/companies/AAPL"))).toBe(
      true,
    );
    expect(
      apiRequests.some((entry) => entry.includes("company_id=cmp_aapl")),
    ).toBe(true);
  });

  it("posts relation proposals to the review queue", async () => {
    proposalRequests.length = 0;
    const result = await mcp.callTool({
      name: "propose_relation",
      arguments: {
        src: "AAPL",
        dst: "GOOGL",
        type: "buys_from",
        quote: "Google 是模型供应商",
        source_url: "https://example.com/source",
      },
    });
    expect(result.isError).toBeFalsy();
    expect(proposalRequests[0]).toMatchObject({
      kind: "relation",
      payload: { src: "AAPL", dst: "GOOGL", type: "buys_from" },
      evidence: {
        quote: "Google 是模型供应商",
        sourceUrl: "https://example.com/source",
      },
    });
  });
});

function contentText(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find((item) => item.type === "text");
  if (!block?.text) throw new Error("no text content in MCP result");
  return block.text;
}

function sendJson(
  response: import("node:http").ServerResponse,
  body: unknown,
): void {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

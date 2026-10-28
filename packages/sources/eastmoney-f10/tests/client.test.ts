import { describe, expect, it, vi } from "vitest";

import {
  FinanceAnalystClient,
  FinanceAnalystError,
} from "../src/index.ts";
import { makeScrapeResponse } from "./fixtures.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("FinanceAnalystClient", () => {
  it("posts a validated scrape request and parses the response", async () => {
    const fixture = makeScrapeResponse();
    const fetchImpl = vi.fn(async () => jsonResponse(fixture));
    const client = new FinanceAnalystClient({
      baseUrl: "http://sidecar:9999/",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.scrape({
      market: "A",
      code: "600519",
      pages: ["cwfx"],
      preset: "minimal",
    });

    expect(result.meta.normalized_code).toBe("SH600519");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://sidecar:9999/v1/f10/scrape");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      market: "A",
      code: "600519",
      pages: ["cwfx"],
      preset: "minimal",
    });
  });

  it("surfaces a FastAPI detail as the error message", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ detail: "unknown page 'nope' for market A" }, 422),
    );
    const client = new FinanceAnalystClient({
      baseUrl: "http://sidecar:9999",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      client.scrape({ market: "A", code: "600519", pages: ["nope"] }),
    ).rejects.toMatchObject({
      name: "FinanceAnalystError",
      status: 422,
      message: "unknown page 'nope' for market A",
    });
  });

  it("explains how to start an unreachable sidecar", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const client = new FinanceAnalystClient({
      baseUrl: "http://sidecar:9999",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.health()).rejects.toThrow(/occ-f10 serve/);
    await expect(client.health()).rejects.toBeInstanceOf(FinanceAnalystError);
  });

  it("rejects malformed requests before hitting the network", async () => {
    const fetchImpl = vi.fn();
    const client = new FinanceAnalystClient({
      baseUrl: "http://sidecar:9999",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      client.scrape({ market: "A", code: "../etc/passwd" }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads health and page catalogs", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/health")) {
        return jsonResponse({
          status: "ok",
          browser: "ready",
          version: "0.1.0",
          settings: { max_concurrency: 2 },
        });
      }
      return jsonResponse({
        market: "US",
        pages: { 财务分析: "cwfx" },
        presets: { default: ["cwfx"] },
      });
    });
    const client = new FinanceAnalystClient({
      baseUrl: "http://sidecar:9999",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect((await client.health()).browser).toBe("ready");
    expect((await client.pages("US")).pages["财务分析"]).toBe("cwfx");
  });
});

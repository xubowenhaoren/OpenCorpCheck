import {
  healthResponseSchema,
  pagesResponseSchema,
  scrapeResponseSchema,
  scrapeRequestSchema,
  type HealthResponse,
  type Market,
  type PagesResponse,
  type ScrapeRequest,
  type ScrapeResponse,
} from "./types.js";

export const DEFAULT_FINANCE_ANALYST_URL = "http://127.0.0.1:8090";
export const DEFAULT_TIMEOUT_MS = 180_000;

export class FinanceAnalystError extends Error {
  readonly status: number | undefined;
  readonly detail: unknown;

  constructor(
    message: string,
    options: { status?: number; detail?: unknown; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "FinanceAnalystError";
    this.status = options.status;
    this.detail = options.detail;
  }
}

export interface FinanceAnalystClientOptions {
  /** Sidecar base URL; defaults to `OCC_FINANCE_ANALYST_URL` or localhost:8090. */
  baseUrl?: string;
  /** Per-request timeout in ms; defaults to 180s (8-page A-share scrapes are slow). */
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Thin typed client for the Python finance-analyst sidecar.
 *
 * The sidecar owns Playwright, pacing and retries. This layer only validates
 * shapes and turns failures into a typed error, so callers (CLI, MCP, worker)
 * share one contract.
 */
export class FinanceAnalystClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FinanceAnalystClientOptions = {}) {
    this.baseUrl = (
      options.baseUrl ??
      process.env.OCC_FINANCE_ANALYST_URL ??
      DEFAULT_FINANCE_ANALYST_URL
    ).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async health(options: RequestOptions = {}): Promise<HealthResponse> {
    return healthResponseSchema.parse(
      await this.request("/health", { method: "GET" }, options),
    );
  }

  async pages(market: Market, options: RequestOptions = {}): Promise<PagesResponse> {
    return pagesResponseSchema.parse(
      await this.request(`/v1/f10/pages/${market}`, { method: "GET" }, options),
    );
  }

  async scrape(
    request: ScrapeRequest,
    options: RequestOptions = {},
  ): Promise<ScrapeResponse> {
    const body = scrapeRequestSchema.parse(request);
    return scrapeResponseSchema.parse(
      await this.request(
        "/v1/f10/scrape",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        options,
      ),
    );
  }

  private async request(
    path: string,
    init: RequestInit,
    options: RequestOptions,
  ): Promise<unknown> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (options.signal) signals.push(options.signal);
    const signal =
      signals.length === 1 ? signals[0] : AbortSignal.any(signals);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal });
    } catch (error) {
      throw new FinanceAnalystError(
        `finance-analyst is unreachable at ${this.baseUrl}${path}; start it with ` +
          "`cd services/finance-analyst && uv run occ-f10 serve`",
        { cause: error },
      );
    }

    const raw = await response.text();
    let parsed: unknown = undefined;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      const detail =
        parsed && typeof parsed === "object" && "detail" in parsed
          ? (parsed as { detail: unknown }).detail
          : parsed ?? raw;
      const message =
        typeof detail === "string"
          ? detail
          : `finance-analyst responded ${response.status}`;
      throw new FinanceAnalystError(message, {
        status: response.status,
        detail,
      });
    }

    if (parsed === undefined) {
      throw new FinanceAnalystError(
        `finance-analyst returned a non-JSON response for ${path}`,
        { status: response.status },
      );
    }
    return parsed;
  }
}

export function createFinanceAnalystClient(
  options: FinanceAnalystClientOptions = {},
): FinanceAnalystClient {
  return new FinanceAnalystClient(options);
}

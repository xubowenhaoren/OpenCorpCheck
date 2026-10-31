import http from "node:http";

import { config } from "./config.js";

/**
 * Small OpenAI-compatible gateway in front of NVIDIA NIM.
 *
 * The headless worker is the only caller. It exists because NIM's free tier:
 *   - throws episodic HTTP 500s (a single one must not kill an 18-step run),
 *   - sometimes returns the answer in `reasoning_content` with empty `content`,
 *   - has an unpublished per-minute budget.
 *
 * Retry, normalisation and the token bucket live here so dsh, phase0 and any
 * future extraction client share one implementation. The interactive ACP
 * sidebar never talks to this service.
 */

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface NimGateway {
  url: string;
  close(): Promise<void>;
}

interface StartOptions {
  port?: number;
  upstreamUrl?: string;
  apiKey?: string;
  rpm?: number;
  retries?: number;
  requestTimeoutMs?: number;
  quiet?: boolean;
}

let activeGateway: NimGateway | null = null;

/** Start (or reuse) the local gateway. No-op when the provider is DeepSeek. */
export async function startNimGateway(
  options: StartOptions = {},
): Promise<NimGateway | null> {
  if (config.llmProvider === "deepseek") return null;
  const port = options.port ?? config.nimGatewayPort;
  if (activeGateway) {
    // A shared gateway may have been closed by the worker that owned it.
    if (await probe(port).catch(() => false)) return activeGateway;
    activeGateway = null;
  }

  const upstreamUrl = (options.upstreamUrl ?? config.nimBaseUrl).replace(/\/+$/, "");
  const apiKey = options.apiKey ?? config.nvidiaApiKey;
  if (!apiKey) {
    throw new Error(
      "NVIDIA_API_KEY is required for the headless NIM gateway; set it or add NVIDIA_API_KEY.txt",
    );
  }
  const rpm = options.rpm ?? config.nimRpm;
  const retries = options.retries ?? config.nimRetries;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? config.nimRequestTimeoutMs;
  const quiet = options.quiet ?? false;

  const limiter = createRateLimiter(rpm);
  const server = http.createServer((req, res) => {
    void handle(req, res, {
      upstreamUrl,
      apiKey,
      limiter,
      retries,
      requestTimeoutMs,
      quiet,
    });
  });

  await listen(server, port).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EADDRINUSE") throw error;
    // A previous worker already owns the port; reuse it if it is our gateway.
    const healthy = await probe(port).catch(() => false);
    if (!healthy) {
      throw new Error(
        `port ${port} is in use but does not answer /health; set OCC_NIM_GATEWAY_PORT`,
      );
    }
  });

  const url = `http://127.0.0.1:${port}/v1`;
  const reused = !server.listening;
  if (!quiet) {
    log({
      event: "nim_gateway_started",
      url,
      upstream: upstreamUrl,
      rpm,
      reused,
    });
  }
  activeGateway = {
    url,
    close: async () => {
      activeGateway = null;
      if (!server.listening) return;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return activeGateway;
}

/** Stop the gateway so a drained worker can exit (the HTTP server keeps the loop alive). */
export async function stopNimGateway(): Promise<void> {
  const gateway = activeGateway;
  activeGateway = null;
  if (gateway) await gateway.close();
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: {
    upstreamUrl: string;
    apiKey: string;
    limiter: () => Promise<void>;
    retries: number;
    requestTimeoutMs: number;
    quiet: boolean;
  },
): Promise<void> {
  const startedAt = Date.now();
  const path = req.url ?? "/";
  try {
    if (req.method === "GET" && (path === "/health" || path === "/v1/health")) {
      return json(res, 200, { ok: true, service: "occ-nim-gateway" });
    }
    if (req.method === "GET" && path === "/v1/models") {
      await ctx.limiter();
      const upstream = await fetch(`${ctx.upstreamUrl}/models`, {
        headers: { authorization: `Bearer ${ctx.apiKey}` },
        signal: AbortSignal.timeout(30_000),
      });
      const body = await upstream.text();
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      });
      res.end(body);
      return;
    }
    if (req.method !== "POST" || path !== "/v1/chat/completions") {
      return json(res, 404, { error: { message: `unknown path ${path}` } });
    }

    const raw = await readBody(req);
    const payload = JSON.parse(raw) as {
      stream?: boolean;
      model?: string;
      max_tokens?: number;
    };
    const isStream = payload.stream === true;
    let lastBody = "";
    let lastStatus = 502;

    for (let attempt = 1; attempt <= ctx.retries; attempt += 1) {
      await ctx.limiter();
      const upstream = await fetch(`${ctx.upstreamUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ctx.apiKey}`,
        },
        body: raw,
        signal: AbortSignal.timeout(ctx.requestTimeoutMs),
      }).catch((error: unknown) => {
        lastStatus = 502;
        lastBody = `upstream fetch failed: ${messageOf(error)}`;
        return null;
      });

      if (!upstream) {
        if (attempt < ctx.retries) {
          await backoff(attempt);
          continue;
        }
        break;
      }

      lastStatus = upstream.status;
      if (!upstream.ok) {
        lastBody = await upstream.text();
        if (isRetryableStatus(upstream.status) && attempt < ctx.retries) {
          await backoff(attempt);
          continue;
        }
        res.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") ?? "application/json",
        });
        res.end(lastBody);
        logOutcome(startedAt, payload, upstream.status, attempt, ctx.quiet);
        return;
      }

      if (isStream) {
        res.writeHead(upstream.status, {
          "content-type":
            upstream.headers.get("content-type") ?? "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        if (!upstream.body) {
          res.end();
          return;
        }
        const reader = upstream.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
        logOutcome(startedAt, payload, upstream.status, attempt, ctx.quiet);
        return;
      }

      lastBody = await upstream.text();
      try {
        const parsed = JSON.parse(lastBody) as ChatCompletion;
        const choice = parsed.choices?.[0];
        const content = messageText(choice?.message?.content);
        const reasoning = messageText(choice?.message?.reasoning_content);
        if (!content && reasoning) {
          // NIM sometimes returns structured/thinking output only in
          // reasoning_content. Treat it as the answer rather than retrying.
          (choice!.message as { content?: unknown }).content = reasoning;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(parsed));
          logOutcome(startedAt, payload, 200, attempt, ctx.quiet, "reasoning_content");
          return;
        }
        if (!content && choice?.finish_reason === "length" && attempt < ctx.retries) {
          // The token budget was consumed by thinking; retrying at least gives
          // the upstream another chance (callers should raise max_tokens).
          await backoff(attempt);
          continue;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(lastBody);
        logOutcome(startedAt, payload, 200, attempt, ctx.quiet);
        return;
      } catch {
        // Non-JSON success body: pass through.
        res.writeHead(200, {
          "content-type": upstream.headers.get("content-type") ?? "application/json",
        });
        res.end(lastBody);
        logOutcome(startedAt, payload, 200, attempt, ctx.quiet);
        return;
      }
    }

    res.writeHead(lastStatus, { "content-type": "application/json" });
    res.end(lastBody || JSON.stringify({ error: { message: "NIM failed" } }));
    logOutcome(startedAt, payload, lastStatus, ctx.retries, ctx.quiet);
  } catch (error) {
    json(res, 500, { error: { message: messageOf(error) } });
    log({
      event: "nim_gateway_error",
      path,
      error: messageOf(error),
      durationMs: Date.now() - startedAt,
    });
  }
}

interface ChatCompletion {
  choices?: Array<{
    message?: { content?: unknown; reasoning_content?: unknown };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) =>
        part && typeof part === "object" && "text" in part
          ? String((part as { text?: unknown }).text ?? "")
          : "",
      )
      .join("");
  }
  return "";
}

function isRetryableStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504 || status === 429;
}

function backoff(attempt: number): Promise<void> {
  const base = Math.min(8_000, 500 * 2 ** (attempt - 1));
  return new Promise((resolve) => setTimeout(resolve, base + Math.random() * 250));
}

function createRateLimiter(rpm: number): () => Promise<void> {
  const interval = rpm > 0 ? 60_000 / rpm : 0;
  let next = 0;
  return async () => {
    if (interval === 0) return;
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + interval;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  };
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function probe(port: number): Promise<boolean> {
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(1_000),
  });
  if (!response.ok) return false;
  const body = (await response.json()) as { service?: string };
  return body.service === "occ-nim-gateway";
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function logOutcome(
  startedAt: number,
  payload: { model?: string },
  status: number,
  attempts: number,
  quiet: boolean,
  note?: string,
): void {
  if (quiet) return;
  log({
    event: "nim_gateway_request",
    model: payload.model ?? null,
    status,
    attempts,
    durationMs: Date.now() - startedAt,
    ...(note ? { note } : {}),
  });
}

function log(payload: Record<string, unknown>): void {
  console.error(JSON.stringify(payload));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

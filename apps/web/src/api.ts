import type {
  CompanyCard,
  CompanyGraphView,
  CompanyHit,
  IndexView,
  SearchResponse,
} from "@occ/core";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type QueryValue = string | number | boolean | undefined | null;

function withQuery(
  path: string,
  params?: Record<string, QueryValue>,
): string {
  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function request<T>(
  path: string,
  params?: Record<string, QueryValue>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(withQuery(path, params), {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const payload = (await response.json().catch(() => null)) as
    | { error?: { code?: string; message?: string } }
    | null;
  if (!response.ok) {
    throw new ApiError(
      payload?.error?.message ?? `HTTP ${response.status}`,
      response.status,
      payload?.error?.code,
    );
  }
  return payload as T;
}

export interface SearchCompaniesParams {
  q: string;
  market?: string;
  index?: string;
  sector?: string;
  coverage?: string;
  mode?: "hybrid" | "keyword" | "semantic";
  limit?: number;
  explain?: boolean;
}

export function searchCompanies(
  params: SearchCompaniesParams,
): Promise<SearchResponse<CompanyHit>> {
  return request<SearchResponse<CompanyHit>>("/v1/search/companies", {
    q: params.q,
    market: params.market,
    index: params.index,
    sector: params.sector,
    coverage: params.coverage,
    mode: params.mode,
    limit: params.limit ?? 50,
    explain: params.explain,
  });
}

export interface CompanyCardMeta {
  request_id: string;
  as_of: string;
  took_ms: number;
  company_ref: string;
  include: string[];
}

export function getCompanyCard(
  ref: string,
  options: {
    include?: string;
    financialLimit?: number;
    factLimit?: number;
    relationLimit?: number;
    eventLimit?: number;
    relationStatus?: string;
  } = {},
): Promise<{ data: CompanyCard; meta: CompanyCardMeta }> {
  return request<{ data: CompanyCard; meta: CompanyCardMeta }>(
    `/v1/companies/${encodeURIComponent(ref)}`,
    {
      include: options.include ?? "financials,facts,relations,events",
      financial_limit: options.financialLimit ?? 200,
      fact_limit: options.factLimit ?? 200,
      relation_limit: options.relationLimit ?? 200,
      event_limit: options.eventLimit ?? 100,
      relation_status: options.relationStatus,
    },
  );
}

export interface GraphParams {
  company: string;
  depth?: 1 | 2;
  status?: string;
  types?: string;
  limit?: number;
}

export function getGraph(
  params: GraphParams,
): Promise<{ data: CompanyGraphView; meta: Record<string, unknown> }> {
  return request<{ data: CompanyGraphView; meta: Record<string, unknown> }>(
    "/v1/graph",
    {
      company: params.company,
      depth: params.depth ?? 1,
      status: params.status,
      types: params.types,
      limit: params.limit ?? 300,
    },
  );
}

export function getIndex(
  code: string,
): Promise<{ data: IndexView; meta: Record<string, unknown> }> {
  return request<{ data: IndexView; meta: Record<string, unknown> }>(
    `/v1/indices/${encodeURIComponent(code)}`,
  );
}

export function getSectors(): Promise<{ data: { sectors: string[] } }> {
  return request<{ data: { sectors: string[] } }>("/v1/sectors");
}

export interface AgentStreamEvent {
  type: string;
  [key: string]: unknown;
}

export async function createAgentSession(): Promise<{ sessionId: string }> {
  const result = await request<{ data: { sessionId: string } }>(
    "/v1/agent/sessions",
    undefined,
    { method: "POST" },
  );
  return result.data;
}

/** One tool call as rebuilt from dsh's persisted session log. */
export interface AgentReplayCall {
  callId: string;
  title: string;
  tool: string | null;
  kind: string | null;
  status: string;
  input?: unknown;
  output?: unknown;
  startedAt: number;
  endedAt?: number;
}

export interface AgentReplayTurn {
  turn: number;
  prompt: string;
  answer: string;
  status: "completed" | "failed" | "cancelled" | "running";
  startedAt: number;
  endedAt?: number;
  calls: AgentReplayCall[];
}

export interface AgentSessionReplay {
  sessionId: string;
  title: string;
  createdAt: number;
  cwd?: string;
  turns: AgentReplayTurn[];
}

/**
 * Read a persisted dsh session. Returns 404 once the log is gone, so callers
 * can drop a stale local session id.
 */
export async function getAgentSessionReplay(
  sessionId: string,
): Promise<AgentSessionReplay> {
  const result = await request<{ data: AgentSessionReplay }>(
    `/v1/agent/sessions/${encodeURIComponent(sessionId)}/replay`,
  );
  return result.data;
}

export async function cancelAgentSession(sessionId: string): Promise<void> {
  await request(`/v1/agent/sessions/${encodeURIComponent(sessionId)}/cancel`, undefined, {
    method: "POST",
  });
}

/**
 * Reads the API's SSE stream and hands each `data:` JSON payload to `onEvent`.
 * The server writes one `event:` + `data:` frame per AgentEvent.
 */
export async function streamAgentPrompt(
  sessionId: string,
  message: string,
  onEvent: (event: AgentStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `/v1/agent/sessions/${encodeURIComponent(sessionId)}/prompt`,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ message }),
      signal,
    },
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new ApiError(
      payload?.error?.message ?? `HTTP ${response.status}`,
      response.status,
    );
  }
  if (!response.body) throw new ApiError("agent stream is empty", 502);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as AgentStreamEvent);
      } catch {
        // Ignore malformed frames; the next valid event still streams.
      }
    }
  }
}

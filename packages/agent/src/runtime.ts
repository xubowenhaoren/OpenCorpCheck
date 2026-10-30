import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

import {
  PROTOCOL_VERSION,
  client as createClient,
  methods,
  ndJsonStream,
  type ActiveSession,
  type ActiveSessionMessage,
  type AgentCapabilities,
  type ClientConnection,
  type InitializeResponse,
  type McpServerStdio,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";

import type { AgentEvent } from "./events.js";

const VERSION = "0.1.0";
const STDERR_TAIL = 8_000;
const TIMEOUT = Symbol("turn-timeout");

/**
 * Hard limits for one prompt turn.
 *
 * The tool-call limit is a runaway guard, not a research quota. A market-event
 * question legitimately fans out into one search followed by many fetches
 * (measured: 32 distinct calls, no repeats), so the budget is deliberately
 * generous and a separate repetition guard catches actual loops.
 */
export interface TurnLimits {
  /** Wall-clock limit for one turn. */
  timeoutMs: number;
  /** Tool calls allowed before the runtime stops searching. */
  maxToolCalls: number;
  /**
   * Stop once the same `(tool, kind, input)` call repeats this many times.
   * Unlike a flat call budget this does not punish a broad sweep that keeps
   * discovering new sources. `0` disables the repetition guard.
   */
  maxRepeatedToolCalls: number;
  /** Time allowed for the forced "answer from gathered evidence" follow-up. */
  followUpTimeoutMs: number;
  /** How long to wait for dsh to report `stop` after a cancel. */
  cancelGraceMs: number;
}

export const DEFAULT_TURN_LIMITS: TurnLimits = {
  timeoutMs: 180_000,
  maxToolCalls: 80,
  maxRepeatedToolCalls: 4,
  followUpTimeoutMs: 45_000,
  cancelGraceMs: 5_000,
};

/**
 * Sent as a second prompt after a limit cancel. dsh has no in-turn steering,
 * so the only way to turn partial evidence into an answer is to stop the
 * research turn and ask for a synthesis turn with tools effectively disabled.
 */
const FORCE_ANSWER_PROMPT = [
  "已达到本轮检索上限。",
  "请立即停止调用任何工具，只根据本轮对话中已经获得的资料直接回答用户的问题。",
  "保留关键数字和来源链接；没有证据的部分明确写“未验证”，不要再搜索。",
].join("\n");

type LimitReason = "tool-budget" | "repetition" | "timeout";

type SegmentOutcome =
  | { kind: "completed"; stopReason: string; response?: unknown }
  | {
      kind: "limit";
      reason: LimitReason;
      detail: string;
      toolCalls: number;
      /** dsh acknowledged the cancel with a `stop`. */
      stopped: boolean;
    };

function limitNoticeCode(reason: LimitReason): string {
  return reason === "repetition"
    ? "agent.limit.repetition"
    : reason === "timeout"
      ? "agent.limit.timeout"
      : "agent.limit.budget";
}

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface DshAcpRuntimeOptions {
  /** Working directory for the dsh session; absolute. */
  cwd: string;
  dshVersion: string;
  dshHome: string;
  npmCache: string;
  mcpServers?: McpServerSpec[];
  /** Extra environment variables for the dsh child process. */
  env?: Record<string, string>;
  /** dsh permission mode; `read-only` is the safe default. */
  permissionMode?: string;
  /** Extra dsh patch overlay (absolute path) applied after the profile layer. */
  patch?: string;
  /** Per-turn limits; omitted fields fall back to DEFAULT_TURN_LIMITS. */
  limits?: Partial<TurnLimits>;
  /** Extra args appended after `--profile acp` (rarely needed). */
  extraArgs?: string[];
}

/**
 * Spawns `dsh --profile acp` over stdio and speaks ACP as the client.
 *
 * One process can host several sessions, but the API keeps one process per
 * sidebar session for isolation and simple cancellation. All tool calls still
 * go through the `occ` MCP server attached in `session/new`.
 */
export class DshAcpRuntime {
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: ClientConnection | null = null;
  private initializeResult: InitializeResponse | null = null;
  private stderr = "";
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly busy = new Set<string>();
  private readonly permissionEvents = new Map<string, AgentEvent[]>();

  constructor(private readonly options: DshAcpRuntimeOptions) {}

  get started(): boolean {
    return this.connection !== null;
  }

  /** The `initialize` capabilities advertised by the running dsh, if any. */
  get capabilities(): AgentCapabilities | null {
    return this.initializeResult?.agentCapabilities ?? null;
  }

  /** Whether dsh explicitly advertises `session/resume`. */
  get supportsSessionResume(): boolean {
    return this.capabilities?.sessionCapabilities?.resume != null;
  }

  async start(): Promise<void> {
    if (this.connection) return;
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    const args = [
      "--yes",
      `@deepseek-ai/dsh@${this.options.dshVersion}`,
      "--profile",
      "acp",
      ...(this.options.patch ? ["--patch", this.options.patch] : []),
      ...(this.options.extraArgs ?? []),
    ];
    const child = spawn(npx, args, {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        DSH_HOME: this.options.dshHome,
        ...(this.options.permissionMode
          ? { DSH_PERMISSION_MODE: this.options.permissionMode }
          : {}),
        npm_config_cache: this.options.npmCache,
        ...this.options.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-STDERR_TAIL);
    });
    child.on("exit", () => {
      // A crashed dsh must not leave a stale connection behind; the next
      // createSession() will spawn a fresh process.
      if (this.child === child) this.child = null;
      try {
        this.connection?.close();
      } catch {
        // already closed
      }
      this.connection = null;
      this.initializeResult = null;
      this.sessions.clear();
      this.busy.clear();
    });

    const output = new WritableStream<Uint8Array>({
      write: (chunk) => {
        child.stdin.write(chunk);
      },
      close: () => {
        child.stdin.end();
      },
    });
    const input = new ReadableStream<Uint8Array>({
      start: (controller) => {
        child.stdout.on("data", (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk));
        });
        child.stdout.on("end", () => {
          try {
            controller.close();
          } catch {
            // already closed by the connection
          }
        });
        child.stdout.on("error", (error) => {
          try {
            controller.error(error);
          } catch {
            // already closed by the connection
          }
        });
      },
    });

    const app = createClient({ name: "opencorpcheck" }).onRequest(
      methods.client.session.requestPermission,
      (context) => this.handlePermission(context.params),
    );
    this.connection = app.connect(ndJsonStream(output, input));

    try {
      this.initializeResult = await this.connection.agent.request(
        methods.agent.initialize,
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "OpenCorpCheck", version: VERSION },
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const detail = this.stderr.trim();
      this.dispose();
      throw new Error(
        `dsh ACP initialization failed for ${this.options.cwd}: ${message}` +
          (detail ? `\n${detail.slice(-2_000)}` : ""),
      );
    }
  }

  async createSession(options: {
    cwd?: string;
    additionalDirectories?: string[];
  } = {}): Promise<{ sessionId: string; acpSessionId: string }> {
    await this.start();
    const connection = this.requireConnection();
    const request = {
      cwd: options.cwd ?? this.options.cwd,
      ...(options.additionalDirectories?.length
        ? { additionalDirectories: options.additionalDirectories }
        : {}),
      mcpServers: this.mcpServerSpecs(),
    };
    const active = await connection.agent.buildSession(request).start();
    this.sessions.set(active.sessionId, active);
    return { sessionId: active.sessionId, acpSessionId: active.sessionId };
  }

  /**
   * Reattach to a session dsh already persisted (after an API restart or an
   * idle dispose) so the model keeps its conversation memory and appends to
   * the same log.
   *
   * ACP's `session/resume` restores the log but does not replay updates; the
   * sidebar replays separately from `session-log.ts`. If this fails the caller
   * must fall back to `createSession()` and tell the user the context was lost.
   */
  async resumeSession(
    sessionId: string,
    options: { cwd?: string; additionalDirectories?: string[] } = {},
  ): Promise<{ sessionId: string; acpSessionId: string }> {
    // Already attached in this process: reusing it is the live path and must
    // never issue a second resume.
    if (this.sessions.has(sessionId)) {
      return { sessionId, acpSessionId: sessionId };
    }
    await this.start();
    const connection = this.requireConnection();
    // Annotated on purpose: the SDK's typed overload only infers its response
    // for contextual params; a widened object literal falls back to `unknown`.
    const request: ResumeSessionRequest = {
      sessionId,
      cwd: options.cwd ?? this.options.cwd,
      ...(options.additionalDirectories?.length
        ? { additionalDirectories: options.additionalDirectories }
        : {}),
      mcpServers: this.mcpServerSpecs(),
    };
    const response = await connection.agent.request(
      methods.agent.session.resume,
      request,
    );
    const active = this.attachResumedSession(sessionId, response);
    this.sessions.set(sessionId, active);
    return { sessionId, acpSessionId: sessionId };
  }

  private mcpServerSpecs(): McpServerStdio[] {
    return (this.options.mcpServers ?? []).map((server) => ({
      name: server.name,
      command: server.command,
      args: server.args,
      env: Object.entries(server.env ?? {}).map(([name, value]) => ({
        name,
        value,
      })),
    }));
  }

  /**
   * The stable SDK only builds update routing for `session/new` responses, so
   * reuse its private `attachSession` with the resumed id. `attachSession`
   * only reads `sessionId`; the rest is kept for `ActiveSession` accessors.
   * Confined here on purpose: re-check on any SDK upgrade.
   */
  private attachResumedSession(
    sessionId: string,
    response: ResumeSessionResponse,
  ): ActiveSession {
    const agent = this.requireConnection().agent as unknown as {
      attachSession(response: {
        sessionId: string;
        modes?: ResumeSessionResponse["modes"];
        configOptions?: ResumeSessionResponse["configOptions"];
      }): ActiveSession;
    };
    return agent.attachSession({
      sessionId,
      modes: response.modes,
      configOptions: response.configOptions,
    });
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async *prompt(sessionId: string, text: string): AsyncGenerator<AgentEvent> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown agent session: ${sessionId}`);
    if (this.busy.has(sessionId)) {
      throw new Error(`agent session is already running a prompt: ${sessionId}`);
    }
    this.busy.add(sessionId);
    const limits: TurnLimits = {
      ...DEFAULT_TURN_LIMITS,
      ...this.options.limits,
    };
    try {
      yield { type: "run.started", sessionId, prompt: text };

      let outcome = yield* this.runSegment(session, sessionId, text, {
        timeoutMs: limits.timeoutMs,
        maxToolCalls: limits.maxToolCalls,
        maxRepeatedToolCalls: limits.maxRepeatedToolCalls,
        cancelGraceMs: limits.cancelGraceMs,
      });

      if (outcome.kind === "completed") {
        yield {
          type: "run.completed",
          stopReason: outcome.stopReason,
          response: outcome.response,
        };
        return;
      }

      if (!outcome.stopped) {
        yield {
          type: "notice",
          severity: "warning",
          title: "Turn stopped",
          description: outcome.detail,
          code: "agent.limit.failed",
        };
        yield {
          type: "run.failed",
          error: outcome.detail,
          code: "agent.limit.failed",
        };
        return;
      }

      // Partial research is still useful: stop searching and ask for a
      // synthesis answer from the evidence already in context.
      yield {
        type: "notice",
        severity: "warning",
        title: "Stopped searching; answering from gathered evidence",
        description: outcome.detail,
        code: limitNoticeCode(outcome.reason),
      };

      outcome = yield* this.runSegment(session, sessionId, FORCE_ANSWER_PROMPT, {
        timeoutMs: limits.followUpTimeoutMs,
        maxToolCalls: 0,
        maxRepeatedToolCalls: 0,
        cancelGraceMs: limits.cancelGraceMs,
      });

      if (outcome.kind === "completed") {
        yield {
          type: "run.completed",
          stopReason: outcome.stopReason,
          response: outcome.response,
        };
        return;
      }

      yield {
        type: "notice",
        severity: "warning",
        title: "No answer produced",
        description: outcome.detail,
        code: "agent.limit.failed",
      };
      yield {
        type: "run.failed",
        error:
          "Stopped searching, but the model did not produce an answer. Try a narrower question.",
        code: "agent.limit.failed",
      };
    } catch (error) {
      yield {
        type: "run.failed",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.busy.delete(sessionId);
    }
  }

  /**
   * One `session/prompt` segment. Returns when dsh stops or when a limit is
   * hit; in the latter case it cancels and waits briefly for the `stop` so the
   * session is reusable for the forced-answer follow-up.
   */
  private async *runSegment(
    session: ActiveSession,
    sessionId: string,
    text: string,
    limits: {
      timeoutMs: number;
      maxToolCalls: number;
      maxRepeatedToolCalls: number;
      cancelGraceMs: number;
    },
  ): AsyncGenerator<AgentEvent, SegmentOutcome> {
    const deadline = Date.now() + limits.timeoutMs;
    const counted = new Set<string>();
    const signatures = new Map<string, number>();
    let toolCalls = 0;
    // One outstanding read at a time. A timed-out race must not leave a stale
    // waiter behind, or it would swallow the `stop` message that follows the
    // cancel and leave the session stuck.
    let pending: Promise<ActiveSessionMessage> | null = null;
    const take = (): Promise<ActiveSessionMessage> => {
      pending ??= session.nextUpdate();
      return pending;
    };
    const nextWithin = async (ms: number) => {
      const result = await raceWithTimeout(take(), ms);
      if (result !== TIMEOUT) pending = null;
      return result;
    };
    let limit: { reason: LimitReason; detail: string } | null = null;

    const response = session.prompt(text);
    // The events below carry the outcome; this only prevents an unhandled
    // rejection when we cancel the turn ourselves.
    void response.catch(() => undefined);

    for (;;) {
      for (const event of this.drainPermissionEvents(sessionId)) yield event;
      const remaining = deadline - Date.now();
      const message = remaining > 0 ? await nextWithin(remaining) : TIMEOUT;
      if (message === TIMEOUT) {
        limit = {
          reason: "timeout",
          detail: `Turn stopped after ${Math.round(
            limits.timeoutMs / 1_000,
          )}s (OCC_AGENT_TURN_TIMEOUT_MS).`,
        };
        break;
      }
      if (message.kind === "stop") {
        return {
          kind: "completed",
          stopReason: message.stopReason,
          response: message.response,
        };
      }
      const event = mapUpdate(message.update);
      if (!event) continue;
      yield event;
      if (
        event.type !== "tool.called" ||
        message.update.sessionUpdate !== "tool_call" ||
        counted.has(event.callId)
      ) {
        continue;
      }
      counted.add(event.callId);
      toolCalls += 1;
      if (toolCalls > limits.maxToolCalls) {
        limit = {
          reason: "tool-budget",
          detail: `Reached the ${limits.maxToolCalls}-step search budget (OCC_AGENT_MAX_TOOL_CALLS).`,
        };
        break;
      }
      if (limits.maxRepeatedToolCalls > 0) {
        const signature = toolSignature(message.update);
        const repeats = (signatures.get(signature) ?? 0) + 1;
        signatures.set(signature, repeats);
        if (repeats >= limits.maxRepeatedToolCalls) {
          limit = {
            reason: "repetition",
            detail: `Detected the same tool call ${repeats} times in one turn (OCC_AGENT_MAX_REPEATED_TOOL_CALLS).`,
          };
          break;
        }
      }
    }

    // Limit reached: cancel, then wait briefly for dsh to finish the turn.
    await this.cancel(sessionId).catch(() => undefined);
    let stopped = false;
    const graceDeadline = Date.now() + limits.cancelGraceMs;
    for (;;) {
      const grace = graceDeadline - Date.now();
      if (grace <= 0) break;
      const message = await nextWithin(grace);
      if (message === TIMEOUT) break;
      if (message.kind === "stop") {
        stopped = true;
        break;
      }
    }
    return {
      kind: "limit",
      reason: limit.reason,
      detail: limit.detail,
      toolCalls,
      stopped,
    };
  }

  async cancel(sessionId: string): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    await connection.agent.notify(methods.agent.session.cancel, { sessionId });
  }

  logs(): string {
    return this.stderr;
  }

  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
    this.busy.clear();
    this.permissionEvents.clear();
    try {
      this.connection?.close();
    } catch {
      // already closed
    }
    this.connection = null;
    this.initializeResult = null;
    if (this.child) {
      const child = this.child;
      this.child = null;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 3_000).unref();
    }
  }

  private requireConnection(): ClientConnection {
    if (!this.connection) {
      throw new Error("dsh ACP runtime is not started; call start() first");
    }
    return this.connection;
  }

  private handlePermission(
    permission: RequestPermissionRequest,
  ): RequestPermissionResponse {
    const option =
      permission.options.find((entry) => entry.kind === "allow_once") ??
      permission.options.find((entry) => entry.kind === "allow_always");
    const event: AgentEvent = {
      type: "permission.requested",
      callId: permission.toolCall.toolCallId,
      ...(permission.toolCall.title
        ? { title: permission.toolCall.title }
        : {}),
      option: option?.name ?? "cancelled",
    };
    const queue = this.permissionEvents.get(permission.sessionId) ?? [];
    queue.push(event);
    this.permissionEvents.set(permission.sessionId, queue);
    return option
      ? { outcome: { outcome: "selected", optionId: option.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  private drainPermissionEvents(sessionId: string): AgentEvent[] {
    const queue = this.permissionEvents.get(sessionId);
    if (!queue?.length) return [];
    this.permissionEvents.delete(sessionId);
    return queue;
  }
}

function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), Math.max(1, ms));
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Caps tool payloads before they cross the SSE seam.
 *
 * dsh can return whole fetched pages; the sidebar only needs the head of the
 * text (URLs and result lists) plus a marker that it was truncated. Shape is
 * preserved so `{content:[{type:"text",text}]}` stays recognizable, and the
 * browser never receives multi-megabyte payloads.
 */
export function summarizeToolPayload(
  value: unknown,
  maxChars = 12_000,
): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") {
    return value.length <= maxChars
      ? value
      : `${value.slice(0, maxChars)}\n…[truncated]`;
  }
  try {
    const json = JSON.stringify(value);
    if (json === undefined || json.length <= maxChars) return value;
  } catch {
    return value;
  }
  const budget = { left: maxChars };
  return truncateDeep(value, budget, 0);
}

function truncateDeep(
  value: unknown,
  budget: { left: number },
  depth: number,
): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") {
    if (budget.left <= 0) return "[truncated]";
    const take = Math.min(value.length, budget.left);
    budget.left -= take;
    return take === value.length ? value : `${value.slice(0, take)}\n…[truncated]`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => truncateDeep(item, budget, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = truncateDeep(item, budget, depth + 1);
    }
    return result;
  }
  return value;
}

/**
 * Stable key for "the model asked for exactly the same thing again".
 *
 * Object keys are sorted so an equivalent payload always hashes the same;
 * the string is capped because a tool input occasionally carries a long body.
 */
function toolSignature(
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call" }>,
): string {
  let input = "";
  try {
    input = canonicalJson(update.rawInput).slice(0, 4_000);
  } catch {
    // Circular/non-JSON payload: fall back to the title for the signature.
  }
  return [
    update.name ?? "",
    update.kind ?? "",
    input || update.title || "",
  ].join("|");
}

function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function mapUpdate(update: SessionUpdate): AgentEvent | null {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return update.content.type === "text"
        ? {
            type: "assistant.delta",
            text: update.content.text,
            messageId: update.messageId ?? null,
          }
        : { type: "session.update", update };
    case "agent_thought_chunk":
      return update.content.type === "text"
        ? {
            type: "thought.delta",
            text: update.content.text,
            messageId: update.messageId ?? null,
          }
        : { type: "session.update", update };
    case "user_message_chunk":
      return null;
    case "tool_call":
      return {
        type: "tool.called",
        callId: update.toolCallId,
        title: update.title,
        tool: update.name ?? null,
        kind: update.kind ?? null,
        status: update.status ?? null,
        input: summarizeToolPayload(update.rawInput, 4_000),
      };
    case "tool_call_update": {
      // dsh reports results as ACP `content` blocks ({type:"content",
      // content:{type:"text",text}}) and does not set `rawOutput`. Prefer the
      // raw payload when an agent sends one, otherwise forward the blocks so
      // the sidebar can show links/result counts instead of an empty card.
      const output =
        update.rawOutput !== undefined ? update.rawOutput : update.content;
      return {
        type: "tool.updated",
        callId: update.toolCallId,
        title: update.title ?? null,
        status: update.status ?? null,
        input: summarizeToolPayload(update.rawInput, 4_000),
        output: summarizeToolPayload(output, 16_000),
      };
    }
    case "plan":
      return { type: "plan", entries: update.entries };
    case "usage_update":
      return {
        type: "usage",
        used: update.used,
        size: update.size,
        ...(update.cost !== undefined ? { cost: update.cost } : {}),
      };
    case "notice":
      return {
        type: "notice",
        severity: update.severity,
        title: update.title,
        ...(update.description ? { description: update.description } : {}),
      };
    default:
      return { type: "session.update", update };
  }
}

export function defaultMcpServer(options: {
  mcpEntry: string;
  apiUrl: string;
  financeAnalystUrl?: string;
}): McpServerSpec {
  return {
    name: "occ",
    command: process.execPath,
    args: [path.resolve(options.mcpEntry)],
    env: {
      OCC_API_URL: options.apiUrl,
      ...(options.financeAnalystUrl
        ? { OCC_FINANCE_ANALYST_URL: options.financeAnalystUrl }
        : {}),
    },
  };
}

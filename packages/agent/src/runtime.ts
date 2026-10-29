import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

import {
  PROTOCOL_VERSION,
  client as createClient,
  methods,
  ndJsonStream,
  type ActiveSession,
  type ActiveSessionMessage,
  type ClientConnection,
  type McpServerStdio,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";

import type { AgentEvent } from "./events.js";

const VERSION = "0.1.0";
const STDERR_TAIL = 8_000;
const TIMEOUT = Symbol("turn-timeout");

/** Hard limits for one prompt turn. */
export interface TurnLimits {
  /** Wall-clock limit for one turn. */
  timeoutMs: number;
  /** Tool calls allowed before the runtime cancels the turn. */
  maxToolCalls: number;
  /** How long to wait for dsh to report `stop` after a cancel. */
  cancelGraceMs: number;
}

export const DEFAULT_TURN_LIMITS: TurnLimits = {
  timeoutMs: 180_000,
  maxToolCalls: 30,
  cancelGraceMs: 5_000,
};

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
  private stderr = "";
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly busy = new Set<string>();
  private readonly permissionEvents = new Map<string, AgentEvent[]>();

  constructor(private readonly options: DshAcpRuntimeOptions) {}

  get started(): boolean {
    return this.connection !== null;
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
      await this.connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "OpenCorpCheck", version: VERSION },
      });
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
    const mcpServers: McpServerStdio[] = (this.options.mcpServers ?? []).map(
      (server) => ({
        name: server.name,
        command: server.command,
        args: server.args,
        env: Object.entries(server.env ?? {}).map(([name, value]) => ({
          name,
          value,
        })),
      }),
    );
    const request = {
      cwd: options.cwd ?? this.options.cwd,
      ...(options.additionalDirectories?.length
        ? { additionalDirectories: options.additionalDirectories }
        : {}),
      mcpServers,
    };
    const active = await connection.agent.buildSession(request).start();
    this.sessions.set(active.sessionId, active);
    return { sessionId: active.sessionId, acpSessionId: active.sessionId };
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
    const deadline = Date.now() + limits.timeoutMs;
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
    let limitHit: { title: string; message: string } | null = null;
    try {
      yield { type: "run.started", sessionId, prompt: text };
      const response = session.prompt(text);
      // The events below carry the outcome; this only prevents an unhandled
      // rejection when we cancel the turn ourselves.
      void response.catch(() => undefined);

      for (;;) {
        for (const event of this.drainPermissionEvents(sessionId)) yield event;
        const remaining = deadline - Date.now();
        const message =
          remaining > 0
            ? await nextWithin(remaining)
            : TIMEOUT;
        if (message === TIMEOUT) {
          limitHit = {
            title: "Answer stopped: time limit",
            message: `Turn stopped after ${Math.round(
              limits.timeoutMs / 1000,
            )}s (OCC_AGENT_TURN_TIMEOUT_MS). Ask a narrower question or raise the limit.`,
          };
          break;
        }
        if (message.kind === "stop") {
          yield {
            type: "run.completed",
            stopReason: message.stopReason,
            response: message.response,
          };
          return;
        }
        const event = mapUpdate(message.update);
        if (!event) continue;
        yield event;
        if (event.type === "tool.called") {
          toolCalls += 1;
          if (toolCalls > limits.maxToolCalls) {
            limitHit = {
              title: "Answer stopped: tool-call limit",
              message: `Turn stopped after ${limits.maxToolCalls} tool calls to avoid an endless loop (OCC_AGENT_MAX_TOOL_CALLS).`,
            };
            break;
          }
        }
      }

      // Limit reached: cancel, then wait briefly for dsh to finish the turn.
      await this.cancel(sessionId).catch(() => undefined);
      const graceDeadline = Date.now() + limits.cancelGraceMs;
      for (;;) {
        const grace = graceDeadline - Date.now();
        if (grace <= 0) break;
        const message = await nextWithin(grace);
        if (message === TIMEOUT || message.kind === "stop") break;
      }
      yield {
        type: "notice",
        severity: "warning",
        title: limitHit.title,
      };
      yield { type: "run.failed", error: limitHit.message };
    } catch (error) {
      yield {
        type: "run.failed",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.busy.delete(sessionId);
    }
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

function mapUpdate(update: SessionUpdate): AgentEvent | null {
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
        input: update.rawInput,
      };
    case "tool_call_update":
      return {
        type: "tool.updated",
        callId: update.toolCallId,
        title: update.title ?? null,
        status: update.status ?? null,
        input: update.rawInput,
        output: update.rawOutput,
      };
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

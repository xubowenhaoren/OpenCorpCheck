import fs from "node:fs";

import { AppError } from "@occ/core";
import {
  DshAcpRuntime,
  defaultMcpServer,
  findSessionLog,
  type AgentEvent,
  type McpServerSpec,
} from "@occ/agent";

const SYSTEM_CONTEXT = [
  "你正在 OpenCorpCheck 的公司情报侧栏中回答用户问题。",
  "优先使用 occ MCP 工具查内部数据库：search_companies、get_company、search_documents；",
  "需要新研究或刷新 profile 时调用 deep_research，然后用 get_run 轮询进度。",
  "外部事实用 web_search / web_fetch，并给出来源 URL。",
  "关系数据若 status=inferred，必须标注为未审核的机器抽取，不得当作已确认事实。",
  "所有数字和关系都要带引用；没有证据就明确说没有。",
].join("\n");

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;

export interface AgentServiceOptions {
  apiUrl: string;
  repoRoot: string;
  dshVersion: string;
  dshHome: string;
  npmCache: string;
  mcpEntry: string;
  financeAnalystUrl?: string;
  deepseekApiKey?: string;
  permissionMode?: string;
  enabled?: boolean;
  /** dsh patch overlay applied to the ACP profile (absolute path). */
  dshPatch?: string;
  /** Wall-clock limit for one prompt turn. */
  turnTimeoutMs?: number;
  /** Tool calls allowed before the runtime cancels a turn. */
  maxToolCalls?: number;
  /** Abort when the same tool call repeats this many times; 0 disables. */
  maxRepeatedToolCalls?: number;
  /** Dispose the dsh process after this much idle time; 0 disables. */
  idleTimeoutMs?: number;
}

/**
 * Owns the dsh ACP process for the local sidebar. Sessions are isolated; a
 * cancelled or failed session never takes down the API.
 *
 * The runtime is disposed after it has been idle for `idleTimeoutMs`, so a
 * forgotten sidebar does not keep a dsh process (and its MCP child) alive. The
 * UI keeps using the session id it was given; the next prompt resumes the
 * persisted dsh session when possible (same id, same log, same memory) and
 * only falls back to a fresh session when there is no log or resume fails.
 */
export class AgentService {
  private runtime: DshAcpRuntime | null = null;
  /** UI-facing session id → live dsh session id (they differ after a restart). */
  private readonly aliases = new Map<string, string>();
  private activePrompts = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: AgentServiceOptions) {}

  async createSession(): Promise<{ sessionId: string }> {
    if (this.options.enabled === false) {
      throw new AppError(
        "bad_request",
        "agent sidebar is disabled (OCC_AGENT_ENABLED=false)",
      );
    }
    if (!this.options.deepseekApiKey) {
      throw new AppError(
        "upstream_error",
        "DEEPSEEK_API_KEY is missing; export it or put it in phase0/.env (or DEEPSEEK_API_KEY.txt) before using the agent sidebar",
      );
    }
    const runtime = await this.ensureRuntime();
    try {
      const { sessionId } = await runtime.createSession();
      this.aliases.set(sessionId, sessionId);
      this.clearIdleTimer();
      this.scheduleIdleDispose();
      return { sessionId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const tail = runtime.logs().trim().slice(-2_000);
      throw new AppError(
        "upstream_error",
        `failed to create dsh ACP session: ${message}` +
          (tail ? `\n${tail}` : ""),
      );
    }
  }

  async *prompt(
    sessionId: string,
    message: string,
  ): AsyncGenerator<AgentEvent> {
    const runtime = await this.ensureRuntime();
    // Count the prompt before any await (log lookup / resume) so the idle
    // disposer cannot kill the runtime while we are reattaching it.
    this.clearIdleTimer();
    this.activePrompts += 1;
    try {
      let target = this.resolveSession(sessionId);
      let contextResetReason: string | null = null;
      if (!target) {
        // The idle disposer, a crashed child or an API restart dropped the live
        // session. If dsh persisted a log for this id, resume it so the model
        // keeps its memory and appends to the same log; otherwise start fresh.
        const log = await findSessionLog(this.options.dshHome, sessionId);
        if (log) {
          try {
            target = (await runtime.resumeSession(sessionId)).sessionId;
            this.aliases.set(sessionId, sessionId);
          } catch (error) {
            contextResetReason =
              error instanceof Error ? error.message : String(error);
          }
        }
        if (!target) {
          try {
            target = (await runtime.createSession()).sessionId;
          } catch (error) {
            const detail =
              error instanceof Error ? error.message : String(error);
            throw new AppError(
              "upstream_error",
              `failed to restart dsh ACP session: ${detail}`,
            );
          }
          this.aliases.set(target, target);
          this.aliases.set(sessionId, target);
        }
      }
      if (contextResetReason !== null) {
        // Resume was attempted and failed: say so instead of silently
        // pretending the previous conversation is still in context. The web
        // renders this code as a highlighted warning box.
        yield {
          type: "notice",
          severity: "warning",
          title: "Previous conversation context was not restored",
          description:
            "The saved transcript is still visible, but the model could not " +
            `resume its memory and started a new conversation. ${contextResetReason}`,
          code: "agent.resume.failed",
        };
      }
      yield* runtime.prompt(
        target,
        `${SYSTEM_CONTEXT}\n\n用户问题：${message}`,
      );
    } finally {
      this.activePrompts -= 1;
      this.scheduleIdleDispose();
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    await runtime.cancel(this.resolveSession(sessionId) ?? sessionId);
  }

  async dispose(): Promise<void> {
    this.clearIdleTimer();
    this.aliases.clear();
    // Detach first: a prompt arriving while the child is shutting down must
    // spawn a fresh runtime instead of racing this one to null.
    const runtime = this.runtime;
    this.runtime = null;
    await runtime?.dispose();
  }

  logs(): string {
    return this.runtime?.logs() ?? "";
  }

  private resolveSession(sessionId: string): string | null {
    const runtime = this.runtime;
    if (!runtime?.started) return null;
    if (runtime.hasSession(sessionId)) return sessionId;
    const alias = this.aliases.get(sessionId);
    return alias && runtime.hasSession(alias) ? alias : null;
  }

  private scheduleIdleDispose(): void {
    const timeout = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.clearIdleTimer();
    if (timeout <= 0 || this.activePrompts > 0 || !this.runtime) return;
    const timer = setTimeout(() => {
      this.idleTimer = null;
      if (this.activePrompts > 0) return;
      void this.dispose();
    }, timeout);
    timer.unref?.();
    this.idleTimer = timer;
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private async ensureRuntime(): Promise<DshAcpRuntime> {
    if (this.runtime?.started) return this.runtime;
    if (this.runtime) {
      // The dsh child exited; dispose the stale handle before respawning.
      const stale = this.runtime;
      this.runtime = null;
      this.aliases.clear();
      await stale.dispose();
    }
    if (this.options.enabled === false) {
      throw new AppError(
        "bad_request",
        "agent sidebar is disabled (OCC_AGENT_ENABLED=false)",
      );
    }
    const apiKey = this.options.deepseekApiKey;
    if (!apiKey) {
      throw new AppError(
        "upstream_error",
        "DEEPSEEK_API_KEY is missing; cannot start the dsh ACP runtime",
      );
    }
    fs.mkdirSync(this.options.dshHome, { recursive: true });
    fs.mkdirSync(this.options.npmCache, { recursive: true });
    const mcpServers: McpServerSpec[] = [
      defaultMcpServer({
        mcpEntry: this.options.mcpEntry,
        apiUrl: this.options.apiUrl,
        ...(this.options.financeAnalystUrl
          ? { financeAnalystUrl: this.options.financeAnalystUrl }
          : {}),
      }),
    ];
    const runtime = new DshAcpRuntime({
      cwd: this.options.repoRoot,
      dshVersion: this.options.dshVersion,
      dshHome: this.options.dshHome,
      npmCache: this.options.npmCache,
      mcpServers,
      permissionMode: this.options.permissionMode ?? "read-only",
      ...(this.options.dshPatch ? { patch: this.options.dshPatch } : {}),
      limits: {
        ...(this.options.turnTimeoutMs !== undefined
          ? { timeoutMs: this.options.turnTimeoutMs }
          : {}),
        ...(this.options.maxToolCalls !== undefined
          ? { maxToolCalls: this.options.maxToolCalls }
          : {}),
        ...(this.options.maxRepeatedToolCalls !== undefined
          ? { maxRepeatedToolCalls: this.options.maxRepeatedToolCalls }
          : {}),
      },
      env: { DEEPSEEK_API_KEY: apiKey },
    });
    await runtime.start();
    this.runtime = runtime;
    return runtime;
  }
}

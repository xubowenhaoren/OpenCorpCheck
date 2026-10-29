import fs from "node:fs";

import { AppError } from "@occ/core";
import {
  DshAcpRuntime,
  defaultMcpServer,
  type AgentEvent,
  type McpServerSpec,
} from "@occ/agent";

import { config } from "../config.js";

const SYSTEM_CONTEXT = [
  "你正在 OpenCorpCheck 的公司情报侧栏中回答用户问题。",
  "优先使用 occ MCP 工具查内部数据库：search_companies、get_company、search_documents；",
  "需要新研究或刷新 profile 时调用 deep_research，然后用 get_run 轮询进度。",
  "外部事实用 web_search / web_fetch，并给出来源 URL。",
  "关系数据若 status=inferred，必须标注为未审核的机器抽取，不得当作已确认事实。",
  "所有数字和关系都要带引用；没有证据就明确说没有。",
].join("\n");

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
}

/**
 * Owns one dsh ACP process for the local sidebar. Sessions are isolated; a
 * cancelled or failed session never takes down the API.
 */
export class AgentService {
  private runtime: DshAcpRuntime | null = null;
  private readonly sessions = new Set<string>();

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
      this.sessions.add(sessionId);
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
    if (!this.runtime || !this.sessions.has(sessionId)) {
      throw new AppError("not_found", `agent session not found: ${sessionId}`);
    }
    yield* this.runtime.prompt(
      sessionId,
      `${SYSTEM_CONTEXT}\n\n用户问题：${message}`,
    );
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.runtime) return;
    await this.runtime.cancel(sessionId);
  }

  async dispose(): Promise<void> {
    this.sessions.clear();
    await this.runtime?.dispose();
    this.runtime = null;
  }

  logs(): string {
    return this.runtime?.logs() ?? "";
  }

  private async ensureRuntime(): Promise<DshAcpRuntime> {
    if (this.runtime?.started) return this.runtime;
    if (this.runtime) {
      // The dsh child exited; dispose the stale handle before respawning.
      await this.runtime.dispose();
      this.runtime = null;
      this.sessions.clear();
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
      env: { DEEPSEEK_API_KEY: apiKey },
    });
    await runtime.start();
    this.runtime = runtime;
    return runtime;
  }
}

/**
 * Helpers for restoring a dsh session into the sidebar.
 *
 * The API replays dsh's persisted log; this module only adapts it to the
 * message/tool-call shapes the live SSE stream produces, so the existing
 * trajectory card renders history exactly like a finished live turn.
 */
import type { AgentReplayTurn } from "../api";
import type { AgentToolCall } from "./agent-trace";

export const AGENT_SESSION_STORAGE_KEY = "occ.agent.sessionId";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readStoredAgentSession(): string | null {
  try {
    return storage()?.getItem(AGENT_SESSION_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function storeAgentSession(sessionId: string): void {
  try {
    storage()?.setItem(AGENT_SESSION_STORAGE_KEY, sessionId);
  } catch {
    // Private mode or blocked storage: replay is optional.
  }
}

export function clearStoredAgentSession(): void {
  try {
    storage()?.removeItem(AGENT_SESSION_STORAGE_KEY);
  } catch {
    // Ignore.
  }
}

/**
 * The API prefixes every prompt with its system context and the web UI adds
 * a company line before the question. The bubble only shows the question.
 */
export function stripReplayPrompt(prompt: string): string {
  return prompt
    .replace(/^(?:当前公司：|Current company:)[^\n]*\n+/u, "")
    .trim();
}

export function replayToolCalls(turn: AgentReplayTurn): AgentToolCall[] {
  return turn.calls.map((call) => ({
    callId: call.callId,
    title: call.title,
    tool: call.tool,
    kind: call.kind,
    status: call.status,
    input: call.input,
    output: call.output,
    startedAt: call.startedAt || turn.startedAt,
    ...(call.endedAt ? { endedAt: call.endedAt } : {}),
  }));
}

export function replayElapsedMs(turn: AgentReplayTurn): number | undefined {
  if (!turn.endedAt || !turn.startedAt) return undefined;
  return Math.max(turn.endedAt - turn.startedAt, 1);
}

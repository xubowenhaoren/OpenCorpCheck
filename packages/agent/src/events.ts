/**
 * Normalized agent events consumed by the sidebar/API.
 *
 * This is the stable seam in front of ACP: the UI never depends on raw
 * `session/update` shapes, so a dsh preview upgrade only touches the runtime.
 */
export type AgentEvent =
  | { type: "run.started"; sessionId: string; prompt: string }
  | { type: "assistant.delta"; text: string; messageId?: string | null }
  | { type: "thought.delta"; text: string; messageId?: string | null }
  | {
      type: "tool.called";
      callId: string;
      title: string;
      tool?: string | null;
      kind?: string | null;
      status?: string | null;
      input?: unknown;
    }
  | {
      type: "tool.updated";
      callId: string;
      title?: string | null;
      status?: string | null;
      input?: unknown;
      output?: unknown;
    }
  | { type: "plan"; entries: unknown[] }
  | { type: "usage"; used: number; size: number; cost?: unknown }
  | {
      type: "notice";
      severity: string;
      title: string;
      description?: string;
      /** Stable code so the UI can localize runtime-generated notices. */
      code?: string;
    }
  | {
      type: "permission.requested";
      callId?: string;
      title?: string;
      option: string;
    }
  | { type: "session.update"; update: unknown }
  | {
      type: "run.completed";
      stopReason: string;
      response?: unknown;
    }
  | { type: "run.failed"; error: string; code?: string };

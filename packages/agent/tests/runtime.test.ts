import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../src/events.js";
import { DshAcpRuntime } from "../src/runtime.js";

type Message =
  | { kind: "session_update"; update: Record<string, unknown> }
  | { kind: "stop"; stopReason: string; response: unknown };

interface FakeSession {
  prompt(text: string): Promise<{ stopReason: string }>;
  nextUpdate(): Promise<Message>;
}

function makeRuntime(limits: {
  timeoutMs: number;
  maxToolCalls: number;
  cancelGraceMs: number;
}): DshAcpRuntime {
  return new DshAcpRuntime({
    cwd: process.cwd(),
    dshVersion: "0.0.0-test",
    dshHome: "/tmp/occ-agent-test-home",
    npmCache: "/tmp/occ-agent-test-cache",
    limits,
  });
}

/** Bypasses start()/spawn and injects a scripted session. */
function install(runtime: DshAcpRuntime, session: FakeSession): void {
  (
    runtime as unknown as { sessions: Map<string, FakeSession> }
  ).sessions.set("s1", session);
}

async function collect(runtime: DshAcpRuntime): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of runtime.prompt("s1", "hello")) events.push(event);
  return events;
}

describe("DshAcpRuntime turn limits", () => {
  it("cancels a turn that exceeds the tool-call budget", async () => {
    let calls = 0;
    const runtime = makeRuntime({
      timeoutMs: 5_000,
      maxToolCalls: 3,
      cancelGraceMs: 5,
    });
    install(runtime, {
      prompt: async () => ({ stopReason: "end_turn" }),
      nextUpdate: async () => ({
        kind: "session_update",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: `call_${++calls}`,
          title: "web_search",
          status: "pending",
        },
      }),
    });

    const events = await collect(runtime);

    expect(events.filter((event) => event.type === "tool.called")).toHaveLength(
      4,
    );
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      error: expect.stringContaining("tool calls"),
    });
  });

  it("cancels a turn that exceeds the timeout", async () => {
    const runtime = makeRuntime({
      timeoutMs: 40,
      maxToolCalls: 10,
      cancelGraceMs: 10,
    });
    install(runtime, {
      prompt: async () => ({ stopReason: "end_turn" }),
      nextUpdate: () => new Promise<Message>(() => {}),
    });

    const started = Date.now();
    const events = await collect(runtime);

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      error: expect.stringContaining("Turn stopped after"),
    });
  });

  it("streams updates and completes when dsh stops normally", async () => {
    const runtime = makeRuntime({
      timeoutMs: 5_000,
      maxToolCalls: 10,
      cancelGraceMs: 5,
    });
    const queue: Message[] = [
      {
        kind: "session_update",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hi" },
          messageId: "m1",
        },
      },
      { kind: "stop", stopReason: "end_turn", response: { stopReason: "end_turn" } },
    ];
    install(runtime, {
      prompt: async () => ({ stopReason: "end_turn" }),
      nextUpdate: async () => {
        const message = queue.shift();
        if (!message) throw new Error("no more scripted messages");
        return message;
      },
    });

    const events = await collect(runtime);

    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "assistant.delta",
      "run.completed",
    ]);
  });
});

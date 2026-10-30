import { describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "../src/events.js";
import { DshAcpRuntime, mapUpdate, summarizeToolPayload } from "../src/runtime.js";

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
  maxRepeatedToolCalls: number;
  followUpTimeoutMs: number;
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
      maxRepeatedToolCalls: 0,
      followUpTimeoutMs: 50,
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
      error: expect.stringContaining("search budget"),
    });
  });

  it("does not stop a broad sweep of distinct calls", async () => {
    let calls = 0;
    const runtime = makeRuntime({
      timeoutMs: 5_000,
      maxToolCalls: 80,
      maxRepeatedToolCalls: 4,
      followUpTimeoutMs: 50,
      cancelGraceMs: 5,
    });
    const queue: Message[] = [];
    for (let index = 0; index < 32; index += 1) {
      queue.push({
        kind: "session_update",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: `call_${++calls}`,
          name: index % 3 === 0 ? "web_search" : "web_fetch",
          title: index % 3 === 0 ? "web_search" : "web_fetch",
          kind: index % 3 === 0 ? "search" : "fetch",
          rawInput: { url: `https://example.com/${index}` },
          status: "pending",
        },
      });
    }
    queue.push({ kind: "stop", stopReason: "end_turn", response: {} });
    install(runtime, {
      prompt: async () => ({ stopReason: "end_turn" }),
      nextUpdate: async () => {
        const message = queue.shift();
        if (!message) throw new Error("no more scripted messages");
        return message;
      },
    });

    const events = await collect(runtime);

    expect(events.filter((event) => event.type === "tool.called")).toHaveLength(
      32,
    );
    expect(events.at(-1)).toMatchObject({ type: "run.completed" });
  });

  it("stops genuine repeats early, then asks for an answer without tools", async () => {
    const prompts: string[] = [];
    const repeated = {
      sessionUpdate: "tool_call" as const,
      toolCallId: "call_same",
      name: "web_search",
      title: "web_search",
      kind: "search",
      rawInput: { queries: ["goog stock drop"] },
      status: "pending",
    };
    const queue: Message[] = [
      { kind: "session_update", update: repeated },
      { kind: "session_update", update: { ...repeated, toolCallId: "call_2" } },
      { kind: "session_update", update: { ...repeated, toolCallId: "call_3" } },
      { kind: "stop", stopReason: "cancelled", response: {} },
      {
        kind: "session_update",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "已根据现有资料作答。" },
          messageId: "m1",
        },
      },
      { kind: "stop", stopReason: "end_turn", response: {} },
    ];
    const runtime = makeRuntime({
      timeoutMs: 5_000,
      maxToolCalls: 80,
      maxRepeatedToolCalls: 3,
      followUpTimeoutMs: 500,
      cancelGraceMs: 100,
    });
    install(runtime, {
      prompt: async (text) => {
        prompts.push(text);
        return { stopReason: "end_turn" };
      },
      nextUpdate: async () => {
        const message = queue.shift();
        if (!message) throw new Error("no more scripted messages");
        return message;
      },
    });

    const events = await collect(runtime);

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("停止调用任何工具");
    expect(events.filter((event) => event.type === "tool.called")).toHaveLength(
      3,
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "notice", code: "agent.limit.repetition" }),
    );
    expect(events.at(-1)).toMatchObject({ type: "run.completed" });
    expect(events.some((event) => event.type === "run.failed")).toBe(false);
  });

  it("cancels a turn that exceeds the timeout", async () => {
    const runtime = makeRuntime({
      timeoutMs: 40,
      maxToolCalls: 10,
      maxRepeatedToolCalls: 0,
      followUpTimeoutMs: 50,
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
      maxRepeatedToolCalls: 0,
      followUpTimeoutMs: 50,
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

describe("DshAcpRuntime resumeSession", () => {
  function makeResumeRuntime() {
    const runtime = new DshAcpRuntime({
      cwd: "/repo",
      dshVersion: "0.0.0-test",
      dshHome: "/tmp/occ-agent-test-home",
      npmCache: "/tmp/occ-agent-test-cache",
      mcpServers: [
        {
          name: "occ",
          command: "node",
          args: ["/repo/apps/cli/dist/mcp.js"],
          env: { OCC_API_URL: "http://127.0.0.1:8787" },
        },
      ],
    });
    const request = vi.fn(async () => ({ modes: null, configOptions: null }));
    const attachSession = vi.fn((response: { sessionId: string }) => ({
      sessionId: response.sessionId,
      dispose: () => undefined,
    }));
    (
      runtime as unknown as { connection: unknown }
    ).connection = {
      agent: { request, attachSession },
      close: () => undefined,
    };
    return { runtime, request, attachSession };
  }

  it("resumes with the same cwd and MCP servers, then routes updates", async () => {
    const { runtime, request, attachSession } = makeResumeRuntime();

    const result = await runtime.resumeSession("saved-1");

    expect(request).toHaveBeenCalledTimes(1);
    const [method, params] = request.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(method).toBe("session/resume");
    expect(params).toMatchObject({
      sessionId: "saved-1",
      cwd: "/repo",
      mcpServers: [
        {
          name: "occ",
          command: "node",
          args: ["/repo/apps/cli/dist/mcp.js"],
          env: [{ name: "OCC_API_URL", value: "http://127.0.0.1:8787" }],
        },
      ],
    });
    // The response has no sessionId; the requested id must be attached.
    expect(attachSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "saved-1" }),
    );
    expect(runtime.hasSession("saved-1")).toBe(true);
    expect(result).toEqual({ sessionId: "saved-1", acpSessionId: "saved-1" });
  });

  it("does not resume the same session twice", async () => {
    const { runtime, request } = makeResumeRuntime();

    await runtime.resumeSession("saved-1");
    await runtime.resumeSession("saved-1");

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("reports the advertised resume capability", () => {
    const { runtime } = makeResumeRuntime();
    const holder = runtime as unknown as { initializeResult: unknown };

    expect(runtime.supportsSessionResume).toBe(false);
    holder.initializeResult = {
      agentCapabilities: { sessionCapabilities: { resume: {} } },
    };
    expect(runtime.supportsSessionResume).toBe(true);
    holder.initializeResult = { agentCapabilities: { sessionCapabilities: {} } };
    expect(runtime.supportsSessionResume).toBe(false);
  });
});

describe("summarizeToolPayload", () => {
  it("keeps small payloads untouched", () => {
    const payload = { content: [{ type: "text", text: "ok" }] };
    expect(summarizeToolPayload(payload)).toBe(payload);
  });

  it("caps long MCP text while preserving the content shape", () => {
    const payload = {
      content: [{ type: "text", text: "x".repeat(100_000) }],
      isError: false,
    };
    const summary = summarizeToolPayload(payload, 1_000) as {
      content: { type: string; text: string }[];
      isError: boolean;
    };
    expect(summary.content[0].type).toBe("text");
    expect(summary.content[0].text.length).toBeLessThan(1_100);
    expect(summary.content[0].text).toContain("truncated");
    expect(summary.isError).toBe(false);
  });

  it("truncates plain strings", () => {
    expect(summarizeToolPayload("a".repeat(50), 10)).toBe(
      `${"a".repeat(10)}\n…[truncated]`,
    );
  });
});

describe("mapUpdate", () => {
  const resultContent = [
    {
      type: "content" as const,
      content: { type: "text" as const, text: "Sources: [A](https://a.test/x)" },
    },
  ];

  it("forwards ACP content blocks as tool output when rawOutput is absent", () => {
    const event = mapUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
      content: resultContent,
    } as never);
    expect(event).toMatchObject({
      type: "tool.updated",
      callId: "call_1",
      status: "completed",
      output: resultContent,
    });
  });

  it("prefers rawOutput when the agent sends it", () => {
    const event = mapUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_2",
      status: "completed",
      rawOutput: { content: [{ type: "text", text: "raw" }] },
      content: resultContent,
    } as never);
    expect(event).toMatchObject({
      output: { content: [{ type: "text", text: "raw" }] },
    });
  });
});

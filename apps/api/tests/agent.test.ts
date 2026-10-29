import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentService } from "../src/services/agent.js";

interface FakeRuntimeState {
  disposed: boolean;
  prompted: string[];
  cancelled: string[];
}

function fakeRuntime(): {
  runtime: unknown;
  state: FakeRuntimeState;
  live: Set<string>;
} {
  const live = new Set<string>();
  const state: FakeRuntimeState = {
    disposed: false,
    prompted: [],
    cancelled: [],
  };
  let counter = 0;
  const runtime = {
    get started(): boolean {
      return !state.disposed;
    },
    hasSession: (id: string): boolean => live.has(id),
    createSession: async () => {
      const id = `s${++counter}`;
      live.add(id);
      return { sessionId: id, acpSessionId: id };
    },
    async *prompt(sessionId: string) {
      state.prompted.push(sessionId);
      yield { type: "run.started" as const, sessionId, prompt: "p" };
      yield { type: "run.completed" as const, stopReason: "end_turn" };
    },
    cancel: async (id: string) => {
      state.cancelled.push(id);
    },
    dispose: async () => {
      state.disposed = true;
      live.clear();
    },
    logs: () => "",
  };
  return { runtime, state, live };
}

function attach(service: AgentService, runtime: unknown): void {
  (service as unknown as { runtime: unknown }).runtime = runtime;
}

function currentRuntime(service: AgentService): unknown {
  return (service as unknown as { runtime: unknown }).runtime;
}

function makeService(
  overrides: Partial<ConstructorParameters<typeof AgentService>[0]> = {},
): AgentService {
  return new AgentService({
    apiUrl: "http://127.0.0.1:8787",
    repoRoot: process.cwd(),
    dshVersion: "0.0.0-test",
    dshHome: "/tmp/occ-api-agent-test-home",
    npmCache: "/tmp/occ-api-agent-test-cache",
    mcpEntry: "/tmp/occ-api-agent-test-mcp.js",
    deepseekApiKey: "test-key",
    enabled: true,
    idleTimeoutMs: 0,
    ...overrides,
  });
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of iterable) {
    // consume
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentService", () => {
  it("disposes the dsh runtime after an idle period", async () => {
    vi.useFakeTimers();
    const service = makeService({ idleTimeoutMs: 1_000 });
    const { runtime, state } = fakeRuntime();
    attach(service, runtime);

    await service.createSession();
    expect(state.disposed).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(state.disposed).toBe(true);
    expect(currentRuntime(service)).toBeNull();
  });

  it("keeps the runtime while a prompt is running", async () => {
    vi.useFakeTimers();
    const service = makeService({ idleTimeoutMs: 1_000 });
    const { runtime, state } = fakeRuntime();
    attach(service, runtime);
    await service.createSession();

    await vi.advanceTimersByTimeAsync(500);
    await drain(service.prompt("s1", "question"));
    await vi.advanceTimersByTimeAsync(500);

    expect(state.disposed).toBe(false);
    expect(currentRuntime(service)).toBe(runtime);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.disposed).toBe(true);
  });

  it("routes an old session id to a fresh session when dsh dropped it", async () => {
    const service = makeService();
    const { runtime, state, live } = fakeRuntime();
    attach(service, runtime);

    await service.createSession(); // s1
    await drain(service.prompt("s1", "first"));
    live.clear(); // dsh restarted and lost the session
    await drain(service.prompt("s1", "second"));
    await drain(service.prompt("s1", "third"));

    expect(state.prompted).toEqual(["s1", "s2", "s2"]);
  });

  it("cancels the live session behind an aliased id", async () => {
    const service = makeService();
    const { runtime, state, live } = fakeRuntime();
    attach(service, runtime);

    await service.createSession(); // s1
    live.clear();
    await drain(service.prompt("s1", "first")); // creates s2, alias s1 -> s2
    await service.cancel("s1");

    expect(state.cancelled).toEqual(["s2"]);
  });
});

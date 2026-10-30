import { afterEach, describe, expect, it, vi } from "vitest";

import { findSessionLog } from "@occ/agent";

import { AgentService } from "../src/services/agent.js";

// The service asks dsh's own log store whether a session can be resumed. The
// tests drive that decision instead of touching a real DSH_HOME.
vi.mock("@occ/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@occ/agent")>();
  return { ...actual, findSessionLog: vi.fn(async () => null) };
});

interface FakeRuntimeState {
  disposed: boolean;
  prompted: string[];
  cancelled: string[];
  resumed: string[];
  resumeFails: boolean;
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
    resumed: [],
    resumeFails: false,
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
    resumeSession: async (id: string) => {
      state.resumed.push(id);
      if (state.resumeFails) throw new Error("resume blew up");
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

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(findSessionLog).mockReset();
  vi.mocked(findSessionLog).mockResolvedValue(null);
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

  it("resumes a persisted session instead of starting a new one", async () => {
    vi.mocked(findSessionLog).mockResolvedValue("/tmp/dsh/log");
    const service = makeService();
    const { runtime, state, live } = fakeRuntime();
    attach(service, runtime);
    await service.createSession(); // s1
    live.clear(); // API restart / idle dispose dropped the live session

    const events = await collect(service.prompt("s1", "follow-up"));

    expect(state.resumed).toEqual(["s1"]);
    expect(state.prompted).toEqual(["s1"]);
    expect(events.some((event) => eventType(event) === "notice")).toBe(false);
  });

  it("starts a fresh session when no persisted log exists", async () => {
    const service = makeService();
    const { runtime, state, live } = fakeRuntime();
    attach(service, runtime);
    await service.createSession(); // s1
    live.clear();

    await drain(service.prompt("s1", "follow-up"));

    expect(state.resumed).toEqual([]);
    expect(state.prompted).toEqual(["s2"]);
  });

  it("falls back with a highlighted notice when resume fails", async () => {
    vi.mocked(findSessionLog).mockResolvedValue("/tmp/dsh/log");
    const service = makeService();
    const { runtime, state, live } = fakeRuntime();
    state.resumeFails = true;
    attach(service, runtime);
    await service.createSession(); // s1
    live.clear();

    const events = await collect(service.prompt("s1", "follow-up"));

    expect(state.resumed).toEqual(["s1"]);
    expect(state.prompted).toEqual(["s2"]);
    expect(events[0]).toMatchObject({
      type: "notice",
      severity: "warning",
      code: "agent.resume.failed",
    });
  });

  it("never resumes a session that is still live", async () => {
    vi.mocked(findSessionLog).mockResolvedValue("/tmp/dsh/log");
    const service = makeService();
    const { runtime, state } = fakeRuntime();
    attach(service, runtime);
    await service.createSession(); // s1

    await drain(service.prompt("s1", "one"));
    await drain(service.prompt("s1", "two"));

    expect(state.resumed).toEqual([]);
    expect(state.prompted).toEqual(["s1", "s1"]);
    expect(findSessionLog).not.toHaveBeenCalled();
  });
});

function eventType(event: unknown): string | undefined {
  return typeof event === "object" && event !== null
    ? (event as { type?: string }).type
    : undefined;
}

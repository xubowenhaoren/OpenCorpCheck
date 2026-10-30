import { describe, expect, it } from "vitest";

import type { AgentReplayTurn } from "../api";
import {
  replayElapsedMs,
  replayToolCalls,
  stripReplayPrompt,
} from "./agent-replay";

describe("stripReplayPrompt", () => {
  it("drops the company line the sidebar prepends", () => {
    expect(
      stripReplayPrompt("当前公司：Apple Inc.（AAPL）。\n\n靠什么赚钱？"),
    ).toBe("靠什么赚钱？");
    expect(
      stripReplayPrompt("Current company: Apple Inc. (AAPL).\n\nHow does it make money?"),
    ).toBe("How does it make money?");
  });

  it("keeps a plain question untouched", () => {
    expect(stripReplayPrompt("goog 今天为什么大跌？")).toBe(
      "goog 今天为什么大跌？",
    );
  });
});

describe("replayToolCalls", () => {
  const turn: AgentReplayTurn = {
    turn: 1,
    prompt: "q",
    answer: "a",
    status: "completed",
    startedAt: 1_000,
    endedAt: 3_000,
    calls: [
      {
        callId: "c1",
        title: "web_search",
        tool: null,
        kind: "search",
        status: "completed",
        input: { queries: ["x"] },
        output: "ok",
        startedAt: 1_100,
        endedAt: 1_500,
      },
      {
        callId: "c2",
        title: "mcp__occ__get_company",
        tool: null,
        kind: "other",
        status: "cancelled",
        startedAt: 0,
      },
    ],
  };

  it("maps persisted calls to the live trajectory shape", () => {
    expect(replayToolCalls(turn)).toEqual([
      {
        callId: "c1",
        title: "web_search",
        tool: null,
        kind: "search",
        status: "completed",
        input: { queries: ["x"] },
        output: "ok",
        startedAt: 1_100,
        endedAt: 1_500,
      },
      {
        callId: "c2",
        title: "mcp__occ__get_company",
        tool: null,
        kind: "other",
        status: "cancelled",
        input: undefined,
        output: undefined,
        startedAt: 1_000,
      },
    ]);
  });

  it("computes the turn duration from persisted timestamps", () => {
    expect(replayElapsedMs(turn)).toBe(2_000);
    expect(replayElapsedMs({ ...turn, endedAt: undefined })).toBeUndefined();
  });
});

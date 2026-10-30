import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  decompressSessionLog,
  findSessionLog,
  parseSessionReplay,
  readSessionReplay,
} from "../src/session-log.js";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

function record(value: unknown): string {
  return JSON.stringify(value);
}

function fixtureLines(): string[] {
  return [
    record({
      type: "session",
      version: 4,
      id: SESSION_ID,
      createdAt: 1_700_000_000_000,
      cwd: "/tmp/project",
      delegationDepth: 0,
    }),
    record({ type: "turn/start", time: 1_700_000_001_000, data: { turn: 1 } }),
    record({
      type: "user/message",
      time: 1_700_000_001_100,
      data: {
        content: [
          {
            type: "text",
            text: "你正在 OpenCorpCheck 的公司情报侧栏中回答用户问题。\n\n用户问题：苹果靠什么赚钱？",
          },
        ],
      },
    }),
    record({
      type: "user/message",
      time: 1_700_000_001_200,
      data: { content: [{ type: "text", text: "runtime context snapshot" }] },
    }),
    record({
      type: "tool/call",
      time: 1_700_000_002_000,
      data: {
        turn: 1,
        step: 1,
        callId: "call_1",
        name: "web_search",
        arguments: '{"queries":["apple revenue"]}',
      },
    }),
    record({
      type: "tool/result",
      time: 1_700_000_004_000,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: "tool",
          toolCallId: "call_1",
          isError: false,
          content: [
            { type: "text", text: '{"data":{"hits":[{"id":1},{"id":2}]}}' },
          ],
        },
      },
    }),
    record({
      type: "assistant/message",
      time: 1_700_000_005_000,
      data: {
        turn: 1,
        step: 2,
        message: {
          role: "assistant",
          content: [
            { type: "reasoning", text: "should not render" },
            { type: "text", text: "苹果主要靠卖 iPhone 赚钱。" },
          ],
        },
      },
    }),
    record({
      type: "turn/end",
      time: 1_700_000_006_000,
      data: { turn: 1, reason: { kind: "completed" } },
    }),
    record({ type: "turn/start", time: 1_700_000_010_000, data: { turn: 2 } }),
    record({
      type: "user/message",
      time: 1_700_000_010_100,
      data: {
        content: [
          {
            type: "text",
            text: "你正在 OpenCorpCheck 的公司情报侧栏中回答用户问题。\n\n用户问题：那最大的风险呢？",
          },
        ],
      },
    }),
    record({
      type: "tool/call",
      time: 1_700_000_011_000,
      data: {
        turn: 2,
        step: 1,
        callId: "call_2",
        name: "web_fetch",
        arguments: '{"url":"https://example.com/risk"}',
      },
    }),
    record({
      type: "turn/end",
      time: 1_700_000_012_000,
      data: { turn: 2, reason: { kind: "aborted" } },
    }),
  ];
}

describe("parseSessionReplay", () => {
  it("folds tool calls, strips the injected prompt and marks cancelled turns", () => {
    const replay = parseSessionReplay(fixtureLines().join("\n"));

    expect(replay.sessionId).toBe(SESSION_ID);
    expect(replay.turns).toHaveLength(2);

    const [first, second] = replay.turns;
    expect(first.prompt).toBe("苹果靠什么赚钱？");
    expect(first.answer).toBe("苹果主要靠卖 iPhone 赚钱。");
    expect(first.status).toBe("completed");
    expect(first.calls).toHaveLength(1);
    expect(first.calls[0]).toMatchObject({
      callId: "call_1",
      title: "web_search",
      kind: "search",
      status: "completed",
      startedAt: 1_700_000_002_000,
      endedAt: 1_700_000_004_000,
    });
    expect(JSON.stringify(first.calls[0].output)).toContain("hits");

    expect(second.prompt).toBe("那最大的风险呢？");
    expect(second.status).toBe("cancelled");
    expect(second.calls[0]).toMatchObject({
      title: "web_fetch",
      kind: "fetch",
      status: "cancelled",
    });
  });
});

describe("dsh session log files", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("reads a concatenated multi-frame log", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "occ-session-log-"));
    roots.push(home);
    const dir = path.join(home, "sessions", "--tmp-project---", SESSION_ID);
    await fs.mkdir(dir, { recursive: true });

    const lines = fixtureLines();
    const cut = Math.ceil(lines.length / 2);
    const frameOne = zstdCompressSync(Buffer.from(`${lines.slice(0, cut).join("\n")}\n`));
    const frameTwo = zstdCompressSync(Buffer.from(`${lines.slice(cut).join("\n")}\n`));
    await fs.writeFile(
      path.join(dir, "session.v4.jsonl.zstd"),
      Buffer.concat([frameOne, frameTwo]),
    );

    expect(await findSessionLog(home, SESSION_ID)).toBe(
      path.join(dir, "session.v4.jsonl.zstd"),
    );
    expect(decompressSessionLog(Buffer.concat([frameOne, frameTwo]))).toContain(
      "那最大的风险呢？",
    );

    const replay = await readSessionReplay(home, SESSION_ID);
    expect(replay?.turns).toHaveLength(2);
    expect(replay?.turns[0].calls).toHaveLength(1);
  });

  it("returns null for missing or unsafe ids", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "occ-session-log-"));
    roots.push(home);
    expect(await findSessionLog(home, SESSION_ID)).toBeNull();
    expect(await findSessionLog(home, "../../etc/passwd")).toBeNull();
  });
});

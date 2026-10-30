/**
 * Read dsh's persisted session log and fold it into the sidebar's tool-card
 * model.
 *
 * dsh owns persistence: every session is an append-only `SessionEvent` log at
 * `<DSH_HOME>/sessions/<project>/<session-id>/session.v4.jsonl.zstd`, with the
 * header beside the log. Upstream ACP exposes `session/list` and
 * `session/resume` but deliberately no replay, so this module is the thin
 * adapter: locate the log, decompress it, and project the records the UI
 * already understands (`tool/call` + `tool/result` → trajectory cards).
 *
 * This is read-only. Never write to DSH_HOME from here.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { summarizeToolPayload } from "./runtime.js";

/** Zstandard frame magic, little-endian (`0xFD2FB528`). */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** The API prefixes every prompt with this marker; the bubble shows the rest. */
const PROMPT_MARKER = "用户问题：";
const MAX_LOG_BYTES = 64 * 1024 * 1024;
/** dsh session ids are UUIDs today; keep the path join safe anyway. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

export interface ReplayedToolCall {
  callId: string;
  title: string;
  tool: string | null;
  kind: "search" | "fetch" | "execute" | "other";
  status: "in_progress" | "completed" | "failed" | "cancelled";
  input?: unknown;
  output?: unknown;
  startedAt: number;
  endedAt?: number;
}

export interface ReplayedTurn {
  turn: number;
  /** The user's question, without the injected system context. */
  prompt: string;
  answer: string;
  status: "completed" | "failed" | "cancelled" | "running";
  startedAt: number;
  endedAt?: number;
  calls: ReplayedToolCall[];
}

export interface SessionReplay {
  sessionId: string;
  title: string;
  createdAt: number;
  cwd?: string;
  turns: ReplayedTurn[];
}

/**
 * Locate one session's log. dsh groups sessions by project directory; the
 * grouping is internal, so scan one level rather than reimplementing the
 * encoding. Returns `null` when the session has no persisted log.
 */
export async function findSessionLog(
  dshHome: string,
  sessionId: string,
): Promise<string | null> {
  if (!SESSION_ID_PATTERN.test(sessionId) || sessionId.includes("..")) {
    return null;
  }
  const sessionsRoot = path.join(dshHome, "sessions");
  let projects: string[];
  try {
    projects = await fs.readdir(sessionsRoot);
  } catch {
    return null;
  }
  for (const project of projects) {
    const dir = path.join(sessionsRoot, project, sessionId);
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    const name =
      files.find((file) => /^session(\.v\d+)?\.jsonl\.zstd$/.test(file)) ??
      files.find((file) => /^session(\.v\d+)?\.jsonl$/.test(file));
    if (name) return path.join(dir, name);
  }
  return null;
}

/**
 * dsh writes one checksummed zstd frame per append batch, so a session log is
 * a concatenation of frames. Node's zstd API decodes only the first frame;
 * decode each frame independently and concatenate. Magic-byte candidates that
 * are not real frame starts simply fail to decode and are skipped.
 */
export function decompressSessionLog(buffer: Buffer): string {
  if (!buffer.includes(ZSTD_MAGIC)) return buffer.toString("utf8");
  const parts: Buffer[] = [];
  let offset = buffer.indexOf(ZSTD_MAGIC);
  while (offset !== -1) {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(offset)));
    } catch {
      // Magic bytes inside a compressed block, not a frame boundary.
    }
    offset = buffer.indexOf(ZSTD_MAGIC, offset + ZSTD_MAGIC.length);
  }
  if (parts.length === 0) {
    throw new Error("session log has no readable zstd frame");
  }
  return Buffer.concat(parts).toString("utf8");
}

/** Read and fold a persisted session. Returns `null` when no log exists. */
export async function readSessionReplay(
  dshHome: string,
  sessionId: string,
): Promise<SessionReplay | null> {
  const file = await findSessionLog(dshHome, sessionId);
  if (!file) return null;
  const stat = await fs.stat(file);
  if (stat.size > MAX_LOG_BYTES) {
    throw new Error(`session log is too large: ${stat.size} bytes`);
  }
  const raw = await fs.readFile(file);
  const text = file.endsWith(".zstd")
    ? decompressSessionLog(raw)
    : raw.toString("utf8");
  return parseSessionReplay(text, sessionId);
}

function blocksText(blocks: unknown): string {
  if (typeof blocks === "string") return blocks;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => {
      if (typeof block === "string") return block;
      if (!block || typeof block !== "object") return "";
      const record = block as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      const content = record.content;
      if (content && typeof content === "object") {
        const text = (content as Record<string, unknown>).text;
        if (typeof text === "string") return text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function callKind(name: string): ReplayedToolCall["kind"] {
  if (name === "web_search" || name === "search") return "search";
  if (name === "web_fetch" || name === "fetch") return "fetch";
  if (name === "bash" || name === "shell" || name === "terminal") {
    return "execute";
  }
  return "other";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Fold persisted `SessionEvent` records into turns. Unknown record types are
 * ignored on purpose: dsh is a preview and adds records over time.
 */
export function parseSessionReplay(
  text: string,
  fallbackSessionId = "",
): SessionReplay {
  const header = {
    sessionId: fallbackSessionId,
    createdAt: 0,
    cwd: undefined as string | undefined,
  };
  const turns = new Map<number, ReplayedTurn>();
  const calls = new Map<string, ReplayedToolCall>();
  let title = "";
  let currentTurn: number | null = null;

  const turnFor = (turn: number): ReplayedTurn => {
    const existing = turns.get(turn);
    if (existing) return existing;
    const created: ReplayedTurn = {
      turn,
      prompt: "",
      answer: "",
      status: "running",
      startedAt: 0,
      calls: [],
    };
    turns.set(turn, created);
    return created;
  };

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const data = asRecord(record.data);
    const time = typeof record.time === "number" ? record.time : 0;

    switch (record.type) {
      case "session": {
        if (typeof record.id === "string") header.sessionId = record.id;
        if (typeof record.createdAt === "number") {
          header.createdAt = record.createdAt;
        }
        if (typeof record.cwd === "string") header.cwd = record.cwd;
        break;
      }
      case "session/title": {
        if (typeof data.title === "string" && data.title.trim()) {
          title = data.title.trim();
        }
        break;
      }
      case "turn/start": {
        if (typeof data.turn !== "number") break;
        currentTurn = data.turn;
        const turn = turnFor(data.turn);
        if (!turn.startedAt) turn.startedAt = time;
        break;
      }
      case "user/message": {
        if (currentTurn === null) break;
        const raw = blocksText(data.content);
        const marker = raw.lastIndexOf(PROMPT_MARKER);
        if (marker >= 0) {
          turnFor(currentTurn).prompt = raw
            .slice(marker + PROMPT_MARKER.length)
            .trim();
        }
        break;
      }
      case "assistant/message": {
        const turnNumber =
          typeof data.turn === "number" ? data.turn : currentTurn;
        if (turnNumber === null) break;
        const message = asRecord(data.message);
        const blocks = Array.isArray(message.content) ? message.content : [];
        const textBlocks = blocks
          .filter(
            (block) =>
              asRecord(block).type === "text" &&
              typeof asRecord(block).text === "string",
          )
          .map((block) => String(asRecord(block).text));
        if (!textBlocks.length) break;
        const turn = turnFor(turnNumber);
        for (const text of textBlocks) {
          turn.answer = turn.answer ? `${turn.answer}\n\n${text}` : text;
        }
        break;
      }
      case "tool/call": {
        const turnNumber =
          typeof data.turn === "number" ? data.turn : currentTurn;
        if (turnNumber === null || typeof data.callId !== "string") break;
        const name = typeof data.name === "string" ? data.name : "tool";
        let input = data.arguments;
        if (typeof input === "string") {
          try {
            input = JSON.parse(input) as unknown;
          } catch {
            // Keep the raw argument string; the UI handles plain text.
          }
        }
        const call: ReplayedToolCall = {
          callId: data.callId,
          title: name,
          tool: null,
          kind: callKind(name),
          status: "in_progress",
          input: summarizeToolPayload(input, 4_000),
          startedAt: time || header.createdAt,
        };
        turnFor(turnNumber).calls.push(call);
        calls.set(call.callId, call);
        break;
      }
      case "tool/result": {
        const message = asRecord(data.message);
        const callId =
          typeof data.toolCallId === "string"
            ? data.toolCallId
            : typeof message.toolCallId === "string"
              ? message.toolCallId
              : undefined;
        const call = callId ? calls.get(callId) : undefined;
        if (!call) break;
        const blocks = Array.isArray(message.content)
          ? message.content
          : Array.isArray(data.content)
            ? data.content
            : [];
        call.output = summarizeToolPayload(
          [{ type: "content", content: { type: "text", text: blocksText(blocks) } }],
          16_000,
        );
        call.status =
          message.isError === true || data.isError === true
            ? "failed"
            : "completed";
        call.endedAt = time || call.startedAt;
        break;
      }
      case "turn/end": {
        const turnNumber =
          typeof data.turn === "number" ? data.turn : currentTurn;
        if (turnNumber === null) break;
        const turn = turnFor(turnNumber);
        const reason = asRecord(data.reason);
        const kind = typeof reason.kind === "string" ? reason.kind : "completed";
        turn.status =
          kind === "completed"
            ? "completed"
            : kind === "aborted" || kind === "interrupted"
              ? "cancelled"
              : "failed";
        turn.endedAt = time || turn.startedAt;
        for (const call of turn.calls) {
          if (call.status === "in_progress") call.status = "cancelled";
        }
        break;
      }
      default:
        break;
    }
  }

  const ordered = [...turns.values()]
    .filter((turn) => turn.prompt || turn.answer || turn.calls.length > 0)
    .sort((left, right) => left.turn - right.turn);

  return {
    sessionId: header.sessionId,
    title: title || ordered[0]?.prompt.slice(0, 40) || "",
    createdAt: header.createdAt,
    ...(header.cwd ? { cwd: header.cwd } : {}),
    turns: ordered,
  };
}

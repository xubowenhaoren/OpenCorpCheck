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

/** One row in the sidebar's history menu. */
export interface PersistedSessionSummary {
  sessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Number of user prompts (dsh's own count). */
  turns: number;
}

async function sessionLogIn(dir: string): Promise<string | null> {
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return null;
  }
  const name =
    files.find((file) => /^session(\.v\d+)?\.jsonl\.zstd$/.test(file)) ??
    files.find((file) => /^session(\.v\d+)?\.jsonl$/.test(file));
  return name ? path.join(dir, name) : null;
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
    const file = await sessionLogIn(path.join(sessionsRoot, project, sessionId));
    if (file) return file;
  }
  return null;
}

interface ProjectionSummary {
  title: string;
  createdAt: number;
  cwd?: string;
  turns: number;
}

/** Read only the session header (the first zstd frame holds it). */
async function readSessionHeader(file: string): Promise<{
  delegationDepth?: number;
  origin?: string;
}> {
  try {
    const raw = await fs.readFile(file);
    let text: string;
    try {
      // Node stops after the first frame, which is exactly the header batch.
      text = zstdDecompressSync(raw).toString("utf8");
    } catch {
      text = decompressSessionLog(raw);
    }
    const first = text.split("\n").find((line) => line.trim());
    if (!first) return {};
    const record = JSON.parse(first) as Record<string, unknown>;
    if (record.type !== "session") return {};
    return {
      ...(typeof record.delegationDepth === "number"
        ? { delegationDepth: record.delegationDepth }
        : {}),
      ...(typeof record.origin === "string" ? { origin: record.origin } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * dsh keeps a small projection cache beside each log (title input, prompt
 * count, token usage). Reading it avoids decompressing every log just to build
 * the history menu.
 */
async function readProjectionSummary(
  dshHome: string,
  sessionId: string,
): Promise<ProjectionSummary | null> {
  const file = path.join(
    dshHome,
    "storages",
    "session_projcache",
    "sessions",
    `${sessionId}.json`,
  );
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Record<
      string,
      unknown
    >;
    const record = asRecord(parsed.record);
    const identity = asRecord(record.identity);
    const rows = asRecord(record.rows);
    const titleInput = asRecord(asRecord(rows.titleInput).val);
    const first = asRecord(titleInput.first);
    const raw = typeof first.text === "string" ? first.text : "";
    const question = promptFromRaw(raw);
    const rawTitle = asRecord(rows.title).val;
    const fallback =
      typeof rawTitle === "string" &&
      rawTitle.trim() &&
      !rawTitle.startsWith("你正在 OpenCorpCheck")
        ? shortTitle(rawTitle)
        : "";
    return {
      title: question ? shortTitle(question) : fallback,
      createdAt:
        typeof identity.createdAt === "number" ? identity.createdAt : 0,
      cwd: typeof identity.cwd === "string" ? identity.cwd : undefined,
      turns: typeof titleInput.count === "number" ? titleInput.count : 0,
    };
  } catch {
    return null;
  }
}

/**
 * List persisted sessions for the history menu, newest first. Only sessions
 * with a readable log are returned; `cwd` filters out other dsh projects that
 * share the same DSH_HOME.
 */
export async function listPersistedSessions(
  dshHome: string,
  options: { cwd?: string; limit?: number } = {},
): Promise<PersistedSessionSummary[]> {
  const sessionsRoot = path.join(dshHome, "sessions");
  let projects: string[];
  try {
    projects = await fs.readdir(sessionsRoot);
  } catch {
    return [];
  }
  const summaries: PersistedSessionSummary[] = [];
  for (const project of projects) {
    let entries;
    try {
      entries = await fs.readdir(path.join(sessionsRoot, project), {
        withFileTypes: true,
      });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionId = entry.name;
      if (
        !SESSION_ID_PATTERN.test(sessionId) ||
        sessionId.includes("..")
      ) {
        continue;
      }
      const log = await sessionLogIn(
        path.join(sessionsRoot, project, sessionId),
      );
      if (!log) continue;
      let stat;
      try {
        stat = await fs.stat(log);
      } catch {
        continue;
      }
      // Subagent child sessions are internal; only user-facing parents belong
      // in the history menu.
      const header = await readSessionHeader(log);
      if (header.origin === "subagent" || (header.delegationDepth ?? 0) > 0) {
        continue;
      }
      const cache = await readProjectionSummary(dshHome, sessionId);
      if (
        options.cwd &&
        cache?.cwd &&
        path.resolve(cache.cwd) !== path.resolve(options.cwd)
      ) {
        continue;
      }
      summaries.push({
        sessionId,
        title: cache?.title || sessionId.slice(0, 8),
        createdAt: cache?.createdAt || stat.birthtimeMs || stat.mtimeMs,
        updatedAt: stat.mtimeMs,
        turns: cache?.turns ?? 0,
      });
    }
  }
  summaries.sort((left, right) => right.updatedAt - left.updatedAt);
  return summaries.slice(0, options.limit ?? 50);
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

/** Extract the human question from an injected prompt (context + company line). */
function promptFromRaw(raw: string): string {
  const marker = raw.lastIndexOf(PROMPT_MARKER);
  const text = marker >= 0 ? raw.slice(marker + PROMPT_MARKER.length) : raw;
  return text
    .replace(/^(?:当前公司：|Current company:)[^\n]*\n+/u, "")
    .trim();
}

function shortTitle(text: string, max = 80): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max
    ? `${collapsed.slice(0, max - 1)}…`
    : collapsed;
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
        if (raw.lastIndexOf(PROMPT_MARKER) >= 0) {
          turnFor(currentTurn).prompt = promptFromRaw(raw);
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

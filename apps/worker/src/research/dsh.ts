import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { config, ensureDir } from "../config.js";

export interface DshEvent {
  type?: string;
  phase?: string;
  reason?: unknown;
  text?: string;
  tool?: string;
  usage?: Record<string, number>;
  [key: string]: unknown;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
}

interface DshLib {
  parseJsonLines(text: string): DshEvent[];
  finalText(events: DshEvent[]): string;
  turnReason(events: DshEvent[]): unknown;
  isCompleted(events: DshEvent[]): boolean;
  toolCounts(events: DshEvent[]): Record<string, number>;
  usageTotals(events: DshEvent[]): Usage;
}

let libPromise: Promise<DshLib> | null = null;

function dshLib(): Promise<DshLib> {
  libPromise ??= import(
    pathToFileURL(path.join(config.repoRoot, "phase0", "lib", "dsh.mjs")).href
  ) as Promise<DshLib>;
  return libPromise;
}

export interface ResearchRunOptions {
  ticker: string;
  prompt: string;
  includeF10?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ResearchRunResult {
  ok: boolean;
  finalText: string;
  reason: unknown;
  timedOut: boolean;
  exitCode: number | null;
  durationMs: number;
  toolCounts: Record<string, number>;
  usage: Usage;
  eventsPath: string;
  stderrPath: string;
  error?: string;
}

/**
 * Spawn one dsh headless turn for one company.
 *
 * Mirrors phase0/lib/dsh.mjs: one process per company, stdout NDJSON, prompt on
 * stdin, read-only permissions, DeepSeek Flash, events persisted for audit.
 */
export async function runDshResearch(
  options: ResearchRunOptions,
): Promise<ResearchRunResult> {
  ensureDir(config.runsDir);
  ensureDir(config.dshHome);
  ensureDir(config.npmCache);

  const safeTicker = options.ticker.replace(/[^A-Za-z0-9.-]+/g, "_");
  const eventsPath = path.join(config.runsDir, `${safeTicker}.jsonl`);
  const stderrPath = path.join(config.runsDir, `${safeTicker}.err`);

  const args = [
    "--yes",
    `@deepseek-ai/dsh@${config.dshVersion}`,
    "--profile",
    "headless",
    "--patch",
    config.basePatch,
  ];
  if (options.includeF10) args.push("--patch", config.f10Patch);
  args.push("--json", "-");

  const startedAt = Date.now();
  const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", args, {
    cwd: config.repoRoot,
    env: {
      ...process.env,
      DSH_HOME: config.dshHome,
      DSH_PERMISSION_MODE: config.permissionMode,
      npm_config_cache: config.npmCache,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const eventsStream = fs.createWriteStream(eventsPath, { encoding: "utf8" });
  const stderrStream = fs.createWriteStream(stderrPath, { encoding: "utf8" });
  let stdout = "";
  let stderr = "";
  let timedOut = false;

  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stdout += text;
    eventsStream.write(text);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderr += text;
    stderrStream.write(text);
  });

  const timeoutMs = options.timeoutMs ?? 20 * 60 * 1000;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  }, timeoutMs);

  const abort = () => child.kill("SIGTERM");
  if (options.signal) {
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
  }

  child.stdin.end(options.prompt);

  let exitCode: number | null = null;
  let spawnError: Error | null = null;
  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("close", (code) => resolve(code));
      child.on("error", reject);
    });
  } catch (error) {
    spawnError = error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    await Promise.all([closeStream(eventsStream), closeStream(stderrStream)]);
  }

  const lib = await dshLib();
  const events = lib.parseJsonLines(stdout);
  const finalText = lib.finalText(events);
  const reason = lib.turnReason(events);
  const completed = lib.isCompleted(events);
  const durationMs = Date.now() - startedAt;

  let error: string | undefined;
  if (spawnError) error = `spawn failed: ${spawnError.message}`;
  else if (timedOut) error = `dsh timed out after ${timeoutMs}ms`;
  else if (exitCode !== 0) error = `dsh exited with code ${exitCode}`;
  else if (!completed) error = `dsh turn did not complete: ${JSON.stringify(reason)}`;
  else if (!finalText.trim()) error = "dsh returned empty final text";
  if (error && stderr.trim()) {
    error += `\n${stderr.trim().slice(-1_500)}`;
  }

  return {
    ok: error === undefined,
    finalText,
    reason,
    timedOut,
    exitCode,
    durationMs,
    toolCounts: lib.toolCounts(events),
    usage: lib.usageTotals(events),
    eventsPath,
    stderrPath,
    ...(error ? { error } : {}),
  };
}

function closeStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve) => stream.end(resolve));
}

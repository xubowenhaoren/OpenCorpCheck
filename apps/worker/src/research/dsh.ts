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

export interface ReviewRunOptions {
  ticker: string;
  prompt: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DshRunResult {
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

export type ResearchRunResult = DshRunResult;

const ENV_WHITELIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "SHELL_ENV",
  "OCC_NIM_GATEWAY_URL",
] as const;

/**
 * Build a deliberate child environment.
 *
 * Research must never see DEEPSEEK_API_KEY and the reviewer must never see
 * NVIDIA_API_KEY: the two routes have different providers, budgets and failure
 * modes. Inheriting `...process.env` would leak whichever key the operator has
 * exported into the wrong child.
 */
function childEnv(mode: "research" | "review"): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_WHITELIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(npm_config_|NPM_CONFIG_)/i.test(key) && value !== undefined) {
      env[key] = value;
    }
  }
  env.DSH_HOME = config.dshHome;
  env.DSH_PERMISSION_MODE = config.permissionMode;
  env.npm_config_cache = config.npmCache;
  if (mode === "research") {
    if (config.llmProvider === "deepseek") {
      if (config.deepseekApiKey) env.DEEPSEEK_API_KEY = config.deepseekApiKey;
    } else if (config.nvidiaApiKey) {
      env.NVIDIA_API_KEY = config.nvidiaApiKey;
    }
    env.OCC_LLM_PROVIDER =
      config.llmProvider === "deepseek" ? "deepseek" : "nvidia";
    if (config.llmProvider === "nvidia") {
      env.OCC_NIM_GATEWAY_URL = config.nimGatewayUrl;
    }
  } else if (config.deepseekApiKey) {
    env.DEEPSEEK_API_KEY = config.deepseekApiKey;
  }
  return env;
}

function spawnDsh(input: {
  mode: "research" | "review";
  tag: string;
  prompt: string;
  patches: string[];
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<DshRunResult> {
  ensureDir(config.runsDir);
  ensureDir(config.dshHome);
  ensureDir(config.npmCache);

  const safeTicker = input.tag.replace(/[^A-Za-z0-9.-]+/g, "_");
  const suffix = input.mode === "review" ? ".review" : "";
  const eventsPath = path.join(config.runsDir, `${safeTicker}${suffix}.jsonl`);
  const stderrPath = path.join(config.runsDir, `${safeTicker}${suffix}.err`);

  const args = [
    "--yes",
    `@deepseek-ai/dsh@${config.dshVersion}`,
    "--profile",
    "headless",
  ];
  for (const patch of input.patches) args.push("--patch", patch);
  args.push("--json", "-");

  const startedAt = Date.now();
  const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", args, {
    cwd: config.repoRoot,
    env: childEnv(input.mode),
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

  const timeoutMs = input.timeoutMs;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  }, timeoutMs);

  const abort = (): void => {
    child.kill("SIGTERM");
  };
  if (input.signal) {
    if (input.signal.aborted) abort();
    else input.signal.addEventListener("abort", abort, { once: true });
  }

  child.stdin.end(input.prompt);

  return (async () => {
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
      input.signal?.removeEventListener("abort", abort);
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
  })();
}

/**
 * Spawn one dsh headless turn for one company on the NIM route.
 *
 * `phase0/parallel.patch.yml` mounts Parallel's free Search MCP and replaces
 * official DeepSeek search/fetch in the headless profile only. The ACP sidebar
 * keeps its own provider and patch.
 */
export async function runDshResearch(
  options: ResearchRunOptions,
): Promise<ResearchRunResult> {
  if (config.llmProvider === "nvidia" && !config.nvidiaApiKey) {
    throw new Error(
      "NVIDIA_API_KEY is required for headless research on NIM; use OCC_LLM_PROVIDER=deepseek to roll back",
    );
  }
  const patches = [config.basePatch];
  if (config.llmProvider === "nvidia") patches.push(config.parallelPatch);
  else patches.push(config.deepseekPatch);
  if (options.includeF10) patches.push(config.f10Patch);
  return spawnDsh({
    mode: "research",
    tag: options.ticker,
    prompt: options.prompt,
    patches,
    timeoutMs: options.timeoutMs ?? config.researchTimeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/**
 * Spawn one reviewer turn on the official DeepSeek API with reasoning on.
 *
 * The reviewer gets no NVIDIA key and no Parallel MCP: its job is judgment on
 * the evidence already gathered, and NIM's structured-output mode needs
 * `thinking:false` (the opposite of what review needs).
 */
export async function runDshReview(
  options: ReviewRunOptions,
): Promise<DshRunResult> {
  if (!config.deepseekApiKey) {
    throw new Error(
      "DEEPSEEK_API_KEY is required for the reviewer; set DEEPSEEK_API_KEY or DEEPSEEK_API_KEY_FILE",
    );
  }
  return spawnDsh({
    mode: "review",
    tag: options.ticker,
    prompt: options.prompt,
    patches: [config.basePatch, config.reviewerPatch],
    timeoutMs: options.timeoutMs ?? config.reviewTimeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

function closeStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve) => stream.end(resolve));
}

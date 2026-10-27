import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DSH_VERSION = "0.2.1-rc.3";
export const DEFAULT_MODEL = "deepseek-flash";

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Minimal .env loader: KEY=VALUE, # comments, optional quotes. Does not override existing env. */
export function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

export function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function parseJsonLines(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Non-JSON line (npm notice, partial write, etc.) — keep going.
    }
  }
  return events;
}

export function finalText(events) {
  const final = [...events].reverse().find((e) => e.type === "final");
  if (final && typeof final.text === "string" && final.text.trim()) return final.text;
  return events
    .filter((e) => e.type === "text" && typeof e.text === "string")
    .map((e) => e.text)
    .join("");
}

export function turnReason(events) {
  const turnEnd = [...events]
    .reverse()
    .find((e) => e.type === "status" && e.phase === "turn_end");
  return turnEnd?.reason ?? null;
}

export function isCompleted(events) {
  const reason = turnReason(events);
  if (!reason) return false;
  if (typeof reason === "string") return reason === "completed";
  return reason.kind === "completed";
}

export function toolCounts(events) {
  const counts = {};
  for (const event of events) {
    if (event.type === "tool_call" && typeof event.tool === "string") {
      counts[event.tool] = (counts[event.tool] || 0) + 1;
    }
  }
  return counts;
}

export function usageTotals(events) {
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
  };
  for (const event of events) {
    if (
      event.type === "status" &&
      event.phase === "step_end" &&
      event.usage &&
      typeof event.usage === "object"
    ) {
      for (const key of Object.keys(totals)) {
        if (typeof event.usage[key] === "number") totals[key] += event.usage[key];
      }
    }
  }
  return totals;
}

export function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    let out = url.toString();
    if (out.endsWith("/")) out = out.slice(0, -1);
    return out;
  } catch {
    return value;
  }
}

/** URLs the model actually saw: web_fetch inputs plus URLs embedded in tool results. */
export function eventUrls(events) {
  const urls = new Set();
  const add = (value) => {
    if (typeof value !== "string") return;
    const matches = value.match(/https?:\/\/[^\s)\]"'<>]+/g) || [];
    if (/^https?:\/\//i.test(value)) matches.push(value);
    for (const raw of matches) {
      const cleaned = raw.replace(/[),.;，。；]+$/, "");
      urls.add(normalizeUrl(cleaned));
    }
  };

  for (const event of events) {
    if (event.type === "tool_call") {
      const input = event.input || {};
      add(input.url);
      if (Array.isArray(input.urls)) input.urls.forEach(add);
    }
    if (event.type === "tool_result") {
      const text =
        typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? "");
      add(text);
    }
  }
  return urls;
}

function npxCommand() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

export async function runHeadless({
  prompt,
  cwd,
  patchPaths,
  dshHome,
  ticker,
  runsDir,
  timeoutMs = 20 * 60 * 1000,
}) {
  ensureDir(runsDir);
  ensureDir(dshHome);
  const stdoutPath = path.join(runsDir, `${ticker}.jsonl`);
  const stderrPath = path.join(runsDir, `${ticker}.err`);
  // Do not inherit npm_config_cache from `npm run`: npm sets it to ~/.npm, which may be
  // unwritable in this environment. Use a per-run writable cache unless explicitly overridden.
  const npmCache = process.env.OCC_NPM_CACHE || path.join(os.tmpdir(), "occ-npm-cache");
  ensureDir(npmCache);

  const args = ["--yes", `@deepseek-ai/dsh@${DSH_VERSION}`, "--profile", "headless"];
  for (const patch of patchPaths) args.push("--patch", patch);
  args.push("--json", "-");

  const env = {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE || "read-only",
    npm_config_cache: npmCache,
  };

  const startedAt = Date.now();
  const child = spawn(npxCommand(), args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5000).unref();
  }, timeoutMs);

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.stdin.end(prompt);

  const exitCode = await new Promise((resolve) => {
    child.on("error", (error) => {
      stderr += `\nspawn error: ${error.message}\n`;
      resolve(-1);
    });
    child.on("close", (code) => resolve(code ?? -1));
  });
  clearTimeout(timer);

  fs.writeFileSync(stdoutPath, stdout, "utf8");
  fs.writeFileSync(stderrPath, stderr, "utf8");
  const events = parseJsonLines(stdout);
  return {
    ticker,
    exitCode,
    timedOut,
    events,
    text: finalText(events),
    reason: turnReason(events),
    completed: isCompleted(events),
    tools: toolCounts(events),
    usage: usageTotals(events),
    urls: eventUrls(events),
    stdoutPath,
    stderrPath,
    durationMs: Date.now() - startedAt,
  };
}

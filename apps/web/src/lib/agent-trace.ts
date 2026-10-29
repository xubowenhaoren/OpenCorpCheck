/**
 * Pure helpers for the agent trajectory view.
 *
 * The sidebar only receives normalized `AgentEvent`s. This module turns raw
 * tool inputs/outputs into human-readable cards and a deduplicated source
 * ledger. It deliberately never returns raw HTML/JSON for rendering: the trace
 * is progressive disclosure for non-technical users, not a debug panel.
 */

export type TraceLang = "zh" | "en";

export interface AgentToolCall {
  callId: string;
  title: string;
  tool: string | null;
  kind: string | null;
  /** pending | in_progress | completed | failed | cancelled */
  status: string;
  input?: unknown;
  output?: unknown;
  startedAt: number;
  endedAt?: number;
}

export interface ToolDescriptor {
  label: string;
  detail: string;
  meta: string;
  urls: string[];
}

export interface SourceLink {
  url: string;
  title?: string;
  domain: string;
  cited: boolean;
}

export interface UsageSummary {
  used: number;
  size: number;
}

const MAX_TEXT = 200_000;
const MAX_URLS = 60;
const MAX_DETAIL = 180;
const URL_PATTERN = /https?:\/\/[^\s)\]<>"'`]+/g;
const MARKDOWN_LINK_PATTERN = /\[([^\]]{1,200})\]\((https?:\/\/[^\s)]+)\)/g;

function text(lang: TraceLang, zh: string, en: string): string {
  return lang === "zh" ? zh : en;
}

function truncate(value: string, max = MAX_DETAIL): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Detail lines must read like a query, never like a JSON payload. */
function humanDetail(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (/^[[{]/.test(trimmed)) return "";
  return truncate(trimmed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ACP tool payloads are `unknown`: sometimes objects, sometimes JSON strings. */
export function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_TEXT) return value;
  if (!/^[{["]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  const parsed = parseMaybeJson(value);
  return isRecord(parsed) ? parsed : {};
}

function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json.length > 20_000 ? json.slice(0, 20_000) : json;
  } catch {
    return "";
  }
}

/** Flattens an MCP `{content:[{type:"text",text}]}` result (or plain text). */
export function outputText(output: unknown): string {
  if (output === null || output === undefined) return "";
  if (typeof output === "string") {
    return output.length > MAX_TEXT ? output.slice(0, MAX_TEXT) : output;
  }
  if (Array.isArray(output)) {
    return output
      .map((item) => {
        if (typeof item === "string") return item;
        if (isRecord(item)) {
          const value = item.text ?? item.content ?? item.message;
          return typeof value === "string" ? value : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (isRecord(output)) {
    if (Array.isArray(output.content)) return outputText(output.content);
    if (typeof output.text === "string") return outputText(output.text);
    if (output.structuredContent !== undefined) {
      return safeStringify(output.structuredContent);
    }
    if (output.error !== undefined) {
      return typeof output.error === "string"
        ? output.error
        : safeStringify(output.error);
    }
    return safeStringify(output);
  }
  return String(output);
}

function tryParseJson(value: string): { ok: boolean; value?: unknown } {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_TEXT) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Best-effort JSON out of an MCP tool result (content wrapper, then text). */
export function parseOutputJson(output: unknown): unknown {
  const parsed = parseMaybeJson(output);
  if (Array.isArray(parsed)) {
    const inner = outputText(parsed);
    if (inner) {
      const nested = parseOutputJson(inner);
      if (nested !== undefined) return nested;
    }
    return parsed;
  }
  if (isRecord(parsed)) {
    if (Array.isArray(parsed.content)) {
      const inner = outputText(parsed);
      if (inner) {
        const nested = parseOutputJson(inner);
        if (nested !== undefined) return nested;
      }
    }
    return parsed;
  }
  if (typeof parsed !== "string") return parsed;
  const direct = tryParseJson(parsed);
  if (direct.ok) return direct.value;
  const start = parsed.indexOf("{");
  const end = parsed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const embedded = tryParseJson(parsed.slice(start, end + 1));
    if (embedded.ok) return embedded.value;
  }
  return undefined;
}

function collectStrings(
  value: unknown,
  seen: Set<unknown>,
  depth = 0,
): string[] {
  if (depth > 5 || seen.has(value)) return [];
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [];
  if (Array.isArray(value) || isRecord(value)) seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectStrings(item, seen, depth + 1));
  }
  if (isRecord(value)) {
    return Object.values(value).flatMap((item) =>
      collectStrings(item, seen, depth + 1),
    );
  }
  return [];
}

/** Unique http(s) URLs found anywhere in a tool payload. */
export function extractUrls(value: unknown): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const chunk of collectStrings(parseMaybeJson(value), new Set())) {
    if (chunk.length > MAX_TEXT) continue;
    const matches = chunk.match(URL_PATTERN) ?? [];
    for (const raw of matches) {
      const candidate = raw.replace(/[.,;:!?]+$/, "");
      try {
        const url = new URL(candidate);
        if (url.protocol !== "http:" && url.protocol !== "https:") continue;
        if (seen.has(url.href)) continue;
        seen.add(url.href);
        urls.push(url.href);
        if (urls.length >= MAX_URLS) return urls;
      } catch {
        // Not a valid URL; skip.
      }
    }
  }
  return urls;
}

export interface ExtractedLink {
  url: string;
  title?: string;
}

/** URLs plus markdown link titles (`- [Title](https://…)`) from tool output. */
export function extractLinks(value: unknown): ExtractedLink[] {
  const links = new Map<string, ExtractedLink>();
  for (const chunk of collectStrings(parseMaybeJson(value), new Set())) {
    if (chunk.length > MAX_TEXT) continue;
    MARKDOWN_LINK_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MARKDOWN_LINK_PATTERN.exec(chunk)) !== null) {
      const title = match[1]?.trim();
      const url = match[2];
      if (!url) continue;
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
        if (!links.has(parsed.href)) {
          links.set(parsed.href, {
            url: parsed.href,
            ...(title ? { title } : {}),
          });
        }
      } catch {
        // ignore
      }
    }
  }
  for (const url of extractUrls(value)) {
    if (!links.has(url)) links.set(url, { url });
  }
  return [...links.values()].slice(0, MAX_URLS);
}

export function uniqueUrls(value: string): string[] {
  const matches = value.match(URL_PATTERN) ?? [];
  const seen = new Set<string>();
  for (const raw of matches) {
    const candidate = raw.replace(/[.,;:!?]+$/, "");
    try {
      const url = new URL(candidate);
      if (url.protocol === "http:" || url.protocol === "https:") {
        seen.add(url.href);
      }
    } catch {
      // ignore
    }
  }
  return [...seen];
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function normalizeToolName(call: AgentToolCall): string {
  const raw = (call.tool || call.title || "").trim().toLowerCase();
  return raw
    .replace(/^mcp__occ__/, "")
    .replace(/^mcp__[a-z0-9_-]+__/, "")
    .replace(/^occ[:/_-]/, "");
}

function pickString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const items = value.filter(
        (item): item is string => typeof item === "string" && item.trim() !== "",
      );
      if (items.length) return items.join(" · ");
    }
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function pickFromOutput(output: unknown, keys: string[]): string | undefined {
  const parsed = parseOutputJson(output);
  const record = isRecord(parsed)
    ? isRecord(parsed.data)
      ? { ...parsed.data, ...parsed }
      : parsed
    : {};
  const value = pickString(record, keys);
  return value ? truncate(value) : undefined;
}

export function resultCount(
  output: unknown,
  parsedOutput = parseOutputJson(output),
): number | undefined {
  if (isRecord(parsedOutput)) {
    const data = isRecord(parsedOutput.data) ? parsedOutput.data : {};
    const candidates = [
      data.hits,
      data.results,
      data.pages,
      data.documents,
      data.events,
      parsedOutput.hits,
      parsedOutput.results,
      parsedOutput.pages,
      parsedOutput.documents,
    ];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) return candidate.length;
    }
  }
  const urls = extractUrls(output);
  return urls.length || undefined;
}

type ResultUnit = "auto" | "companies" | "documents" | "pages" | "events";

const RESULT_LABELS: Record<
  Exclude<ResultUnit, "auto">,
  { zh: (n: number) => string; en: (n: number) => string }
> = {
  companies: {
    zh: (n) => `${n} 家公司`,
    en: (n) => `${n} companies`,
  },
  documents: {
    zh: (n) => `${n} 条资料`,
    en: (n) => `${n} documents`,
  },
  pages: {
    zh: (n) => `${n} 个页面`,
    en: (n) => `${n} pages`,
  },
  events: {
    zh: (n) => `${n} 条动态`,
    en: (n) => `${n} events`,
  },
};

function resultMeta(
  output: unknown,
  lang: TraceLang,
  unit: ResultUnit = "auto",
): string {
  const parsed = parseOutputJson(output);
  const count = resultCount(output, parsed);
  if (count === undefined) return "";
  if (unit !== "auto") {
    const label = RESULT_LABELS[unit];
    return lang === "zh" ? label.zh(count) : label.en(count);
  }
  if (isRecord(parsed)) {
    const data = isRecord(parsed.data) ? parsed.data : {};
    if (Array.isArray(data.hits) || Array.isArray(parsed.hits)) {
      return text(lang, `${count} 家公司`, `${count} companies`);
    }
    if (Array.isArray(data.pages) || Array.isArray(parsed.pages)) {
      return text(lang, `${count} 个页面`, `${count} pages`);
    }
    if (Array.isArray(data.documents) || Array.isArray(parsed.documents)) {
      return text(lang, `${count} 条资料`, `${count} documents`);
    }
    if (Array.isArray(data.events) || Array.isArray(parsed.events)) {
      return text(lang, `${count} 条动态`, `${count} events`);
    }
  }
  return text(lang, `${count} 个结果`, `${count} results`);
}

function httpStatus(output: unknown): string {
  const match = outputText(output).match(/HTTP\s+(\d{3})/i);
  return match ? `HTTP ${match[1]}` : "";
}

function domainSummary(urls: string[], lang: TraceLang): string {
  const domains = [...new Set(urls.map(hostOf))].filter(Boolean);
  if (!domains.length) return "";
  const shown = domains.slice(0, 3).join(" · ");
  const extra = domains.length > 3 ? text(lang, ` 等 ${domains.length} 个站点`, ` +${domains.length - 3} sites`) : "";
  return `${shown}${extra}`;
}

function errorSummary(call: AgentToolCall): string {
  if (call.status !== "failed") return "";
  const body = outputText(call.output);
  const line = body.split("\n").find((entry) => /error|failed|失败/i.test(entry));
  return truncate((line ?? body).replace(/^error[:\s]*/i, ""), 120);
}

/** Short, human error line for a failed tool call (never the whole payload). */
export function toolErrorSummary(call: AgentToolCall): string {
  return errorSummary(call);
}

export function isTerminalStatus(status: string): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

export function isActiveStatus(status: string): boolean {
  return !status || status === "pending" || status === "in_progress";
}

export function toolStatusLabel(status: string, lang: TraceLang): string {
  switch (status) {
    case "failed":
      return text(lang, "失败", "Failed");
    case "cancelled":
      return text(lang, "已取消", "Cancelled");
    case "completed":
      return text(lang, "已完成", "Done");
    case "in_progress":
      return text(lang, "进行中", "Running");
    case "pending":
    default:
      return text(lang, "排队中", "Queued");
  }
}

const MCP_LABELS: Record<
  string,
  { zh: string; en: string; detailKeys: string[] }
> = {
  search_companies: {
    zh: "查找公司",
    en: "Find companies",
    detailKeys: ["query", "q", "name", "ticker"],
  },
  get_company: {
    zh: "查看公司资料",
    en: "Open company profile",
    detailKeys: ["company", "ref", "ticker", "id", "name"],
  },
  search_documents: {
    zh: "检索资料",
    en: "Search documents",
    detailKeys: ["query", "q"],
  },
  deep_research: {
    zh: "发起深度研究",
    en: "Start deep research",
    detailKeys: ["company", "ticker", "ref", "name"],
  },
  get_run: {
    zh: "查询研究进度",
    en: "Check research run",
    detailKeys: ["runId", "run_id", "jobKey", "id"],
  },
  propose_fact: {
    zh: "提交待审事实",
    en: "Propose a fact",
    detailKeys: ["company", "fact"],
  },
  propose_relation: {
    zh: "提交待审关系",
    en: "Propose a relation",
    detailKeys: ["source", "target", "type"],
  },
  f10_pages: {
    zh: "查看财报页面",
    en: "List filing pages",
    detailKeys: ["market", "code"],
  },
  f10_scrape: {
    zh: "抓取财务数据",
    en: "Fetch filing data",
    detailKeys: ["market", "code"],
  },
};

/** Human-readable card content for one ACP tool call. */
export function describeTool(
  call: AgentToolCall,
  lang: TraceLang,
): ToolDescriptor {
  const name = normalizeToolName(call);
  const input = asRecord(call.input);
  const kind = (call.kind ?? "").toLowerCase();
  const urls = [...new Set([...extractUrls(call.input), ...extractUrls(call.output)])];
  const query = pickString(input, [
    "queries",
    "query",
    "q",
    "search_query",
    "pattern",
  ]);
  const url = pickString(input, ["url", "href", "uri"]);
  const company = pickString(input, [
    "company",
    "ticker",
    "ref",
    "name",
    "symbol",
    "id",
  ]);
  const runId = pickString(input, ["runId", "run_id", "jobKey", "jobId"]);
  const error = errorSummary(call);

  if (kind === "search" || name === "web_search" || name === "search") {
    return {
      label: text(lang, "搜索网页", "Web search"),
      detail: humanDetail(query ?? call.title),
      meta: [resultMeta(call.output, lang), domainSummary(urls, lang)]
        .filter(Boolean)
        .join(" · "),
      urls,
    };
  }
  if (kind === "fetch" || name === "web_fetch" || name === "fetch") {
    return {
      label: text(lang, "打开网页", "Open page"),
      detail: humanDetail(url ?? company ?? call.title),
      meta: [httpStatus(call.output), hostOf(url ?? urls[0] ?? "")]
        .filter(Boolean)
        .join(" · "),
      urls,
    };
  }
  if (
    kind === "execute" ||
    name === "bash" ||
    name === "shell" ||
    name === "terminal"
  ) {
    const command = pickString(input, ["description", "command"]);
    return {
      label: text(lang, "运行命令", "Run command"),
      detail: humanDetail(command ?? call.title),
      meta: "",
      urls,
    };
  }

  const mcp = MCP_LABELS[name];
  if (mcp) {
    let detail = "";
    if (name === "f10_pages" || name === "f10_scrape") {
      detail = [pickString(input, ["market"]), pickString(input, ["code"])]
        .filter(Boolean)
        .join(" ");
    } else {
      detail = pickString(input, mcp.detailKeys) ?? "";
    }
    const unit: ResultUnit =
      name === "search_companies"
        ? "companies"
        : name === "search_documents"
          ? "documents"
          : name === "f10_pages"
            ? "pages"
            : "auto";
    let meta = resultMeta(call.output, lang, unit);
    if (name === "deep_research") {
      const resolvedRun =
        runId ?? pickFromOutput(call.output, ["runId", "run_id", "jobKey"]);
      meta = resolvedRun
        ? text(lang, `任务 ${resolvedRun}`, `run ${resolvedRun}`)
        : meta;
    } else if (name === "get_run") {
      const status = pickFromOutput(call.output, ["status", "state"]);
      meta = status ? text(lang, `状态：${status}`, `status: ${status}`) : meta;
    } else if (name === "propose_fact" || name === "propose_relation") {
      meta = text(lang, "已进入审核队列", "Queued for review");
    }
    return {
      label: text(lang, mcp.zh, mcp.en),
      detail: humanDetail(detail || call.title),
      meta,
      urls,
    };
  }

  return {
    label: text(lang, "使用工具", "Use tool"),
    detail: humanDetail(
      query ?? company ?? url ?? call.title ?? normalizeToolName(call),
    ),
    meta: error ? text(lang, "失败", "Failed") : "",
    urls,
  };
}

/** Stable bucket for merging repeated calls of the same kind. */
export function toolGroupKey(call: AgentToolCall): string {
  const name = normalizeToolName(call);
  const kind = (call.kind ?? "").toLowerCase();
  if (kind === "search" || name === "web_search" || name === "search") {
    return "search";
  }
  if (kind === "fetch" || name === "web_fetch" || name === "fetch") {
    return "fetch";
  }
  if (
    kind === "execute" ||
    name === "bash" ||
    name === "shell" ||
    name === "terminal"
  ) {
    return "command";
  }
  if (MCP_LABELS[name]) return `mcp:${name}`;
  return "other";
}

export interface ToolGroup {
  key: string;
  /** Human label, e.g. 搜索网页 / 打开网页 / 查找公司. */
  label: string;
  calls: AgentToolCall[];
  /** Aggregated status: in_progress | completed | failed | cancelled. */
  status: string;
  /** Failed calls inside the group (a mixed group is not wholly failed). */
  failedCount: number;
}

export function groupToolCalls(
  calls: AgentToolCall[],
  lang: TraceLang,
): ToolGroup[] {
  const groups = new Map<string, ToolGroup>();
  for (const call of calls) {
    const key = toolGroupKey(call);
    const existing = groups.get(key);
    if (existing) {
      existing.calls.push(call);
    } else {
      groups.set(key, {
        key,
        label: describeTool(call, lang).label,
        calls: [call],
        status: "completed",
        failedCount: 0,
      });
    }
  }
  for (const group of groups.values()) {
    group.status = aggregateStatus(group.calls);
    group.failedCount = group.calls.filter(
      (call) => call.status === "failed",
    ).length;
  }
  return [...groups.values()];
}

function aggregateStatus(calls: AgentToolCall[]): string {
  if (calls.some((call) => isActiveStatus(call.status))) return "in_progress";
  if (calls.some((call) => call.status === "failed")) return "failed";
  if (calls.every((call) => call.status === "cancelled")) return "cancelled";
  return "completed";
}

/** One human phrase for a merged group, e.g. 「搜索了 4 次网页」. */
export function groupCountLabel(group: ToolGroup, lang: TraceLang): string {
  const count = group.calls.length;
  if (group.key === "search") {
    return lang === "zh"
      ? count === 1
        ? "搜索了网页"
        : `搜索了 ${count} 次网页`
      : count === 1
        ? "Searched the web"
        : `Searched the web ${count}×`;
  }
  if (group.key === "fetch") {
    return text(lang, `打开了 ${count} 个网页`, `Opened ${count} pages`);
  }
  if (group.key === "command") {
    return text(lang, `运行了 ${count} 条命令`, `Ran ${count} commands`);
  }
  return count === 1
    ? group.label
    : text(lang, `${group.label} ${count} 次`, `${group.label} ×${count}`);
}

/** Status line for a merged group; a mixed group reports only its failures. */
export function groupStatusLabel(
  group: ToolGroup,
  lang: TraceLang,
): string {
  if (group.status === "failed") {
    return group.failedCount === group.calls.length
      ? text(lang, "失败", "Failed")
      : text(lang, `${group.failedCount} 个失败`, `${group.failedCount} failed`);
  }
  if (group.status === "cancelled") {
    return text(lang, "已取消", "Cancelled");
  }
  if (group.status === "in_progress") {
    return text(lang, "进行中", "Running");
  }
  return "";
}

export interface ActivityHeadlineOptions {
  elapsedMs?: number;
  streaming: boolean;
  /** Cited sources, appended after the action phrases when finished. */
  sources?: number;
  lang: TraceLang;
}

/**
 * The single collapsed line: "工作了 13s · 搜索了 4 次网页 · 打开了 6 个网页".
 *
 * While streaming it is a live ticker; once finished it becomes the default
 * summary under the answer (the full timeline stays behind the disclosure).
 */
export function activityHeadline(
  calls: AgentToolCall[],
  options: ActivityHeadlineOptions,
): string {
  const lang = options.lang;
  if (options.streaming) {
    const duration =
      typeof options.elapsedMs === "number"
        ? formatDuration(Math.max(options.elapsedMs, 1_000), lang)
        : "";
    return [
      text(lang, "正在研究", "Researching"),
      text(lang, `${calls.length} 步`, `${calls.length} steps`),
      duration,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  const parts: string[] = [];
  if (typeof options.elapsedMs === "number") {
    const duration = formatDuration(options.elapsedMs, lang);
    parts.push(text(lang, `工作了 ${duration}`, `Worked for ${duration}`));
  }
  const groups = groupToolCalls(calls, lang);
  // Lead with the dominant activity (usually web fetches); insertion order is
  // preserved for ties via the stable sort.
  const ranked = [...groups].sort(
    (a, b) => b.calls.length - a.calls.length,
  );
  const shown = ranked.slice(0, 3);
  for (const group of shown) {
    parts.push(groupCountLabel(group, lang));
  }
  if (groups.length > shown.length) {
    parts.push(
      text(
        lang,
        `另有 ${groups.length - shown.length} 类操作`,
        `${groups.length - shown.length} more kinds`,
      ),
    );
  }
  if (options.sources) {
    parts.push(text(lang, `${options.sources} 个来源`, `${options.sources} sources`));
  }
  return parts.join(" · ");
}

/** Deduplicated URLs for the source ledger; cited ones sort first. */
export function buildSourceLedger(
  answer: string,
  calls: AgentToolCall[],
): SourceLink[] {
  const cited = new Set(extractUrls(answer));
  const known = new Map<string, { title?: string }>();

  for (const call of calls) {
    for (const link of extractLinks(call.output)) {
      if (!known.has(link.url)) {
        known.set(link.url, link.title ? { title: link.title } : {});
      }
    }
    for (const url of extractUrls(call.input)) {
      if (!known.has(url)) known.set(url, {});
    }
  }
  for (const url of cited) {
    if (!known.has(url)) known.set(url, {});
  }

  return [...known.entries()]
    .map(([url, meta]) => ({
      url,
      ...(meta.title ? { title: meta.title } : {}),
      domain: hostOf(url),
      cited: cited.has(url),
    }))
    .sort((a, b) => Number(b.cited) - Number(a.cited));
}

/** Stable, short plan lines from ACP `plan.entries`. */
export function planSteps(entries: unknown[]): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string" && entry.trim()) {
      lines.push(truncate(entry, 160));
      continue;
    }
    if (!isRecord(entry)) continue;
    const value = pickString(entry, [
      "content",
      "title",
      "text",
      "step",
      "name",
      "description",
    ]);
    if (value) lines.push(truncate(value, 160));
  }
  return [...new Set(lines)].slice(0, 8);
}

export function formatDuration(ms: number, lang: TraceLang): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1_000) return text(lang, "不到 1 秒", "<1s");
  if (ms < 60_000) {
    const seconds = ms / 1_000;
    return `${seconds >= 10 ? Math.round(seconds) : seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function usageSummary(
  usage: UsageSummary | undefined,
  lang: TraceLang,
): string {
  if (!usage || !Number.isFinite(usage.used) || !Number.isFinite(usage.size)) {
    return "";
  }
  return text(
    lang,
    `用量 ${usage.used.toLocaleString()} / ${usage.size.toLocaleString()} tokens`,
    `Usage ${usage.used.toLocaleString()} / ${usage.size.toLocaleString()} tokens`,
  );
}

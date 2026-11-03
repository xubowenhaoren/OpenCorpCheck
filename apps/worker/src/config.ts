import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Load KEY=VALUE .env files without overriding existing environment values. */
function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
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

export const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

loadEnvFile(path.join(repoRoot, ".env"));
loadEnvFile(path.join(repoRoot, "phase0", ".env"));

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function pathEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  if (!raw) return path.join(repoRoot, fallback);
  return path.isAbsolute(raw) ? raw : path.join(repoRoot, raw);
}

/** First matching env var wins; keeps the old OCC_SECTIONS_DIR working. */
function pathEnvAny(names: string[], fallback: string): string {
  const name = names.find((candidate) => process.env[candidate]);
  return pathEnv(name ?? names[0]!, fallback);
}

/** Secret from env, or from a file named by `<NAME>_FILE`. */
function secretEnv(name: string, fallbackFile?: string): string | undefined {
  const direct = process.env[name]?.trim();
  if (direct) return direct;
  const file = process.env[`${name}_FILE`];
  const candidate = file
    ? path.isAbsolute(file)
      ? file
      : path.join(repoRoot, file)
    : fallbackFile
      ? path.join(repoRoot, fallbackFile)
      : undefined;
  if (!candidate || !fs.existsSync(candidate)) return undefined;
  return fs.readFileSync(candidate, "utf8").trim() || undefined;
}

export const config = {
  repoRoot,
  databaseUrl:
    process.env.DATABASE_URL ?? "postgres://occ@127.0.0.1:5432/occdb",
  financeAnalystUrl:
    process.env.OCC_FINANCE_ANALYST_URL ?? "http://127.0.0.1:8090",
  qdrantUrl: process.env.OCC_QDRANT_URL ?? "http://127.0.0.1:6333",
  qdrantApiKey: process.env.OCC_QDRANT_API_KEY,
  embeddingUrl: process.env.OCC_EMBEDDING_URL ?? "http://127.0.0.1:8080",
  embeddingModel: process.env.OCC_EMBEDDING_MODEL ?? "BAAI/bge-m3",
  embeddingDim: intEnv("OCC_EMBEDDING_DIM", 1024),
  embeddingVersion: process.env.OCC_EMBEDDING_VERSION ?? "bge-m3@1024",
  embeddingTimeoutMs: intEnv("OCC_EMBEDDING_TIMEOUT_MS", 600_000),
  collections: {
    companies: process.env.OCC_QDRANT_COMPANIES ?? "occ_companies",
    documents: process.env.OCC_QDRANT_DOCUMENTS ?? "occ_documents",
  },
  researchConcurrency: intEnv("OCC_RESEARCH_CONCURRENCY", 4),
  f10Concurrency: intEnv("OCC_F10_CONCURRENCY", 4),
  ingestConcurrency: intEnv("OCC_INGEST_CONCURRENCY", 4),
  reviewConcurrency: intEnv("OCC_REVIEW_CONCURRENCY", 4),
  newsConcurrency: intEnv("OCC_NEWS_CONCURRENCY", 2),
  /**
   * Automatic news refresh (decision 29/44). The TTL is deliberately shorter
   * than the daily sweep period so every company is due at the next sweep.
   * Change cron and TTL together, never one without the other.
   */
  newsSweepEnabled:
    process.env.OCC_NEWS_SWEEP !== "none" && process.env.OCC_NEWS_SWEEP !== "off",
  newsSweepCron: process.env.OCC_NEWS_SWEEP_CRON ?? "0 7 * * *",
  newsSweepTz:
    process.env.OCC_NEWS_SWEEP_TZ?.trim() ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    undefined,
  newsTtlMs: intEnv("OCC_NEWS_TTL_MS", 82_800_000), // 23 h
  newsClaimTimeoutMs: intEnv("OCC_NEWS_CLAIM_TIMEOUT_MS", 1_800_000), // 30 min
  newsSweepBatch: intEnv("OCC_NEWS_SWEEP_BATCH", 250),
  /** Sweep history kept for the task dock (3 days by default). */
  newsHistoryMs: intEnv("OCC_NEWS_HISTORY_MS", 259_200_000),
  newsPauseAfterFailures: intEnv("OCC_NEWS_PAUSE_AFTER", 5),
  /**
   * Automatic company-data / filing refresh (P1.5). The daily loop checks
   * official filing indexes; a new periodic report enqueues `financials.company`
   * and a new announcement enqueues `ingest.filing`. Pure code, 0 LLM tokens.
   */
  dataSweepEnabled:
    process.env.OCC_DATA_SWEEP !== "none" && process.env.OCC_DATA_SWEEP !== "off",
  dataSweepCron: process.env.OCC_DATA_SWEEP_CRON ?? "0 8 * * *",
  dataSweepTz:
    process.env.OCC_DATA_SWEEP_TZ?.trim() ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    undefined,
  dataTtlMs: intEnv("OCC_DATA_TTL_MS", 82_800_000), // 23 h
  dataClaimTimeoutMs: intEnv("OCC_DATA_CLAIM_TIMEOUT_MS", 1_800_000), // 30 min
  dataSweepBatch: intEnv("OCC_DATA_SWEEP_BATCH", 500),
  dataHistoryMs: intEnv("OCC_DATA_HISTORY_MS", 259_200_000),
  dataPauseAfterFailures: intEnv("OCC_DATA_PAUSE_AFTER", 5),
  dataConcurrency: intEnv("OCC_DATA_CONCURRENCY", 4),
  /** Cold start window: the first successful check establishes a baseline. */
  dataColdDays: intEnv("OCC_DATA_COLD_DAYS", 30),
  /** Max discovered/ingested filings per source per check. */
  dataMaxItems: intEnv("OCC_DATA_MAX_ITEMS", 20),
  /** Steady-state lookback cap; a long worker outage still covers this window. */
  dataMaxSteadyDays: intEnv("OCC_DATA_MAX_STEADY_DAYS", 30),
  filingsConcurrency: intEnv("OCC_FILINGS_CONCURRENCY", 2),
  filingsDir: pathEnv("OCC_FILINGS_DIR", ".occ/filings"),
  filingsFullText:
    process.env.OCC_FILINGS_FULL_TEXT === "1" ||
    process.env.OCC_FILINGS_FULL_TEXT === "true" ||
    process.env.OCC_FILINGS_FULL_TEXT === "on",
  filingsMaxPages: intEnv("OCC_FILINGS_MAX_PAGES", 80),
  dshHome: pathEnv("OCC_DSH_HOME", "phase0/.dsh-home"),
  runsDir: pathEnv("OCC_RUNS_DIR", ".occ/runs"),
  sectionsDir: pathEnvAny(
    ["OCC_WORKER_SECTIONS_DIR", "OCC_SECTIONS_DIR"],
    ".occ/sections",
  ),
  npmCache: process.env.OCC_NPM_CACHE ?? path.join(os.tmpdir(), "occ-npm-cache"),
  dshVersion: "0.2.1-rc.3",
  /**
   * Headless inference route. Official DeepSeek API + its own search/fetch is
   * the default (2026-10-31: NIM's per-model 429s stalled the HSI batch);
   * `OCC_LLM_PROVIDER=nvidia` opts into the NIM + Parallel free tier through the
   * local retry gateway. The ACP sidebar is never affected by this switch.
   */
  llmProvider:
    process.env.OCC_LLM_PROVIDER === "nvidia"
      ? ("nvidia" as const)
      : ("deepseek" as const),
  model:
    process.env.OCC_RESEARCH_MODEL ??
    (process.env.OCC_LLM_PROVIDER === "nvidia"
      ? "deepseek-ai/deepseek-v4.1-flash"
      : "deepseek-flash"),
  extractModel: process.env.OCC_EXTRACT_MODEL ?? "deepseek-flash",
  /** Reviewer runs on the official API with reasoning on (paid, bounded). */
  reviewModel: process.env.OCC_REVIEW_MODEL ?? "deepseek-flash",
  extractRelations:
    process.env.OCC_EXTRACT_RELATIONS === "llm" ? ("llm" as const) : ("none" as const),
  /** Additive F10 shareholder/investment relations after ingest. */
  f10Relations:
    process.env.OCC_F10_RELATIONS === "none" ? ("none" as const) : ("on" as const),
  /**
   * Structured financial statements (F10 cwfx + SEC EDGAR XBRL). Enabled by
   * default; `none` stops ingest from enqueuing the follow-up stage (the
   * explicit `enqueue financials` command still works).
   */
  financials:
    process.env.OCC_FINANCIALS === "none" ? ("none" as const) : ("on" as const),
  financialsConcurrency: intEnv("OCC_FINANCIALS_CONCURRENCY", 2),
  edgarDir: pathEnv("OCC_EDGAR_DIR", ".occ/edgar"),
  edgarCacheTtlMs: intEnv("OCC_EDGAR_CACHE_TTL_MS", 86_400_000),
  edgarUserAgent:
    process.env.OCC_EDGAR_USER_AGENT?.trim() ||
    "OpenCorpCheck/0.1 (Bowen Xu; xubowenhaoren@gmail.com)",
  deepseekApiKey: secretEnv("DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY.txt"),
  nvidiaApiKey: secretEnv("NVIDIA_API_KEY", "NVIDIA_API_KEY.txt"),
  nimBaseUrl:
    process.env.OCC_NIM_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
  nimGatewayPort: intEnv("OCC_NIM_GATEWAY_PORT", 4010),
  nimGatewayUrl:
    process.env.OCC_NIM_GATEWAY_URL ??
    `http://127.0.0.1:${intEnv("OCC_NIM_GATEWAY_PORT", 4010)}/v1`,
  /** Free-tier 429s were observed at 36 RPM under a 6-company fan-out. */
  nimRpm: intEnv("OCC_NIM_RPM", 20),
  nimRetries: intEnv("OCC_NIM_RETRIES", 3),
  nimRequestTimeoutMs: intEnv("OCC_NIM_REQUEST_TIMEOUT_MS", 600_000),
  researchTimeoutMs: intEnv("OCC_RESEARCH_TIMEOUT_MS", 1_800_000),
  reviewTimeoutMs: intEnv("OCC_REVIEW_TIMEOUT_MS", 480_000),
  reviewMaxCycles: intEnv("OCC_REVIEW_MAX_CYCLES", 2),
  /** Malformed reviewer JSON is re-run this many times before needs_review. */
  reviewParseAttempts: intEnv("OCC_REVIEW_PARSE_ATTEMPTS", 2),
  permissionMode: "read-only",
  promptTemplate: path.join(repoRoot, "phase0", "prompts", "company.md"),
  mockSection: path.join(repoRoot, "phase0", "fixtures", "mock-section.md"),
  basePatch: path.join(repoRoot, "phase0", "dsh.patch.yml"),
  deepseekPatch: path.join(repoRoot, "phase0", "dsh-deepseek.patch.yml"),
  parallelPatch: path.join(repoRoot, "phase0", "parallel.patch.yml"),
  reviewerPatch: path.join(repoRoot, "phase0", "reviewer.patch.yml"),
  f10Patch: path.join(repoRoot, "phase0", "f10-mcp.patch.yml"),
  universeFile: path.join(repoRoot, "config", "universe.yaml"),
  indicesDir: path.join(repoRoot, "config", "indices"),
  ndxFile: path.join(repoRoot, "config", "indices", "ndx.yaml"),
  /** Local F10 page JSON snapshots (structured relation extraction). */
  f10Dir: pathEnv("OCC_F10_DIR", ".occ/f10"),
};

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function publicConfig(): Record<string, unknown> {
  return {
    databaseUrl: config.databaseUrl.replace(/\/\/[^@]*@/, "//***@"),
    financeAnalystUrl: config.financeAnalystUrl,
    researchConcurrency: config.researchConcurrency,
    f10Concurrency: config.f10Concurrency,
    ingestConcurrency: config.ingestConcurrency,
    reviewConcurrency: config.reviewConcurrency,
    newsConcurrency: config.newsConcurrency,
    newsSweepEnabled: config.newsSweepEnabled,
    newsSweepCron: config.newsSweepCron,
    newsTtlMs: config.newsTtlMs,
    newsClaimTimeoutMs: config.newsClaimTimeoutMs,
    newsSweepBatch: config.newsSweepBatch,
    newsHistoryMs: config.newsHistoryMs,
    dataSweepEnabled: config.dataSweepEnabled,
    dataSweepCron: config.dataSweepCron,
    dataTtlMs: config.dataTtlMs,
    dataClaimTimeoutMs: config.dataClaimTimeoutMs,
    dataSweepBatch: config.dataSweepBatch,
    dataHistoryMs: config.dataHistoryMs,
    dataConcurrency: config.dataConcurrency,
    dataColdDays: config.dataColdDays,
    dataMaxItems: config.dataMaxItems,
    filingsDir: config.filingsDir,
    dshHome: config.dshHome,
    runsDir: config.runsDir,
    sectionsDir: config.sectionsDir,
    model: config.model,
    llmProvider: config.llmProvider,
    reviewModel: config.reviewModel,
    nimGatewayUrl: config.nimGatewayUrl,
    nimRpm: config.nimRpm,
    f10Dir: config.f10Dir,
    edgarDir: config.edgarDir,
    financials: config.financials,
    qdrantUrl: config.qdrantUrl,
    embeddingUrl: config.embeddingUrl,
  };
}

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
  reviewConcurrency: intEnv("OCC_REVIEW_CONCURRENCY", 2),
  newsConcurrency: intEnv("OCC_NEWS_CONCURRENCY", 2),
  dshHome: pathEnv("OCC_DSH_HOME", "phase0/.dsh-home"),
  runsDir: pathEnv("OCC_RUNS_DIR", ".occ/runs"),
  sectionsDir: pathEnvAny(
    ["OCC_WORKER_SECTIONS_DIR", "OCC_SECTIONS_DIR"],
    ".occ/sections",
  ),
  npmCache: process.env.OCC_NPM_CACHE ?? path.join(os.tmpdir(), "occ-npm-cache"),
  dshVersion: "0.2.1-rc.3",
  /**
   * Headless inference route. The worker uses NIM through the local retry
   * gateway by default; `OCC_LLM_PROVIDER=deepseek` rolls back to the official
   * DeepSeek API (the ACP sidebar is never affected by this switch).
   */
  llmProvider:
    process.env.OCC_LLM_PROVIDER === "deepseek"
      ? ("deepseek" as const)
      : ("nvidia" as const),
  model:
    process.env.OCC_RESEARCH_MODEL ??
    (process.env.OCC_LLM_PROVIDER === "deepseek"
      ? "deepseek-flash"
      : "deepseek-ai/deepseek-v4.1-flash"),
  extractModel: process.env.OCC_EXTRACT_MODEL ?? "deepseek-flash",
  /** Reviewer runs on the official API with reasoning on (paid, bounded). */
  reviewModel: process.env.OCC_REVIEW_MODEL ?? "deepseek-flash",
  extractRelations:
    process.env.OCC_EXTRACT_RELATIONS === "llm" ? ("llm" as const) : ("none" as const),
  /** Additive F10 shareholder/investment relations after ingest. */
  f10Relations:
    process.env.OCC_F10_RELATIONS === "none" ? ("none" as const) : ("on" as const),
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
    dshHome: config.dshHome,
    runsDir: config.runsDir,
    sectionsDir: config.sectionsDir,
    model: config.model,
    llmProvider: config.llmProvider,
    reviewModel: config.reviewModel,
    nimGatewayUrl: config.nimGatewayUrl,
    nimRpm: config.nimRpm,
    f10Dir: config.f10Dir,
    qdrantUrl: config.qdrantUrl,
    embeddingUrl: config.embeddingUrl,
  };
}

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
  dshHome: pathEnv("OCC_DSH_HOME", "phase0/.dsh-home"),
  runsDir: pathEnv("OCC_RUNS_DIR", "phase0/runs"),
  sectionsDir: pathEnv("OCC_SECTIONS_DIR", "phase0/out/sections"),
  npmCache: process.env.OCC_NPM_CACHE ?? path.join(os.tmpdir(), "occ-npm-cache"),
  dshVersion: "0.2.1-rc.3",
  model: process.env.OCC_RESEARCH_MODEL ?? "deepseek-flash",
  permissionMode: "read-only",
  promptTemplate: path.join(repoRoot, "phase0", "prompts", "company.md"),
  mockSection: path.join(repoRoot, "phase0", "fixtures", "mock-section.md"),
  basePatch: path.join(repoRoot, "phase0", "dsh.patch.yml"),
  f10Patch: path.join(repoRoot, "phase0", "f10-mcp.patch.yml"),
  universeFile: path.join(repoRoot, "config", "universe.yaml"),
  ndxFile: path.join(repoRoot, "config", "indices", "ndx.yaml"),
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
    dshHome: config.dshHome,
    runsDir: config.runsDir,
    sectionsDir: config.sectionsDir,
    model: config.model,
    qdrantUrl: config.qdrantUrl,
    embeddingUrl: config.embeddingUrl,
  };
}

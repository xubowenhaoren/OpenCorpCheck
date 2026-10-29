import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === "true" || raw === "1";
}

/** Read a secret from env, an explicit file, or the conventional local file. */
function secretEnv(
  name: string,
  fileEnv: string,
  defaultFile: string,
): string | undefined {
  const direct = process.env[name]?.trim();
  if (direct) return direct;
  const file = process.env[fileEnv] ?? defaultFile;
  const resolved = path.isAbsolute(file) ? file : path.join(repoRoot, file);
  if (!fs.existsSync(resolved)) return undefined;
  return fs.readFileSync(resolved, "utf8").trim() || undefined;
}

export const config = {
  repoRoot,
  databaseUrl: process.env.DATABASE_URL ?? "postgres://occ@127.0.0.1:5432/occdb",
  apiPort: intEnv("OCC_API_PORT", 8787),
  qdrantUrl: process.env.OCC_QDRANT_URL ?? "http://127.0.0.1:6333",
  qdrantApiKey: process.env.OCC_QDRANT_API_KEY,
  embeddingUrl: process.env.OCC_EMBEDDING_URL ?? "http://127.0.0.1:8080",
  embeddingModel: process.env.OCC_EMBEDDING_MODEL ?? "BAAI/bge-m3",
  embeddingDim: intEnv("OCC_EMBEDDING_DIM", 1024),
  embeddingVersion:
    process.env.OCC_EMBEDDING_VERSION ?? "bge-m3@1024",
  embeddingTimeoutMs: intEnv("OCC_EMBEDDING_TIMEOUT_MS", 600_000),
  rerankEnabled: boolEnv("OCC_RERANK_ENABLED", false),
  researchModel: process.env.OCC_RESEARCH_MODEL ?? "deepseek-flash",
  financeAnalystUrl:
    process.env.OCC_FINANCE_ANALYST_URL ?? "http://127.0.0.1:8090",
  dshVersion: process.env.OCC_DSH_VERSION ?? "0.2.1-rc.3",
  dshHome:
    process.env.OCC_DSH_HOME ??
    path.join(repoRoot, "phase0", ".dsh-home"),
  /** ACP uses zstd session logs; keep it out of the plaintext Phase 0 home. */
  agentDshHome:
    process.env.OCC_AGENT_DSH_HOME ??
    path.join(repoRoot, ".occ", "dsh-acp-home"),
  npmCache:
    process.env.OCC_NPM_CACHE ?? path.join(os.tmpdir(), "occ-npm-cache"),
  mcpEntry: path.join(repoRoot, "apps", "cli", "dist", "mcp.js"),
  agentEnabled: boolEnv("OCC_AGENT_ENABLED", true),
  agentPermissionMode: process.env.OCC_AGENT_PERMISSION_MODE ?? "read-only",
  deepseekApiKey: secretEnv(
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_API_KEY_FILE",
    "DEEPSEEK_API_KEY.txt",
  ),
  rerankUrl: process.env.OCC_RERANK_URL ?? process.env.OCC_EMBEDDING_URL ?? "http://127.0.0.1:8080",
  rerankModel: process.env.OCC_RERANK_MODEL ?? "BAAI/bge-reranker-v2-m3",
  collections: {
    companies: process.env.OCC_QDRANT_COMPANIES ?? "occ_companies",
    documents: process.env.OCC_QDRANT_DOCUMENTS ?? "occ_documents",
  },
  fusion: (process.env.OCC_FUSION ?? "rrf") as "rrf" | "dbsf",
  rrfK: intEnv("OCC_RRF_K", 60),
  prefetchLimit: intEnv("OCC_PREFETCH_LIMIT", 100),
};

export function publicConfig(): Record<string, unknown> {
  return {
    databaseUrl: config.databaseUrl.replace(/\/\/[^@]*@/, "//***@"),
    apiPort: config.apiPort,
    qdrantUrl: config.qdrantUrl,
    embeddingUrl: config.embeddingUrl,
    embeddingModel: config.embeddingModel,
    embeddingDim: config.embeddingDim,
    rerankEnabled: config.rerankEnabled,
    collections: config.collections,
    fusion: config.fusion,
  };
}

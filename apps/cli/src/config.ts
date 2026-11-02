import fs from "node:fs";
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

/** Read a secret from env, or from an explicitly named file (never auto-guess). */
function secretEnv(name: string, fileEnv: string): string | undefined {
  const direct = process.env[name]?.trim();
  if (direct) return direct;
  const file = process.env[fileEnv];
  if (!file) return undefined;
  const resolved = path.isAbsolute(file) ? file : path.join(repoRoot, file);
  if (!fs.existsSync(resolved)) return undefined;
  return fs.readFileSync(resolved, "utf8").trim() || undefined;
}

export const config = {
  repoRoot,
  apiUrl: process.env.OCC_API_URL ?? "http://127.0.0.1:8787",
  databaseUrl: process.env.DATABASE_URL ?? "postgres://occ@127.0.0.1:5432/occdb",
  qdrantUrl: process.env.OCC_QDRANT_URL ?? "http://127.0.0.1:6333",
  qdrantApiKey: process.env.OCC_QDRANT_API_KEY,
  embeddingUrl: process.env.OCC_EMBEDDING_URL ?? "http://127.0.0.1:8080",
  embeddingModel: process.env.OCC_EMBEDDING_MODEL ?? "BAAI/bge-m3",
  embeddingDim: intEnv("OCC_EMBEDDING_DIM", 1024),
  embeddingVersion: process.env.OCC_EMBEDDING_VERSION ?? "bge-m3@1024",
  embeddingTimeoutMs: intEnv("OCC_EMBEDDING_TIMEOUT_MS", 600_000),
  deepseekApiKey: secretEnv("DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY_FILE"),
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  extractModel: process.env.OCC_EXTRACT_MODEL ?? "deepseek-flash",
  sectionsDir:
    process.env.OCC_SECTIONS_DIR ?? path.join(repoRoot, "phase0", "out", "sections"),
  ndxFile: path.join(repoRoot, "config", "indices", "ndx.yaml"),
  a500File: path.join(repoRoot, "config", "indices", "a500.yaml"),
  sp500File: path.join(repoRoot, "config", "indices", "sp500.yaml"),
  collections: {
    companies: process.env.OCC_QDRANT_COMPANIES ?? "occ_companies",
    documents: process.env.OCC_QDRANT_DOCUMENTS ?? "occ_documents",
  },
};

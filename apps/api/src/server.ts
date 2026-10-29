import { serve } from "@hono/node-server";
import { createDb } from "@occ/db";
import { JobStore, startBoss } from "@occ/jobs";
import {
  HttpEmbeddingClient,
  HttpRerankClient,
  NoopRerankClient,
  QdrantClient,
  SearchEngine,
} from "@occ/retrieval";

import { createApp, type HealthReport } from "./app.js";
import { config, publicConfig } from "./config.js";
import { AgentService } from "./services/agent.js";
import { CompanyService } from "./services/company.js";
import { ResearchService } from "./services/research.js";
import { ReviewService } from "./services/review.js";
import { SearchService } from "./services/search.js";

const { db, pool } = createDb(config.databaseUrl);

const qdrant = new QdrantClient({
  url: config.qdrantUrl,
  apiKey: config.qdrantApiKey,
});

const embeddings = new HttpEmbeddingClient({
  baseUrl: config.embeddingUrl,
  model: config.embeddingModel,
  dim: config.embeddingDim,
  version: config.embeddingVersion,
  timeoutMs: config.embeddingTimeoutMs,
});

const reranker = config.rerankEnabled
  ? new HttpRerankClient(config.rerankUrl, config.rerankModel)
  : new NoopRerankClient();

const engine = new SearchEngine({
  qdrant,
  embeddings,
  collections: config.collections,
  fusion: config.fusion,
  rrfK: config.rrfK,
  prefetchLimit: config.prefetchLimit,
});

const search = new SearchService({ db, engine, reranker });
const company = new CompanyService(db);
const review = new ReviewService(db);

// Research enqueue shares the worker's pg-boss queues and run tables. The API
// process owns its own PgBoss handle so agents can queue work without spawning
// the worker CLI.
const jobStore = new JobStore(config.databaseUrl, 5, "occ-api");
await jobStore.migrate();
const boss = await startBoss({
  connectionString: config.databaseUrl,
  applicationName: "occ-api",
});
const research = new ResearchService({ db, store: jobStore, boss });
const agent = new AgentService({
  apiUrl: `http://127.0.0.1:${config.apiPort}`,
  repoRoot: config.repoRoot,
  dshVersion: config.dshVersion,
  dshHome: config.agentDshHome,
  npmCache: config.npmCache,
  mcpEntry: config.mcpEntry,
  financeAnalystUrl: config.financeAnalystUrl,
  deepseekApiKey: config.deepseekApiKey,
  permissionMode: config.agentPermissionMode,
  enabled: config.agentEnabled,
  dshPatch: config.agentDshPatch,
  turnTimeoutMs: config.agentTurnTimeoutMs,
  maxToolCalls: config.agentMaxToolCalls,
  maxRepeatedToolCalls: config.agentMaxRepeatedToolCalls,
  idleTimeoutMs: config.agentIdleTimeoutMs,
});

async function health(): Promise<HealthReport> {
  const [database, qdrantOk, embeddingReport] = await Promise.all([
    pool
      .query("SELECT 1")
      .then(() => ({ ok: true }))
      .catch((error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })),
    qdrant.health(),
    checkEmbeddings(),
  ]);
  return {
    ok: database.ok && qdrantOk && embeddingReport.ok,
    database,
    qdrant: { ok: qdrantOk },
    embeddings: embeddingReport,
  };
}

async function checkEmbeddings(): Promise<{
  ok: boolean;
  model?: string;
  loaded?: boolean;
  error?: string;
}> {
  try {
    const response = await fetch(`${config.embeddingUrl.replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const json = (await response.json()) as {
      model?: string;
      loaded?: boolean;
    };
    return { ok: true, model: json.model, loaded: json.loaded };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const app = createApp({ search, company, research, review, agent, health });

const server = serve(
  { fetch: app.fetch, port: config.apiPort, hostname: "127.0.0.1" },
  (info) => {
    console.log(
      JSON.stringify({
        level: "info",
        msg: "occ api listening",
        port: info.port,
        config: publicConfig(),
      }),
    );
  },
);

async function shutdown(signal: string): Promise<void> {
  console.log(JSON.stringify({ level: "info", msg: "shutting down", signal }));
  server.close();
  await boss.stop({ graceful: false }).catch(() => undefined);
  await agent.dispose().catch(() => undefined);
  await jobStore.close().catch(() => undefined);
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

import {
  createIngestContext,
  type IngestContext,
} from "@occ/ingest";

import { config } from "./config.js";

let runtime: Promise<{ ctx: IngestContext; close: () => Promise<void> }> | null = null;

/**
 * One shared ingest context per worker process: a small Postgres pool, the
 * Qdrant client, and the embedding client. Jobs run concurrently through it.
 */
export function getIngestContext(): Promise<IngestContext> {
  if (!runtime) {
    runtime = createIngestContext({
      databaseUrl: config.databaseUrl,
      qdrantUrl: config.qdrantUrl,
      qdrantApiKey: config.qdrantApiKey,
      embeddingUrl: config.embeddingUrl,
      embeddingModel: config.embeddingModel,
      embeddingDim: config.embeddingDim,
      embeddingVersion: config.embeddingVersion,
      embeddingTimeoutMs: config.embeddingTimeoutMs,
      collections: config.collections,
    });
  }
  return runtime.then((entry) => entry.ctx);
}

export async function closeIngestRuntime(): Promise<void> {
  if (!runtime) return;
  const entry = await runtime;
  runtime = null;
  await entry.close();
}

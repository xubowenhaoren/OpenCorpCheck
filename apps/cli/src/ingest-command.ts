import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  createIngestContext,
  exchangeForMarket,
  ingestSections,
  loadIndexSnapshot,
  parseTicker,
  type IngestBatchItem,
  type IngestTarget,
  type IndexSnapshot,
} from "@occ/ingest";

import { config } from "./config.js";

const USAGE_OPTIONS = `
Ingest options:
  --sections <dir>       Section markdown directory (default phase0/out/sections)
  --index <code>         Index snapshot for ticker metadata (default NDX; none to disable)
  --tickers A,B:C        Only ingest these tickers
  --market A|HK|US       Default market for bare US/ambiguous filenames
  --concurrency N        Parallel companies (default 4)
  --force                Rewrite unchanged sections and re-index
  --skip-index           Write Postgres only; do not touch Qdrant
  --limit N              Cap the number of sections
  --json                 Machine-readable summary
`;

export async function ingestCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      sections: { type: "string" },
      index: { type: "string" },
      tickers: { type: "string" },
      market: { type: "string" },
      concurrency: { type: "string" },
      force: { type: "boolean" },
      "skip-index": { type: "boolean" },
      limit: { type: "string" },
      json: { type: "boolean" },
    },
  });

  const sectionsDir = path.resolve(values.sections ?? config.sectionsDir);
  if (!fs.existsSync(sectionsDir)) {
    throw new Error(`sections directory not found: ${sectionsDir}`);
  }

  const defaultMarket = parseMarket(values.market ?? "US");
  const indexCode = values.index ?? "NDX";
  const snapshot =
    indexCode.trim().toLowerCase() === "none" ? undefined : loadSnapshot(indexCode);
  const items = collectItems(sectionsDir, snapshot, defaultMarket, {
    tickers: values.tickers,
    limit: values.limit ? Number(values.limit) : undefined,
  });
  if (items.length === 0) {
    throw new Error(`no section files matched in ${sectionsDir}`);
  }

  const concurrency = positiveInt(values.concurrency, 4);
  const { ctx, close } = await createIngestContext({
    databaseUrl: config.databaseUrl,
    qdrantUrl: config.qdrantUrl,
    qdrantApiKey: config.qdrantApiKey,
    embeddingUrl: config.embeddingUrl,
    embeddingModel: config.embeddingModel,
    embeddingDim: config.embeddingDim,
    embeddingVersion: config.embeddingVersion,
    embeddingTimeoutMs: config.embeddingTimeoutMs,
    collections: config.collections,
    skipIndex: Boolean(values["skip-index"]),
  });

  try {
    const result = await ingestSections(ctx, items, {
      concurrency,
      force: Boolean(values.force),
      skipIndex: Boolean(values["skip-index"]),
      onProgress: (item) => {
        if (values.json) return;
        console.error(
          JSON.stringify({
            event: "ingest_section",
            key: item.key,
            slug: item.slug,
            skipped: item.skipped,
            chunks: item.chunks,
            indexedChunks: item.indexedChunks,
          }),
        );
      },
    });

    if (values.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        `ingested ${result.processed}/${result.total} sections ` +
          `(${result.skipped} unchanged) · chunks=${result.chunks} ` +
          `indexed=${result.indexedChunks} failed=${result.failed.length}`,
      );
      for (const failure of result.failed) {
        console.error(`  FAIL ${failure.key}: ${failure.error}`);
      }
    }
    if (result.failed.length > 0) process.exitCode = 1;
  } finally {
    await close();
  }
}

interface CollectOptions {
  tickers?: string;
  limit?: number;
}

function collectItems(
  sectionsDir: string,
  snapshot: IndexSnapshot | undefined,
  defaultMarket: "A" | "HK" | "US",
  options: CollectOptions,
): IngestBatchItem[] {
  const constituents = new Map(
    (snapshot?.constituents ?? []).map((entry) => [
      entry.ticker.toUpperCase(),
      entry,
    ]),
  );
  const wanted = options.tickers
    ? new Set(
        options.tickers
          .split(",")
          .map((raw) => parseTicker(raw, defaultMarket)?.key)
          .filter((key): key is string => Boolean(key)),
      )
    : null;

  const files = fs
    .readdirSync(sectionsDir)
    .filter((file) => file.endsWith(".md"))
    .sort();

  const items: IngestBatchItem[] = [];
  for (const file of files) {
    const ticker = path.basename(file, ".md");
    const target = targetFor(ticker, constituents.get(ticker.toUpperCase()), snapshot, defaultMarket);
    if (!target) {
      console.error(JSON.stringify({ event: "ingest_skip_bad_ticker", file }));
      continue;
    }
    if (wanted && !wanted.has(target.key)) continue;
    items.push({
      target,
      sectionPath: path.join(sectionsDir, file),
    });
    if (options.limit && items.length >= options.limit) break;
  }
  return items;
}

function targetFor(
  ticker: string,
  constituent: IndexSnapshot["constituents"][number] | undefined,
  snapshot: IndexSnapshot | undefined,
  defaultMarket: "A" | "HK" | "US",
): IngestTarget | null {
  if (constituent && snapshot) {
    return {
      key: `US:${constituent.ticker}`,
      ticker: constituent.ticker,
      name: constituent.name,
      market: "US",
      code: constituent.ticker,
      exchange: constituent.exchange,
      country: "US",
      indexCode: snapshot.index.code,
      indexAsOf: snapshot.index.as_of,
      coverageTier: "index_member",
    };
  }
  const parsed = parseTicker(ticker, defaultMarket);
  if (!parsed) return null;
  return {
    key: parsed.key,
    ticker: parsed.ticker,
    name: parsed.ticker,
    market: parsed.market,
    code: parsed.code,
    exchange: exchangeForMarket(parsed.market, parsed.code),
  };
}

function loadSnapshot(code: string): IndexSnapshot {
  const normalized = code.trim().toUpperCase();
  if (normalized === "NDX") return loadIndexSnapshot(config.ndxFile);
  throw new Error(`unknown index ${code}; supported: NDX`);
}

function parseMarket(value: string): "A" | "HK" | "US" {
  const normalized = value.trim().toUpperCase();
  if (normalized === "A" || normalized === "HK" || normalized === "US") {
    return normalized;
  }
  throw new Error(`unknown market ${value}; use A, HK or US`);
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export { USAGE_OPTIONS };

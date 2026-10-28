#!/usr/bin/env node
import { parseArgs } from "node:util";

import { config } from "./config.js";
import { ingestCommand, USAGE_OPTIONS as INGEST_OPTIONS } from "./ingest-command.js";
import { seed } from "./seed.js";
import { syncFixtures } from "./sync-fixtures.js";

const USAGE = `occ — OpenCorpCheck CLI

Usage:
  occ migrate
  occ seed [--reset] [--skip-index]
  occ ingest [options]
  occ sync-fixtures [--dry-run]
  occ search <query> [--mode hybrid|keyword|semantic] [--limit N] [--explain] [--json]
  occ documents <query> [--mode ...] [--limit N] [--company ID] [--json]
  occ company <id-or-slug> [--json]
  occ health
  occ config
${INGEST_OPTIONS}
Environment:
  OCC_API_URL           default http://127.0.0.1:8787
  DATABASE_URL          default postgres://occ@127.0.0.1:5432/occdb
  OCC_QDRANT_URL        default http://127.0.0.1:6333
  OCC_EMBEDDING_URL     default http://127.0.0.1:8080
  OCC_SECTIONS_DIR      default phase0/out/sections
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "migrate": {
      const { migrate } = await import("@occ/db");
      const applied = await migrate(config.databaseUrl);
      console.log(applied.length > 0 ? applied.join("\n") : "already up to date");
      return;
    }
    case "seed": {
      const { values } = parseArgs({
        args: rest,
        options: {
          reset: { type: "boolean" },
          "skip-index": { type: "boolean" },
        },
      });
      const result = await seed({
        reset: Boolean(values.reset),
        skipIndex: Boolean(values["skip-index"]),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "ingest":
      await ingestCommand(rest);
      return;
    case "sync-fixtures": {
      const { values } = parseArgs({
        args: rest,
        options: { "dry-run": { type: "boolean" } },
      });
      const result = await syncFixtures({ dryRun: Boolean(values["dry-run"]) });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "search":
      await searchCommand(rest, "companies");
      return;
    case "documents":
      await searchCommand(rest, "documents");
      return;
    case "company": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { json: { type: "boolean" } },
      });
      if (!positionals[0]) throw new Error("company requires an id or slug");
      const body = await api(
        `/v1/companies/${encodeURIComponent(positionals[0])}`,
      );
      if (values.json) {
        console.log(JSON.stringify(body, null, 2));
        return;
      }
      const data = (body as { data: Record<string, unknown> }).data;
      console.log(`${data.displayName} (${data.slug})`);
      console.log(`  legal name : ${data.legalName}`);
      console.log(`  coverage   : ${data.coverageTier}`);
      console.log(`  sector     : ${data.sector}`);
      console.log(`  aliases    : ${(data.aliases as string[]).join(", ")}`);
      console.log(
        `  tickers    : ${(data.tickers as Array<{ ticker: string; exchange: string }>)
          .map((ticker) => `${ticker.exchange}:${ticker.ticker}`)
          .join(", ")}`,
      );
      return;
    }
    case "health": {
      const body = await api("/v1/health");
      console.log(JSON.stringify(body, null, 2));
      return;
    }
    case "config": {
      console.log(
        JSON.stringify(
          {
            apiUrl: config.apiUrl,
            databaseUrl: config.databaseUrl.replace(/\/\/[^@]*@/, "//***@"),
            qdrantUrl: config.qdrantUrl,
            embeddingUrl: config.embeddingUrl,
            collections: config.collections,
          },
          null,
          2,
        ),
      );
      return;
    }
    case "help":
    case "-h":
    case "--help":
    case undefined:
      console.log(USAGE);
      return;
    default:
      console.error(`unknown command: ${command}\n`);
      console.error(USAGE);
      process.exitCode = 2;
  }
}

async function searchCommand(
  args: string[],
  kind: "companies" | "documents",
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      mode: { type: "string", default: "hybrid" },
      limit: { type: "string", default: "10" },
      explain: { type: "boolean" },
      "include-fixtures": { type: "boolean" },
      json: { type: "boolean" },
      company: { type: "string" },
    },
  });
  const query = positionals.join(" ").trim();
  if (!query) throw new Error(`${kind} search requires a query`);
  const url = new URL(`/v1/search/${kind}`, config.apiUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("mode", values.mode!);
  url.searchParams.set("limit", values.limit!);
  if (values.explain) url.searchParams.set("explain", "true");
  if (values["include-fixtures"]) url.searchParams.set("include_fixtures", "true");
  if (values.company) url.searchParams.set("company_id", values.company);

  const body = await api(`${url.pathname}${url.search}`);
  if (values.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  const payload = body as {
    data: {
      hits: Array<Record<string, unknown>>;
      explain?: {
        branches: { bm25: unknown[]; dense: unknown[] };
        fusion: unknown[];
        timings: Record<string, number>;
      };
    };
    meta: Record<string, unknown>;
  };
  console.log(
    `${payload.meta.mode} · ${payload.meta.total} hits · ${payload.meta.took_ms}ms · ${payload.meta.fusion}`,
  );
  for (const hit of payload.data.hits) {
    if (kind === "companies") {
      const tickers = (hit.tickers as Array<{ exchange: string; ticker: string }>)
        .map((ticker) => `${ticker.exchange}:${ticker.ticker}`)
        .join(",");
      console.log(
        `${Number(hit.score).toFixed(4)}  ${String(hit.matchType).padEnd(9)} ${String(hit.displayName).padEnd(30)} ${tickers}`,
      );
    } else {
      console.log(
        `${Number(hit.score).toFixed(4)}  ${String(hit.companyDisplayName ?? hit.companyId).padEnd(20)} ${String(hit.title ?? "").slice(0, 50)}`,
      );
      console.log(`        ${String(hit.text).slice(0, 160).replace(/\s+/g, " ")}`);
    }
  }
  if (payload.data.explain) {
    const explain = payload.data.explain;
    console.log(
      `explain: bm25=${explain.branches.bm25.length} dense=${explain.branches.dense.length} fused=${explain.fusion.length} qdrant=${explain.timings.qdrantMs}ms`,
    );
  }
}

async function api(path: string): Promise<unknown> {
  const response = await fetch(`${config.apiUrl.replace(/\/+$/, "")}${path}`);
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`API ${response.status}: ${text.slice(0, 500)}`);
  }
  return body;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

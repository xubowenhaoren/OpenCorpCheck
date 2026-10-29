#!/usr/bin/env node
import { parseArgs } from "node:util";

import { config } from "./config.js";
import {
  aliasesCommand,
  USAGE_OPTIONS as ALIASES_OPTIONS,
} from "./aliases-command.js";
import { extractCommand, USAGE_OPTIONS as EXTRACT_OPTIONS } from "./extract-command.js";
import { ingestCommand, USAGE_OPTIONS as INGEST_OPTIONS } from "./ingest-command.js";
import { seed } from "./seed.js";
import {
  snapshotsCommand,
  USAGE_OPTIONS as SNAPSHOTS_OPTIONS,
} from "./snapshots-command.js";
import { syncFixtures } from "./sync-fixtures.js";

const USAGE = `occ — OpenCorpCheck CLI

Usage:
  occ migrate
  occ seed [--reset] [--skip-index]
  occ ingest [options]
  occ sync-fixtures [--dry-run]
  occ aliases sync [options]
  occ snapshots upload|check|list [options]
  occ search <query> [--mode hybrid|keyword|semantic] [--limit N] [--explain] [--json]
  occ documents <query> [--mode ...] [--limit N] [--company ID] [--json]
  occ company <id-or-ticker> [--include financials,facts,relations,events] [--json]
  occ review list [--status pending] [--kind fact|relation] [--limit N] [--json]
  occ review approve [--ids i1,i2 | --kind fact|relation [--company REF] | --all --yes]
                     [--limit N] [--reviewer NAME] [--dry-run] [--json]
  occ review reject  (... same filters ...)
  occ propose fact --company <ref> --predicate <p> --value <json> [--quote ...] [--source-url ...] [--json]
  occ propose relation --src <ref> --dst <ref> --type <t> [--quote ...] [--source-url ...] [--json]
  occ extract [options]
  occ health
  occ config
${INGEST_OPTIONS}
${EXTRACT_OPTIONS}
${ALIASES_OPTIONS}
${SNAPSHOTS_OPTIONS}
Environment:
  OCC_API_URL           default http://127.0.0.1:8787
  DATABASE_URL          default postgres://occ@127.0.0.1:5432/occdb
  OCC_QDRANT_URL        default http://127.0.0.1:6333
  OCC_EMBEDDING_URL     default http://127.0.0.1:8080
  OCC_SECTIONS_DIR      default phase0/out/sections
  DEEPSEEK_API_KEY      required for occ extract --relations llm
  DEEPSEEK_API_KEY_FILE optional file containing the key
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
    case "aliases":
      await aliasesCommand(rest);
      return;
    case "snapshots":
      await snapshotsCommand(rest);
      return;
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
        options: {
          json: { type: "boolean" },
          include: { type: "string" },
        },
      });
      if (!positionals[0]) throw new Error("company requires an id, slug or ticker");
      const url = new URL(
        `/v1/companies/${encodeURIComponent(positionals[0])}`,
        config.apiUrl,
      );
      if (values.include) url.searchParams.set("include", values.include);
      const body = await api(`${url.pathname}${url.search}`);
      if (values.json) {
        console.log(JSON.stringify(body, null, 2));
        return;
      }
      printCompanyCard(body);
      return;
    }
    case "review":
      await reviewCommand(rest);
      return;
    case "propose": {
      await proposeCommand(rest);
      return;
    }
    case "extract":
      await extractCommand(rest);
      return;
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

async function reviewCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === "list") {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        status: { type: "string" },
        kind: { type: "string" },
        limit: { type: "string", default: "50" },
        json: { type: "boolean" },
      },
    });
    const url = new URL("/v1/review/queue", config.apiUrl);
    if (values.status) url.searchParams.set("status", values.status);
    if (values.kind) url.searchParams.set("kind", values.kind);
    url.searchParams.set("limit", values.limit!);
    const body = await api(`${url.pathname}${url.search}`);
    if (values.json) {
      console.log(JSON.stringify(body, null, 2));
      return;
    }
    const data = (
      body as { data: { items: Array<Record<string, unknown>>; total: number } }
    ).data;
    console.log(`${data.total} review items`);
    for (const item of data.items) {
      console.log(
        `${String(item.id).padEnd(30)} ${String(item.kind).padEnd(8)} ${String(item.status).padEnd(8)} ${String(item.createdAt).slice(0, 19)}`,
      );
    }
    return;
  }

  if (subcommand !== "approve" && subcommand !== "reject") {
    throw new Error(
      "usage: occ review list | approve | reject [--ids ...] [--kind ...] [--company ...] [--all --yes]",
    );
  }

  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      ids: { type: "string" },
      kind: { type: "string" },
      company: { type: "string" },
      all: { type: "boolean" },
      yes: { type: "boolean" },
      limit: { type: "string", default: "200" },
      reviewer: { type: "string" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
    },
  });

  const ids = values.ids
    ?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const decision = subcommand === "approve" ? "accepted" : "rejected";
  if (!ids?.length && !values.kind && !values.company && !values.all) {
    throw new Error(
      "review decision needs --ids, --kind, --company or --all (with --yes)",
    );
  }
  if (
    values.all &&
    !ids?.length &&
    !values.kind &&
    !values.company &&
    !values.yes
  ) {
    throw new Error("--all without --kind/--company requires explicit --yes");
  }

  if (values["dry-run"]) {
    if (ids?.length) {
      console.log(`would ${decision} ${ids.length} item(s)`);
      return;
    }
    const url = new URL("/v1/review/queue", config.apiUrl);
    url.searchParams.set("status", "pending");
    if (values.kind) url.searchParams.set("kind", values.kind);
    url.searchParams.set("limit", values.limit!);
    const body = (await api(`${url.pathname}${url.search}`)) as {
      data: { items: unknown[]; total: number };
    };
    const limit = Math.max(1, Number(values.limit) || 200);
    console.log(
      `would ${decision} up to ${Math.min(body.data.total, limit)} of ${body.data.total} pending item(s)` +
        (values.company
          ? ` · company filter ${values.company} is applied server-side`
          : ""),
    );
    return;
  }

  const response = (await request("/v1/review/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      decision,
      ...(ids?.length ? { ids } : {}),
      ...(values.kind ? { kind: values.kind } : {}),
      ...(values.company ? { company: values.company } : {}),
      limit: Math.max(1, Number(values.limit) || 200),
      ...(values.all ? { all: true } : {}),
      ...(values.reviewer ? { reviewer: values.reviewer } : {}),
    }),
  })) as {
    data: { updated: number; skipped: number; items: unknown[] };
    meta: { decision: string };
  };

  if (values.json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  console.log(
    `${response.meta.decision}: updated ${response.data.updated}, skipped ${response.data.skipped}`,
  );
}

async function proposeCommand(args: string[]): Promise<void> {
  const kind = args[0];
  if (kind !== "fact" && kind !== "relation") {
    throw new Error("usage: occ propose fact|relation ...");
  }
  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      company: { type: "string" },
      predicate: { type: "string" },
      value: { type: "string" },
      src: { type: "string" },
      dst: { type: "string" },
      type: { type: "string" },
      quote: { type: "string" },
      "source-url": { type: "string" },
      "idempotency-key": { type: "string" },
      json: { type: "boolean" },
    },
  });

  let payload: Record<string, unknown>;
  if (kind === "fact") {
    if (!values.company || !values.predicate || values.value === undefined) {
      throw new Error(
        "fact proposal requires --company, --predicate and --value",
      );
    }
    let value: unknown = values.value;
    try {
      value = JSON.parse(values.value);
    } catch {
      // keep the raw string
    }
    payload = {
      company: values.company,
      predicate: values.predicate,
      value,
    };
  } else {
    if (!values.src || !values.dst || !values.type) {
      throw new Error("relation proposal requires --src, --dst and --type");
    }
    payload = { src: values.src, dst: values.dst, type: values.type };
  }

  const evidence = {
    ...(values.quote ? { quote: values.quote } : {}),
    ...(values["source-url"] ? { sourceUrl: values["source-url"] } : {}),
  };
  const response = (await request("/v1/review/proposals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind,
      payload,
      ...(Object.keys(evidence).length > 0 ? { evidence } : {}),
      ...(values["idempotency-key"]
        ? { idempotency_key: values["idempotency-key"] }
        : {}),
    }),
  })) as {
    data: { id: string; status: string };
    meta: { created: boolean };
  };

  if (values.json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  console.log(
    `${response.meta.created ? "created" : "existing"} ${response.data.id} (${response.data.status})`,
  );
}

function printCompanyCard(body: unknown): void {
  const payload = body as {
    data: {
      company: {
        displayName: string;
        slug: string;
        legalName: string;
        coverageTier: string;
        aliases: string[];
        tickers: Array<{ exchange: string; ticker: string }>;
        indices: string[];
      };
      counts: {
        financials: number;
        facts: number;
        relationsOutgoing: number;
        relationsIncoming: number;
        events: number;
      };
      financials?: Array<{
        periodEnd: string;
        item: string;
        value: number;
        unit: string;
        currency?: string;
      }>;
      facts?: Array<{ predicate: string; value: unknown }>;
      relations?: {
        outgoing: Array<{
          label: string;
          status: string;
          dst: { displayName: string };
        }>;
        incoming: Array<{
          label: string;
          status: string;
          src: { displayName: string };
        }>;
      };
      events?: Array<{ date?: string; title: string; kind: string }>;
    };
  };
  const { company, counts } = payload.data;
  console.log(`${company.displayName} (${company.slug})  ${company.coverageTier}`);
  console.log(`  legal name : ${company.legalName}`);
  console.log(
    `  tickers    : ${company.tickers
      .map((ticker) => `${ticker.exchange}:${ticker.ticker}`)
      .join(", ")}`,
  );
  console.log(`  aliases    : ${company.aliases.join(", ")}`);
  console.log(`  indices    : ${company.indices.join(", ")}`);
  console.log(
    `  counts     : financials=${counts.financials} facts=${counts.facts} relations=${counts.relationsOutgoing}+${counts.relationsIncoming} events=${counts.events}`,
  );

  if (payload.data.financials?.length) {
    console.log("  financials :");
    for (const fact of payload.data.financials.slice(0, 8)) {
      console.log(
        `    ${fact.periodEnd}  ${fact.item.padEnd(24)} ${fact.value}${fact.unit === "percent" ? "%" : ` ${fact.currency ?? ""}`}`,
      );
    }
  }
  if (payload.data.relations) {
    for (const relation of payload.data.relations.outgoing.slice(0, 10)) {
      console.log(
        `    -> ${relation.label} ${relation.dst.displayName} [${relation.status}]`,
      );
    }
    for (const relation of payload.data.relations.incoming.slice(0, 10)) {
      console.log(
        `    <- ${relation.label} ${relation.src.displayName} [${relation.status}]`,
      );
    }
  }
  if (payload.data.facts?.length) {
    console.log("  facts      :");
    for (const fact of payload.data.facts.slice(0, 6)) {
      console.log(
        `    ${fact.predicate.padEnd(20)} ${JSON.stringify(fact.value).slice(0, 100)}`,
      );
    }
  }
  if (payload.data.events?.length) {
    console.log("  events     :");
    for (const event of payload.data.events.slice(0, 5)) {
      console.log(`    ${event.date ?? ""}  ${event.title}`);
    }
  }
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(
    `${config.apiUrl.replace(/\/+$/, "")}${path}`,
    init,
  );
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

async function api(path: string): Promise<unknown> {
  return request(path);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

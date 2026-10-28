import { randomUUID } from "node:crypto";

import {
  FinanceAnalystClient,
  type Market,
  type PagesResponse,
} from "@occ/sources-eastmoney-f10";
import type { PgBoss } from "pg-boss";

import { config } from "./config.js";
import { createRun, type JobSpec } from "./db.js";
import { QUEUES, sendJob } from "./queues.js";
import { resolveTargets } from "./universe.js";

const PAGE_PRIORITY: Record<string, number> = {
  cwfx: 5,
  NewFinancialAnalysis: 5,
  jyfx: 4,
  CoreReading: 4,
  gsgk: 3,
  CompanyProfile: 3,
  gsgd: 2,
  gbgd: 2,
  gsds: 2,
  hxbd: 2,
};

const PRIORITY_FALLBACK = 50;

export interface EnqueueResearchOptions {
  universe?: string;
  tickers?: string;
  limit?: number;
  shard?: { index: number; count: number };
  force?: boolean;
  mock?: boolean;
  includeF10?: boolean;
}

export interface EnqueueResult {
  runId: string;
  kind: "research" | "f10";
  targets: number;
  jobs: number;
}

export async function enqueueResearch(
  boss: PgBoss,
  options: EnqueueResearchOptions,
): Promise<EnqueueResult> {
  if (!options.mock && !process.env.DEEPSEEK_API_KEY) {
    throw new Error(
      "DEEPSEEK_API_KEY is required for live research; export it or pass --mock",
    );
  }
  const targets = await resolveTargets({
    universe: options.universe,
    tickers: options.tickers,
    limit: options.limit,
    shard: options.shard,
  });
  if (targets.length === 0) {
    throw new Error("no research targets matched --universe/--tickers");
  }

  const runId = randomUUID();
  const runOptions = {
    universe: options.universe ?? null,
    tickers: options.tickers ?? null,
    limit: options.limit ?? null,
    shard: options.shard ?? null,
    force: Boolean(options.force),
    mock: Boolean(options.mock),
    includeF10: Boolean(options.includeF10),
    model: config.model,
    concurrency: config.researchConcurrency,
  };

  const specs: JobSpec[] = targets.map((target) => ({
    queue: QUEUES.RESEARCH,
    jobKey: target.key,
    companyId: target.key,
    payload: {
      runId,
      key: target.key,
      ticker: target.ticker,
      name: target.name,
      ...(target.focus ? { focus: target.focus } : {}),
      force: Boolean(options.force),
      mock: Boolean(options.mock),
      includeF10: Boolean(options.includeF10),
    },
  }));

  await createRun("research", runOptions, specs, runId);
  const priorityByKey = new Map(targets.map((target) => [target.key, target.priority]));
  for (const spec of specs) {
    await sendJob(boss, spec.queue, spec.payload, {
      key: `${runId}:${spec.jobKey}`,
      priority: priorityByKey.get(spec.jobKey) ?? PRIORITY_FALLBACK,
    });
  }

  return {
    runId,
    kind: "research",
    targets: targets.length,
    jobs: specs.length,
  };
}

export interface EnqueueF10Options {
  universe?: string;
  tickers?: string;
  limit?: number;
  shard?: { index: number; count: number };
  preset?: string;
  pages?: string;
  force?: boolean;
}

export async function enqueueF10(
  boss: PgBoss,
  options: EnqueueF10Options,
): Promise<EnqueueResult> {
  const targets = await resolveTargets({
    universe: options.universe,
    tickers: options.tickers,
    limit: options.limit,
    shard: options.shard,
    requireF10: true,
  });
  if (targets.length === 0) {
    throw new Error(
      "no F10 targets matched; pass --tickers with an explicit market (e.g. 600519:A)",
    );
  }

  const client = new FinanceAnalystClient({ baseUrl: config.financeAnalystUrl });
  const catalogs = new Map<Market, PagesResponse>();
  const pagesByMarket = new Map<Market, string[]>();

  for (const target of targets) {
    const market = target.market!;
    if (pagesByMarket.has(market)) continue;
    const explicit = parsePages(options.pages);
    if (explicit) {
      pagesByMarket.set(market, explicit);
      continue;
    }
    let catalog = catalogs.get(market);
    if (!catalog) {
      catalog = await client.pages(market);
      catalogs.set(market, catalog);
    }
    const presetName = options.preset ?? "default";
    const preset = catalog.presets[presetName];
    if (!preset) {
      throw new Error(
        `unknown preset ${presetName} for ${market}; valid: ${Object.keys(catalog.presets).join(", ")}`,
      );
    }
    pagesByMarket.set(market, preset);
  }

  const runId = randomUUID();
  const runOptions = {
    universe: options.universe ?? null,
    tickers: options.tickers ?? null,
    limit: options.limit ?? null,
    shard: options.shard ?? null,
    preset: options.preset ?? "default",
    pages: options.pages ?? null,
    force: Boolean(options.force),
    concurrency: config.f10Concurrency,
    financeAnalystUrl: config.financeAnalystUrl,
  };

  const specs: JobSpec[] = [];
  for (const target of targets) {
    const market = target.market!;
    const code = target.code!;
    for (const page of pagesByMarket.get(market) ?? []) {
      specs.push({
        queue: QUEUES.F10,
        jobKey: `${market}:${code}:${page}`,
        companyId: `${market}:${code}`,
        page,
        payload: {
          runId,
          key: `${market}:${code}:${page}`,
          market,
          code,
          page,
          force: Boolean(options.force),
        },
      });
    }
  }

  await createRun("f10", runOptions, specs, runId);
  const priorityByKey = new Map(targets.map((target) => [target.key, target.priority]));
  for (const spec of specs) {
    const basePriority = priorityByKey.get(spec.companyId) ?? PRIORITY_FALLBACK;
    const page = spec.page ?? "";
    await sendJob(boss, spec.queue, spec.payload, {
      key: `${runId}:${spec.jobKey}`,
      priority: basePriority + (PAGE_PRIORITY[page] ?? 0),
    });
  }

  return {
    runId,
    kind: "f10",
    targets: targets.length,
    jobs: specs.length,
  };
}

function parsePages(value: string | undefined): string[] | null {
  if (!value) return null;
  const pages = value
    .split(",")
    .map((page) => page.trim())
    .filter(Boolean);
  if (pages.length === 0) throw new Error("--pages was empty");
  return pages;
}

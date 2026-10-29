import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { and, eq, ne } from "drizzle-orm";

import {
  DeepSeekClient,
  extractCompany,
  extractFinancials,
  extractSegmentFacts,
  extractSnapshotFacts,
  extractTimelineFacts,
  loadRelationUniverse,
  parseDataCutoff,
  parseFiscalYearEnd,
  type UniverseCompany,
} from "@occ/extract";
import {
  createDb,
  extractionCache,
  getCompanyBundle,
  migrate,
  resolveCompanyId,
} from "@occ/db";
import {
  parseSectionMarkdown,
  parseTicker,
  primaryConstituents,
  loadIndexSnapshot,
} from "@occ/ingest";
import type { Market } from "@occ/core";

import { config } from "./config.js";

export const USAGE_OPTIONS = `  occ extract [--sections DIR] [--all | --index ndx | --tickers ...]
              [--relations llm|none] [--concurrency N] [--limit N]
              [--force] [--retry-failed] [--dry-run] [--json]
      --all               every *.md in the sections directory (default)
      --index ndx         primary constituents from config/indices/ndx.yaml
      --relations llm     deepseek-flash relation extraction (default)
      --relations none    deterministic financials/facts only
      --dry-run           parse and count, do not write or call the LLM`;

interface Target {
  ticker: string;
  market: Market;
  sectionPath: string;
}

export async function extractCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      sections: { type: "string" },
      all: { type: "boolean" },
      index: { type: "string" },
      tickers: { type: "string" },
      relations: { type: "string", default: "llm" },
      concurrency: { type: "string", default: "2" },
      limit: { type: "string" },
      force: { type: "boolean" },
      "retry-failed": { type: "boolean" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
    },
  });

  const relations = values.relations === "none" ? "none" : "llm";
  if (values.relations !== "none" && values.relations !== "llm") {
    throw new Error("--relations must be llm or none");
  }
  const sectionsDir = values.sections ?? config.sectionsDir;
  const concurrency = Math.max(
    1,
    Number.parseInt(values.concurrency ?? "2", 10) || 2,
  );
  const limit = values.limit
    ? Number.parseInt(values.limit, 10)
    : undefined;

  let targets = resolveTargets(sectionsDir, values);
  if (limit !== undefined) targets = targets.slice(0, limit);
  if (targets.length === 0) {
    throw new Error(`no sections found in ${sectionsDir}`);
  }

  if (values["dry-run"]) {
    const summary = dryRun(targets);
    printSummary(summary, Boolean(values.json));
    return;
  }

  if (relations === "llm" && !config.deepseekApiKey) {
    throw new Error(
      "DEEPSEEK_API_KEY (or DEEPSEEK_API_KEY_FILE) is required for --relations llm",
    );
  }

  await migrate(config.databaseUrl);
  const { db, pool } = createDb(config.databaseUrl, 4);
  try {
    const universe: UniverseCompany[] | undefined =
      relations === "llm" ? await loadRelationUniverse(db) : undefined;
    const chat =
      relations === "llm"
        ? new DeepSeekClient({
            apiKey: config.deepseekApiKey!,
            baseUrl: config.deepseekBaseUrl,
            model: config.extractModel,
          })
        : undefined;

    const prepared = await Promise.all(
      targets.map(async (target) => {
        const companyId = await resolveCompanyId(db, target.ticker);
        if (!companyId) return { target, companyId: null };
        if (values["retry-failed"]) {
          const [row] = await db
            .select({ status: extractionCache.status })
            .from(extractionCache)
            .where(
              and(
                eq(extractionCache.companyId, companyId),
                eq(extractionCache.stage, "relations"),
                ne(extractionCache.status, "ok"),
              ),
            )
            .limit(1);
          if (!row) return { target, companyId: null };
        }
        return { target, companyId };
      }),
    );

    const runnable = prepared.filter(
      (entry): entry is { target: Target; companyId: string } =>
        Boolean(entry.companyId),
    );
    const missing = prepared
      .filter((entry) => !entry.companyId)
      .map((entry) => entry.target.ticker);

    const results = await mapLimit(runnable, concurrency, async (entry) => {
      try {
        const markdown = fs.readFileSync(entry.target.sectionPath, "utf8");
        const parsed = parseSectionMarkdown(markdown);
        const bundle = await getCompanyBundle(db, entry.companyId);
        const result = await extractCompany({
          db,
          companyId: entry.companyId,
          markdown,
          parsed,
          market: entry.target.market,
          companyTicker: entry.target.ticker,
          profileSourceId: bundle
            ? `src_research_${bundle.company.slug}`
            : undefined,
          relations,
          chat,
          model: config.extractModel,
          universe,
          force: Boolean(values.force),
        });
        return { ticker: entry.target.ticker, ...result };
      } catch (error) {
        // One bad section must not abort the whole batch.
        return {
          ticker: entry.target.ticker,
          companyId: entry.companyId,
          skipped: false,
          financialFacts: 0,
          facts: 0,
          relations: 0,
          relationsSkipped: false,
          errors: [
            {
              stage: "extract",
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    });

    const summary = {
      companies: results,
      missing,
      totals: {
        companies: results.length,
        financialFacts: results.reduce(
          (sum, result) => sum + result.financialFacts,
          0,
        ),
        facts: results.reduce((sum, result) => sum + result.facts, 0),
        relations: results.reduce((sum, result) => sum + result.relations, 0),
        skipped: results.filter((result) => result.skipped).length,
        errors: results.reduce(
          (sum, result) => sum + result.errors.length,
          0,
        ),
      },
    };
    printSummary(summary, Boolean(values.json));
  } finally {
    await pool.end();
  }
}

function resolveTargets(
  sectionsDir: string,
  values: {
    index?: string;
    tickers?: string;
  },
): Target[] {
  if (values.tickers) {
    return values.tickers
      .split(",")
      .map((raw) => raw.trim())
      .filter(Boolean)
      .flatMap((raw) => {
        const parsed = parseTicker(raw);
        if (!parsed) return [];
        return [
          {
            ticker: parsed.ticker,
            market: parsed.market,
            sectionPath: path.join(sectionsDir, `${parsed.ticker}.md`),
          },
        ];
      })
      .filter((target) => fs.existsSync(target.sectionPath));
  }

  if (values.index) {
    if (values.index.toLowerCase() !== "ndx" && values.index.toLowerCase() !== "nasdaq100") {
      throw new Error("only --index ndx is supported");
    }
    const snapshot = loadIndexSnapshot(config.ndxFile);
    return primaryConstituents(snapshot)
      .map((constituent) => ({
        ticker: constituent.ticker,
        market: snapshot.index.market,
        sectionPath: path.join(sectionsDir, `${constituent.ticker}.md`),
      }))
      .filter((target) => fs.existsSync(target.sectionPath));
  }

  return fs
    .readdirSync(sectionsDir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.slice(0, -3))
    .flatMap((ticker) => {
      const parsed = parseTicker(ticker);
      if (!parsed) return [];
      return [
        {
          ticker: parsed.ticker,
          market: parsed.market,
          sectionPath: path.join(sectionsDir, `${ticker}.md`),
        },
      ];
    });
}

interface DryRunRow {
  ticker: string;
  market: Market;
  financialFacts: number;
  facts: number;
  hasRelationsChapter: boolean;
}

function dryRun(targets: Target[]): {
  companies: DryRunRow[];
  totals: { companies: number; financialFacts: number; facts: number };
} {
  const companies = targets.map((target) => {
    const markdown = fs.readFileSync(target.sectionPath, "utf8");
    const parsed = parseSectionMarkdown(markdown);
    const snapshot = parsed.chapters.find((entry) => entry.section === "公司快照");
    const finance = parsed.chapters.find((entry) =>
      entry.section.startsWith("财务表现"),
    );
    const segments = parsed.chapters.find((entry) =>
      entry.section.startsWith("业务与收入结构"),
    );
    const timeline = parsed.chapters.find(
      (entry) => entry.section.replace(/\s+/g, "") === "近12个月大事",
    );
    const fye = parseFiscalYearEnd(snapshot?.text ?? "");
    const dataCutoff = parseDataCutoff(markdown);
    const financialFacts = finance
      ? extractFinancials({
          companyId: target.ticker,
          chapter: finance,
          market: target.market,
          fye,
          dataCutoff,
        }).length
      : 0;
    const facts =
      (snapshot
        ? extractSnapshotFacts({
            companyId: target.ticker,
            chapter: snapshot,
            dataCutoff,
          }).length
        : 0) +
      (segments
        ? extractSegmentFacts({
            companyId: target.ticker,
            chapter: segments,
            market: target.market,
            dataCutoff,
          }).length
        : 0) +
      (timeline
        ? extractTimelineFacts({
            companyId: target.ticker,
            chapter: timeline,
            dataCutoff,
          }).length
        : 0);
    return {
      ticker: target.ticker,
      market: target.market,
      financialFacts,
      facts,
      hasRelationsChapter: parsed.chapters.some(
        (entry) => entry.section === "关键关系",
      ),
    };
  });
  return {
    companies,
    totals: {
      companies: companies.length,
      financialFacts: companies.reduce((sum, row) => sum + row.financialFacts, 0),
      facts: companies.reduce((sum, row) => sum + row.facts, 0),
    },
  };
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await fn(items[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function printSummary(summary: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const value = summary as {
    companies: Array<{
      ticker: string;
      financialFacts: number;
      facts: number;
      relations?: number;
      skipped: boolean;
      relationsError?: string;
      errors: Array<{ stage: string; message: string }>;
    }>;
    missing?: string[];
    totals: { companies: number; financialFacts: number; facts: number; relations?: number };
  };
  for (const row of value.companies) {
    const bits = [
      row.ticker.padEnd(8),
      `fin=${row.financialFacts}`,
      `facts=${row.facts}`,
      `rel=${row.relations ?? 0}`,
      row.skipped ? "cache=hit" : "cache=miss",
    ];
    if (row.relationsError) bits.push(`relError=${row.relationsError}`);
    if (row.errors.length > 0) {
      bits.push(`errors=${row.errors.map((entry) => entry.stage).join(",")}`);
    }
    console.log(bits.join("  "));
  }
  if (value.missing && value.missing.length > 0) {
    console.log(`missing in DB (ingest first): ${value.missing.join(", ")}`);
  }
  console.log(
    `\ntotal: ${value.totals.companies} companies, ${value.totals.financialFacts} financial facts, ${value.totals.facts} facts` +
      (value.totals.relations !== undefined
        ? `, ${value.totals.relations} relations`
        : ""),
  );
}

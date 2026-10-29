import { parseArgs } from "node:util";

import { aliases, companies, createDb, securities } from "@occ/db";
import {
  createIngestContext,
  defaultCuratedAliasPath,
  pinyinAliasForms,
  pinyinVariants,
  readCuratedAliasFile,
  reindexCompanyPoint,
} from "@occ/ingest";
import { eq, inArray } from "drizzle-orm";

import { config } from "./config.js";

const USAGE_OPTIONS = `
Aliases options:
  --file <path>          Curated alias YAML (default config/aliases/zh.yaml)
  --skip-index           Write Postgres aliases only; do not re-index companies
  --dry-run              Show what would change without writing
  --json                 Machine-readable summary
`;

interface AliasRow {
  companyId: string;
  alias: string;
  lang: "zh";
  kind: "brand" | "pinyin";
  pinyin: string | null;
  initials: string | null;
}

export interface SyncAliasesResult {
  file: string;
  asOf?: string;
  tickers: number;
  companiesMatched: number;
  aliasesInserted: number;
  aliasesExisting: number;
  companiesReindexed: number;
  reindexFailures: Array<{ ticker: string; companyId: string; error: string }>;
  missingTickers: string[];
  dryRun: boolean;
  skipIndex: boolean;
}

/**
 * Insert hand-curated Chinese aliases (config/aliases/zh.yaml) for existing
 * companies and re-index their company points.
 *
 * Idempotent: existing `(company_id, alias, lang)` rows are left untouched, so
 * rerunning only counts new rows. Companies are matched by `securities.ticker`;
 * curated tickers with no security are reported, not invented.
 */
export async function syncCuratedAliases(
  options: {
    file?: string;
    skipIndex?: boolean;
    dryRun?: boolean;
  } = {},
): Promise<SyncAliasesResult> {
  const file = options.file ?? defaultCuratedAliasPath();
  const parsed = readCuratedAliasFile(file);
  const configured = new Map(
    Object.entries(parsed.aliases).map(([ticker, values]) => [
      ticker.toUpperCase(),
      values,
    ]),
  );
  const dryRun = Boolean(options.dryRun);
  const skipIndex = Boolean(options.skipIndex);
  const tickers = [...configured.keys()];

  const { db, pool } = createDb(config.databaseUrl);
  let reindexCtx: Awaited<ReturnType<typeof createIngestContext>> | null = null;

  try {
    const securityRows =
      tickers.length === 0
        ? []
        : await db
            .select({
              ticker: securities.ticker,
              companyId: securities.companyId,
            })
            .from(securities)
            .innerJoin(companies, eq(securities.companyId, companies.id))
            .where(inArray(securities.ticker, tickers));

    const companyByTicker = new Map<string, string>();
    for (const row of securityRows) {
      if (!companyByTicker.has(row.ticker)) {
        companyByTicker.set(row.ticker, row.companyId);
      }
    }

    const aliasesByCompany = new Map<string, Set<string>>();
    for (const ticker of tickers) {
      const companyId = companyByTicker.get(ticker);
      if (!companyId) continue;
      const companyAliases = aliasesByCompany.get(companyId) ?? new Set<string>();
      for (const alias of configured.get(ticker) ?? []) {
        companyAliases.add(alias);
      }
      aliasesByCompany.set(companyId, companyAliases);
    }

    const rows: AliasRow[] = [];
    for (const [companyId, companyAliases] of aliasesByCompany) {
      for (const alias of companyAliases) {
        const variants = pinyinVariants(alias);
        rows.push({
          companyId,
          alias,
          lang: "zh",
          kind: "brand",
          pinyin: variants?.full ?? null,
          initials: variants?.initials ?? null,
        });
        for (const form of pinyinAliasForms(alias)) {
          rows.push({
            companyId,
            alias: form,
            lang: "zh",
            kind: "pinyin",
            pinyin: null,
            initials: null,
          });
        }
      }
    }

    let aliasesInserted = 0;
    const companiesWithNewAliases = new Set<string>();
    if (!dryRun && rows.length > 0) {
      const inserted = await db
        .insert(aliases)
        .values(rows)
        .onConflictDoNothing()
        .returning({ id: aliases.id, companyId: aliases.companyId });
      aliasesInserted = inserted.length;
      for (const row of inserted) companiesWithNewAliases.add(row.companyId);
    } else if (dryRun) {
      aliasesInserted = await countNewAliases(db, rows);
    }

    const reindexFailures: SyncAliasesResult["reindexFailures"] = [];
    let companiesReindexed = 0;
    if (!dryRun && !skipIndex && aliasesInserted > 0) {
      reindexCtx = await createIngestContext({
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
      for (const companyId of companiesWithNewAliases) {
        try {
          if (await reindexCompanyPoint(reindexCtx.ctx, companyId)) {
            companiesReindexed += 1;
          }
        } catch (error) {
          reindexFailures.push({
            ticker: tickerForCompany(companyByTicker, companyId),
            companyId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const matchedTickers = new Set(
      tickers.filter((ticker) => companyByTicker.has(ticker)),
    );
    return {
      file,
      asOf: parsed.as_of,
      tickers: tickers.length,
      companiesMatched: new Set(companyByTicker.values()).size,
      aliasesInserted,
      aliasesExisting: rows.length - aliasesInserted,
      companiesReindexed,
      reindexFailures,
      missingTickers: tickers.filter((ticker) => !matchedTickers.has(ticker)),
      dryRun,
      skipIndex,
    };
  } finally {
    if (reindexCtx) await reindexCtx.close();
    await pool.end();
  }
}

export async function aliasesCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "sync") {
    throw new Error("usage: occ aliases sync [--file path] [--skip-index] [--dry-run]");
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      file: { type: "string" },
      "skip-index": { type: "boolean" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  const result = await syncCuratedAliases({
    file: values.file,
    skipIndex: Boolean(values["skip-index"]),
    dryRun: Boolean(values["dry-run"]),
  });
  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    `aliases ${result.dryRun ? "dry-run" : "synced"} · ${result.companiesMatched}/${result.tickers} tickers matched · ` +
      `inserted=${result.aliasesInserted} reindexed=${result.companiesReindexed}` +
      (result.missingTickers.length
        ? ` · missing=${result.missingTickers.join(",")}`
        : ""),
  );
  for (const failure of result.reindexFailures) {
    console.error(`  REINDEX FAIL ${failure.ticker}: ${failure.error}`);
  }
}

async function countNewAliases(
  db: ReturnType<typeof createDb>["db"],
  rows: AliasRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const existing = await db
    .select({
      companyId: aliases.companyId,
      alias: aliases.alias,
      lang: aliases.lang,
    })
    .from(aliases)
    .where(
      inArray(
        aliases.companyId,
        [...new Set(rows.map((row) => row.companyId))],
      ),
    );
  const seen = new Set(
    existing.map((row) => `${row.companyId}\0${row.alias}\0${row.lang}`),
  );
  let count = 0;
  for (const row of rows) {
    const key = `${row.companyId}\0${row.alias}\0${row.lang}`;
    if (seen.has(key)) continue;
    seen.add(key);
    count += 1;
  }
  return count;
}

function tickerForCompany(
  companyByTicker: Map<string, string>,
  companyId: string,
): string {
  for (const [ticker, value] of companyByTicker) {
    if (value === companyId) return ticker;
  }
  return companyId;
}

export { USAGE_OPTIONS };

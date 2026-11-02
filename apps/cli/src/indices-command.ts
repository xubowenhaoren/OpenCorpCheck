import { parseArgs } from "node:util";

import { newId, slugify } from "@occ/core";
import {
  aliases,
  companies,
  companyIds,
  createDb,
  indexMemberships,
  migrate,
  securities,
  type Db,
} from "@occ/db";
import {
  companySlug,
  countryForMarket,
  currencyForMarket,
  loadIndexSnapshot,
  pinyinAliasForms,
  pinyinVariants,
  tickerIdValue,
  type IndexConstituent,
  type IndexSnapshot,
} from "@occ/ingest";
import { and, eq } from "drizzle-orm";

import { config } from "./config.js";

const USAGE_OPTIONS = `
Indices options:
  --index A500|SPX|all   Snapshot(s) to sync (default: all)
  --file <path>          Explicit snapshot file (infers the index code)
  --dry-run              Report what would change without writing
  --json                 Machine-readable summary
`;

export interface SyncIndexResult {
  index: string;
  file: string;
  asOf: string;
  constituents: number;
  matched: number;
  created: number;
  membershipInserted: number;
  membershipUpdated: number;
  securitiesInserted: number;
  identifiersInserted: number;
  aliasesInserted: number;
  skippedSecondary: number;
  ambiguous: string[];
  conflicts: string[];
  dryRun: boolean;
}

interface SyncContext {
  db: Db;
  dryRun: boolean;
}

interface Lookup {
  companyId?: string;
  via?: "security" | "cik" | "identifier" | "name";
}

const CJK_RE = /[㐀-鿿]/;

/**
 * Create searchable `coverage_tier='stub'` companies from an index snapshot.
 *
 * Real profiles are never modified: a constituent that already resolves to a
 * company only gets a missing security and its index membership. A missing
 * primary constituent becomes a names/ticker/market-only stub; secondary share
 * classes are attached by CIK to the primary stub instead of creating a second
 * company. Idempotent by ticker+exchange and by the membership key.
 */
export async function syncIndices(
  options: {
    index?: string;
    file?: string;
    dryRun?: boolean;
  } = {},
): Promise<SyncIndexResult[]> {
  const applied = await migrate(config.databaseUrl);
  if (applied.length > 0) {
    console.log(JSON.stringify({ level: "info", msg: "migrations applied", applied }));
  }

  const files = resolveFiles(options);
  const { db, pool } = createDb(config.databaseUrl);
  try {
    const results: SyncIndexResult[] = [];
    for (const file of files) {
      const snapshot = loadIndexSnapshot(file);
      results.push(await syncSnapshot({ db, dryRun: Boolean(options.dryRun) }, snapshot, file));
    }
    return results;
  } finally {
    await pool.end();
  }
}

function resolveFiles(options: { index?: string; file?: string }): string[] {
  if (options.file) return [options.file];
  const requested = (options.index ?? "all").trim().toUpperCase();
  if (requested === "ALL") return [config.a500File, config.sp500File];
  if (requested === "A500") return [config.a500File];
  if (requested === "SPX") return [config.sp500File];
  throw new Error(`unknown index ${options.index}; use A500, SPX or all`);
}

async function syncSnapshot(
  ctx: SyncContext,
  snapshot: IndexSnapshot,
  file: string,
): Promise<SyncIndexResult> {
  const { db, dryRun } = ctx;
  const indexCode = snapshot.index.code.toUpperCase();
  const asOf = snapshot.index.as_of;
  const market = snapshot.index.market;

  const companyRows = await db
    .select({
      id: companies.id,
      slug: companies.slug,
      displayName: companies.displayName,
      legalName: companies.legalName,
    })
    .from(companies);
  const securityRows = await db
    .select({
      companyId: securities.companyId,
      ticker: securities.ticker,
      exchange: securities.exchange,
    })
    .from(securities);
  const idRows = await db
    .select({
      companyId: companyIds.companyId,
      idType: companyIds.idType,
      idValue: companyIds.idValue,
    })
    .from(companyIds);
  const aliasRows = await db
    .select({ companyId: aliases.companyId, alias: aliases.alias })
    .from(aliases);
  const membershipRows = await db
    .select({
      companyId: indexMemberships.companyId,
      asOf: indexMemberships.asOf,
      weight: indexMemberships.weight,
    })
    .from(indexMemberships)
    .where(eq(indexMemberships.indexCode, indexCode));

  const byTickerExchange = new Map<string, string>();
  const tickersByCompany = new Map<string, Set<string>>();
  for (const row of securityRows) {
    byTickerExchange.set(tickerKey(row.ticker, row.exchange), row.companyId);
    addToSet(tickersByCompany, row.companyId, row.ticker.toUpperCase());
  }

  const byIdentifier = new Map<string, string>();
  for (const row of idRows) {
    byIdentifier.set(identifierKey(row.idType, row.idValue), row.companyId);
  }

  const ownersByName = new Map<string, Set<string>>();
  const slugs = new Set<string>();
  for (const row of companyRows) {
    slugs.add(row.slug);
    addToSet(ownersByName, row.displayName.trim().toLowerCase(), row.id);
    addToSet(ownersByName, row.legalName.trim().toLowerCase(), row.id);
  }
  for (const row of aliasRows) {
    addToSet(ownersByName, row.alias.trim().toLowerCase(), row.companyId);
  }

  const membershipWeight = new Map<string, number | null>();
  for (const row of membershipRows) {
    membershipWeight.set(membershipKey(row.companyId, String(row.asOf).slice(0, 10)), row.weight);
  }

  const result: SyncIndexResult = {
    index: indexCode,
    file,
    asOf,
    constituents: snapshot.constituents.length,
    matched: 0,
    created: 0,
    membershipInserted: 0,
    membershipUpdated: 0,
    securitiesInserted: 0,
    identifiersInserted: 0,
    aliasesInserted: 0,
    skippedSecondary: 0,
    ambiguous: [],
    conflicts: [],
    dryRun,
  };

  // Primary rows first so a secondary share class can attach by CIK.
  const ordered = [...snapshot.constituents].sort(
    (left, right) =>
      Number(right.primary) - Number(left.primary) ||
      left.ticker.localeCompare(right.ticker),
  );

  for (const entry of ordered) {
    const lookup = resolveCompany(entry, {
      market,
      byTickerExchange,
      byIdentifier,
      ownersByName,
    });

    if (lookup.companyId) {
      result.matched += 1;
      await ensureSecurity(ctx, lookup.companyId, entry, market, result, byTickerExchange, tickersByCompany);
      await upsertMembership(ctx, lookup.companyId, entry, indexCode, asOf, result, membershipWeight);
      continue;
    }

    if (!entry.primary) {
      result.skippedSecondary += 1;
      continue;
    }

    if (lookup.via === "name") {
      result.ambiguous.push(`${entry.ticker}: exact name matches more than one company`);
      continue;
    }

    const companyId = newId();
    const slug = uniqueSlug(
      [companySlug(entry.name_en ?? entry.name), slugify(entry.ticker)],
      slugs,
    );
    const displayName = entry.name.trim();
    const legalName = (entry.name_en ?? entry.name).trim();

    if (!dryRun) {
      await db.insert(companies).values({
        id: companyId,
        slug,
        legalName,
        displayName,
        country: countryForMarket(market),
        coverageTier: "stub",
        isFixture: false,
        profile: {},
      });
    }
    slugs.add(slug);
    addToSet(ownersByName, displayName.toLowerCase(), companyId);
    addToSet(ownersByName, legalName.toLowerCase(), companyId);

    await ensureSecurity(
      ctx,
      companyId,
      entry,
      market,
      result,
      byTickerExchange,
      tickersByCompany,
    );

    result.identifiersInserted += await insertIdentifiers(
      ctx,
      companyId,
      entry,
      market,
      byIdentifier,
    );
    result.aliasesInserted += await insertStubAliases(ctx, companyId, entry);
    await upsertMembership(ctx, companyId, entry, indexCode, asOf, result, membershipWeight);
    result.created += 1;
  }

  return result;
}

function resolveCompany(
  entry: IndexConstituent,
  context: {
    market: IndexSnapshot["index"]["market"];
    byTickerExchange: Map<string, string>;
    byIdentifier: Map<string, string>;
    ownersByName: Map<string, Set<string>>;
  },
): Lookup {
  const direct = context.byTickerExchange.get(tickerKey(entry.ticker, entry.exchange));
  if (direct) return { companyId: direct, via: "security" };

  if (entry.cik) {
    const byCik = context.byIdentifier.get(identifierKey("cik", entry.cik));
    if (byCik) return { companyId: byCik, via: "cik" };
  }

  const qualified = tickerIdValue({
    market: context.market,
    ticker: entry.ticker,
    code: entry.ticker,
    exchange: entry.exchange,
  });
  for (const value of [qualified, entry.ticker]) {
    const byTicker = context.byIdentifier.get(identifierKey("ticker", value));
    if (byTicker) return { companyId: byTicker, via: "identifier" };
  }

  for (const name of [entry.name, entry.name_en, entry.name_zh]) {
    if (!name) continue;
    const owners = context.ownersByName.get(name.trim().toLowerCase());
    if (owners?.size === 1) return { companyId: [...owners][0], via: "name" };
    if (owners && owners.size > 1) return { via: "name" };
  }

  return {};
}

async function ensureSecurity(
  ctx: SyncContext,
  companyId: string,
  entry: IndexConstituent,
  market: IndexSnapshot["index"]["market"],
  result: SyncIndexResult,
  byTickerExchange: Map<string, string>,
  tickersByCompany: Map<string, Set<string>>,
): Promise<void> {
  const key = tickerKey(entry.ticker, entry.exchange);
  const owner = byTickerExchange.get(key);
  if (owner) {
    if (owner !== companyId) {
      result.conflicts.push(
        `${entry.ticker}/${entry.exchange}: already belongs to ${owner}, snapshot wants ${companyId}`,
      );
    }
    return;
  }
  if (tickersByCompany.get(companyId)?.has(entry.ticker.toUpperCase())) return;
  if (!ctx.dryRun) {
    const inserted = await ctx.db
      .insert(securities)
      .values({
        companyId,
        ticker: entry.ticker,
        exchange: entry.exchange,
        currency: currencyForMarket(market),
        status: "listed",
      })
      .onConflictDoNothing()
      .returning({ id: securities.id });
    result.securitiesInserted += inserted.length;
  } else {
    result.securitiesInserted += 1;
  }
  byTickerExchange.set(key, companyId);
  addToSet(tickersByCompany, companyId, entry.ticker.toUpperCase());
}

async function insertIdentifiers(
  ctx: SyncContext,
  companyId: string,
  entry: IndexConstituent,
  market: IndexSnapshot["index"]["market"],
  byIdentifier: Map<string, string>,
): Promise<number> {
  const rows = [
    {
      companyId,
      idType: "ticker",
      idValue: tickerIdValue({
        market,
        ticker: entry.ticker,
        code: entry.ticker,
        exchange: entry.exchange,
      }),
    },
    ...(entry.cik
      ? [{ companyId, idType: "cik", idValue: entry.cik }]
      : []),
  ];
  // Keep the in-memory index in sync so a secondary share class later in the
  // same snapshot can resolve by the primary's CIK/ticker id.
  for (const row of rows) {
    byIdentifier.set(identifierKey(row.idType, row.idValue), companyId);
  }
  if (ctx.dryRun) return rows.length;
  const inserted = await ctx.db
    .insert(companyIds)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: companyIds.id });
  return inserted.length;
}

async function insertStubAliases(
  ctx: SyncContext,
  companyId: string,
  entry: IndexConstituent,
): Promise<number> {
  const rows = new Map<
    string,
    {
      companyId: string;
      alias: string;
      lang: string;
      kind: string;
      pinyin: string | null;
      initials: string | null;
    }
  >();
  const add = (value: string | undefined, kind: string): void => {
    const alias = value?.trim();
    if (!alias) return;
    const lang = CJK_RE.test(alias) ? "zh" : "en";
    const variants = pinyinVariants(alias);
    rows.set(`${alias}\0${lang}`, {
      companyId,
      alias,
      lang,
      kind,
      pinyin: variants?.full ?? null,
      initials: variants?.initials ?? null,
    });
    for (const form of pinyinAliasForms(alias)) {
      rows.set(`${form}\0zh`, {
        companyId,
        alias: form,
        lang: "zh",
        kind: "pinyin",
        pinyin: null,
        initials: null,
      });
    }
  };
  add(entry.name, "brand");
  add(entry.name_zh, "brand");
  add(entry.name_en, "legal");
  add(entry.ticker, "ticker");

  if (ctx.dryRun) return rows.size;
  const inserted = await ctx.db
    .insert(aliases)
    .values([...rows.values()])
    .onConflictDoNothing()
    .returning({ id: aliases.id });
  return inserted.length;
}

async function upsertMembership(
  ctx: SyncContext,
  companyId: string,
  entry: IndexConstituent,
  indexCode: string,
  asOf: string,
  result: SyncIndexResult,
  membershipWeight: Map<string, number | null>,
): Promise<void> {
  const key = membershipKey(companyId, asOf);
  const weight = entry.weight ?? null;
  const previous = membershipWeight.get(key);
  if (previous === undefined) {
    result.membershipInserted += 1;
    if (!ctx.dryRun) {
      await ctx.db
        .insert(indexMemberships)
        .values({ indexCode, companyId, weight, asOf })
        .onConflictDoNothing();
    }
    membershipWeight.set(key, weight);
    return;
  }

  if (previous === weight) return;
  result.membershipUpdated += 1;
  if (!ctx.dryRun) {
    await ctx.db
      .update(indexMemberships)
      .set({ weight })
      .where(
        and(
          eq(indexMemberships.indexCode, indexCode),
          eq(indexMemberships.companyId, companyId),
          eq(indexMemberships.asOf, asOf),
        ),
      );
  }
  membershipWeight.set(key, weight);
}

function tickerKey(ticker: string, exchange: string): string {
  return `${ticker.trim().toUpperCase()}\0${exchange.trim().toUpperCase()}`;
}

function identifierKey(idType: string, idValue: string): string {
  return `${idType.trim().toLowerCase()}\0${idValue.trim().toUpperCase()}`;
}

function membershipKey(companyId: string, asOf: string): string {
  return `${companyId}\0${asOf}`;
}

function addToSet<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key) ?? new Set<V>();
  set.add(value);
  map.set(key, set);
}

function uniqueSlug(candidates: string[], used: Set<string>): string {
  const base = candidates.find((candidate) => candidate.length > 0) ?? "company";
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

export async function indicesCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand !== "sync") {
    throw new Error("usage: occ indices sync [--index A500|SPX|all] [--file path] [--dry-run] [--json]");
  }

  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      index: { type: "string" },
      file: { type: "string" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
    },
  });

  const results = await syncIndices({
    index: values.index,
    file: values.file,
    dryRun: Boolean(values["dry-run"]),
  });

  if (values.json) {
    console.log(JSON.stringify({ results }, null, 2));
    return;
  }
  for (const result of results) {
    console.log(
      `${result.index} · as_of ${result.asOf} · ${result.constituents} constituents` +
        (result.dryRun ? " (dry run)" : ""),
    );
    console.log(
      `  matched ${result.matched} · created ${result.created} · memberships +${result.membershipInserted} ~${result.membershipUpdated}`,
    );
    console.log(
      `  securities +${result.securitiesInserted} · identifiers +${result.identifiersInserted} · aliases +${result.aliasesInserted}`,
    );
    if (result.skippedSecondary > 0) {
      console.log(`  skipped secondary rows ${result.skippedSecondary}`);
    }
    for (const item of result.ambiguous) console.log(`  ambiguous: ${item}`);
    for (const item of result.conflicts) console.log(`  conflict: ${item}`);
  }
}

export { USAGE_OPTIONS };

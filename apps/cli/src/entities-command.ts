import fs from "node:fs";
import path from "node:path";

import { parseArgs } from "node:util";

import {
  createDb,
  insertCompanyIdentifiers,
  listEntityCompanies,
  mergeEntityCompanies,
  migrate,
  relationId,
  updateEntityProfile,
  upsertGleifRelations,
  type Db,
  type EntityCompany,
} from "@occ/db";
import { createIngestContext, reindexCompanyPoint, tickerIdValue } from "@occ/ingest";
import { FinanceAnalystClient } from "@occ/sources-eastmoney-f10";
import {
  CANONICAL_SECTORS,
  GleifClient,
  SECTOR_TAXONOMY_VERSION,
  WikidataClient,
  isGleifResolution,
  isWikidataResolution,
  matchGleifLei,
  matchWikidataQid,
  normalizeFullName,
  normalizeName,
  parseEdgarProfile,
  parseF10CompanyProfile,
  sectorFromEastmoneyIndustry,
  sectorFromLegacyLabel,
  sectorFromSic,
  type CanonicalSector,
  type F10CompanyProfile,
  type GleifRecord,
  type Market,
} from "@occ/sources-entity";
import { config } from "./config.js";

const USAGE_OPTIONS = `
Entities options:
  --json                 Machine-readable report
  --dry-run              Plan only, write nothing (enrich/wikidata)
  --apply                Write changes (resolve/gleif); default is dry-run
  --force                Ignore cached F10/EDGAR pages and refetch
  --skip-index           Do not re-index changed companies in Qdrant
  --limit <n>            Cap the number of companies processed
  --markets A,HK,US      Restrict enrichment to those markets
`;

interface ProfileSnapshot {
  meta?: { fetched_at?: string };
  page: {
    page?: string;
    label?: string;
    url: string;
    text?: string;
    tables?: Array<{ caption?: string; headers: string[]; rows: string[][] }>;
    error?: string | null;
    http_status?: number | null;
  };
}

interface ProfileTarget {
  market: Market;
  code: string;
  page: string;
  ticker: string;
  exchange: string;
}

interface PlannedIdentifier {
  companyId: string;
  idType: string;
  idValue: string;
  source: string;
}

interface CompanyEnrichment {
  company: EntityCompany;
  market?: Market;
  sector?: CanonicalSector;
  sectorRule?: string;
  sectorLabel?: string;
  sectorMarket?: Market;
  sectorUrl?: string;
  industry?: string;
  industryCsrc?: string;
  sic?: string;
  sicDescription?: string;
  profilePatch: Record<string, unknown>;
  identifiers: PlannedIdentifier[];
  errors: string[];
  fetched: number;
  cached: number;
  changed: boolean;
}

export interface EnrichReport {
  researched: number;
  processed: number;
  dryRun: boolean;
  sectors: {
    covered: number;
    missing: string[];
    bySector: Record<string, number>;
  };
  identifiers: Record<string, { covered: number; missing: string[] }>;
  changed: number;
  /** Fixture rows whose legacy thematic sector was normalized. */
  fixturesNormalized: number;
  fixtureSectorUnmatched: string[];
  sectorReindexed: number;
  reindexFailures: Array<{ companyId: string; error: string }>;
  identifierInserted: number;
  identifierExisting: number;
  identifierConflicts: Array<{
    companyId: string;
    idType: string;
    idValue: string;
    ownerCompanyId: string;
  }>;
  fetchedProfiles: number;
  cachedProfiles: number;
  failures: Array<{ companyId: string; slug: string; error: string }>;
}

// ---------------------------------------------------------------------------
// enrich: sector + local identifiers (F10 profile + SEC EDGAR)
// ---------------------------------------------------------------------------

export async function enrichEntities(
  options: {
    force?: boolean;
    dryRun?: boolean;
    skipIndex?: boolean;
    markets?: Market[];
    limit?: number;
  } = {},
): Promise<EnrichReport> {
  const dryRun = Boolean(options.dryRun);
  if (!dryRun) await migrate(config.databaseUrl);
  const { db, pool } = createDb(config.databaseUrl);
  try {
    const companies = (await listEntityCompanies(db)).filter(
      (company) => company.coverageTier !== "stub",
    );
    const selected = options.markets?.length
      ? companies.filter((company) =>
          securityTargets(company).some((target) =>
            options.markets!.includes(target.market),
          ),
        )
      : companies;
    const targets = options.limit ? selected.slice(0, options.limit) : selected;
    const tickerMap = loadEdgarTickerMap();
    const results: CompanyEnrichment[] = [];
    const plannedIdentifiers: PlannedIdentifier[] = [];
    const failures: EnrichReport["failures"] = [];
    const sectorChangedIds = new Set<string>();
    let fetchedProfiles = 0;
    let cachedProfiles = 0;

    for (const company of targets) {
      const enrichment = await enrichCompany(company, {
        db,
        tickerMap,
        force: Boolean(options.force),
        dryRun,
      });
      results.push(enrichment);
      for (const error of enrichment.errors) {
        failures.push({
          companyId: company.id,
          slug: company.slug,
          error,
        });
      }
      fetchedProfiles += enrichment.fetched;
      cachedProfiles += enrichment.cached;
      plannedIdentifiers.push(...enrichment.identifiers);
      if (enrichment.market && enrichment.sector !== undefined) {
        if (enrichment.sector !== company.sector) sectorChangedIds.add(company.id);
      }
    }

    let identifierInserted = 0;
    let identifierExisting = 0;
    let identifierConflicts: EnrichReport["identifierConflicts"] = [];
    if (!dryRun) {
      const inserted = await insertCompanyIdentifiers(db, plannedIdentifiers);
      identifierInserted = inserted.inserted;
      identifierExisting = inserted.existing;
      identifierConflicts = inserted.conflicts;
    }

    const reindex = dryRun
      ? { reindexed: 0, failures: [] as EnrichReport["reindexFailures"] }
      : await reindexCompanies([...sectorChangedIds], {
          skip: Boolean(options.skipIndex),
        });

    // Fixtures keep their legacy thematic labels until now; the A500 index
    // page builds its sector filter from membership rows, so normalize them
    // too (no vendor fetch, no research, no stub fill).
    const fixtureNormalization = await normalizeFixtureSectors(db, dryRun);

    const sectorCoverage = summarizeSectors(
      results.map((result) => ({
        slug: result.company.slug,
        sector: result.sector ?? (result.company.sector as CanonicalSector | null),
      })),
    );

    const coverage = dryRun ? null : await collectCoverage(db);

    return {
      researched: companies.length,
      processed: results.length,
      dryRun,
      sectors: coverage
        ? {
            covered: coverage.sectors.covered,
            missing: coverage.sectors.missing,
            bySector: coverage.sectors.bySector,
          }
        : {
            covered: sectorCoverage.covered,
            missing: sectorCoverage.missing,
            bySector: sectorCoverage.bySector,
          },
      identifiers: coverage ? coverage.identifiers : {},
      changed: results.filter((result) => result.changed).length,
      fixturesNormalized: fixtureNormalization.changed,
      fixtureSectorUnmatched: fixtureNormalization.unmatched,
      sectorReindexed: reindex.reindexed,
      reindexFailures: reindex.failures,
      identifierInserted,
      identifierExisting,
      identifierConflicts,
      fetchedProfiles,
      cachedProfiles,
      failures,
    };
  } finally {
    await pool.end();
  }
}

async function enrichCompany(
  company: EntityCompany,
  context: {
    db: Db;
    tickerMap: Map<string, string>;
    force: boolean;
    dryRun: boolean;
  },
): Promise<CompanyEnrichment> {
  const targets = securityTargets(company);
  const profiles: F10CompanyProfile[] = [];
  const errors: string[] = [];
  let fetched = 0;
  let cached = 0;

  for (const target of targets) {
    try {
      const snapshot = await loadOrFetchProfile(target, context.force);
      if (snapshot.fromCache) cached += 1;
      else fetched += 1;
      profiles.push(
        parseF10CompanyProfile({
          market: target.market,
          page: snapshot.snapshot.page,
        }),
      );
    } catch (error) {
      errors.push(
        `${target.market}:${target.code} profile: ${messageOf(error)}`,
      );
    }
  }

  const edgar = loadEdgarProfile(company, context.tickerMap);
  const identifiers: PlannedIdentifier[] = [];

  // Canonical ticker identifiers for every security (the index sync already
  // wrote these for A500/SPX; researched companies may lack them).
  for (const target of targets) {
    identifiers.push({
      companyId: company.id,
      idType: "ticker",
      idValue: tickerIdValue({
        market: target.market,
        ticker: target.ticker,
        code: target.code,
        exchange: target.exchange,
      }),
      source: "security",
    });
  }

  for (const profile of profiles) {
    if (profile.domain) {
      identifiers.push({
        companyId: company.id,
        idType: "domain",
        idValue: profile.domain,
        source: profile.url,
      });
    }
    if (profile.isin) {
      identifiers.push({
        companyId: company.id,
        idType: "isin",
        idValue: profile.isin,
        source: profile.url,
      });
    }
    if (profile.uscc) {
      identifiers.push({
        companyId: company.id,
        idType: "uscc",
        idValue: profile.uscc,
        source: profile.url,
      });
    }
  }
  if (edgar) {
    for (const [idType, idValue] of [
      ["cik", edgar.cik],
      ["lei", edgar.lei],
      ["ein", edgar.ein],
      ["domain", edgar.domain],
    ] as const) {
      if (idValue) {
        identifiers.push({
          companyId: company.id,
          idType,
          idValue,
          source: "sec-edgar-submissions",
        });
      }
    }
  }

  const sector =
    chooseSector(profiles, edgar) ??
    legacySector(company);
  const industry =
    profiles.find((profile) => profile.industry)?.industry ?? undefined;
  const industryCsrc =
    profiles.find((profile) => profile.industryCsrc)?.industryCsrc ?? undefined;
  const englishName =
    profiles.find((profile) => profile.englishName)?.englishName ?? undefined;
  const companyName =
    profiles.find((profile) => profile.companyName)?.companyName ?? undefined;

  const now = new Date().toISOString();
  const profilePatch: Record<string, unknown> = {
    sectorTaxonomy: SECTOR_TAXONOMY_VERSION,
    entityEnrichmentAt: now,
    ...(industry ? { industry } : {}),
    ...(industryCsrc ? { industryCsrc } : {}),
    ...(englishName ? { englishName } : {}),
    ...(companyName ? { companyName } : {}),
    ...(edgar?.sic ? { sic: edgar.sic } : {}),
    ...(edgar?.sicDescription ? { sicDescription: edgar.sicDescription } : {}),
    sectorSource: sector
      ? {
          taxonomy: SECTOR_TAXONOMY_VERSION,
          rule: sector.rule,
          label: sector.label,
          market: sector.market,
          ...(sector.url ? { url: sector.url } : {}),
          ...(sector.fetchedAt ? { fetchedAt: sector.fetchedAt } : {}),
        }
      : {
          taxonomy: SECTOR_TAXONOMY_VERSION,
          unmatched: true,
          ...(industry ? { label: industry } : {}),
          ...(edgar?.sicDescription ? { label: edgar.sicDescription } : {}),
        },
  };

  let changed = false;
  if (!context.dryRun) {
    changed = await updateEntityProfile(context.db, {
      companyId: company.id,
      ...(sector ? { sector: sector.sector } : {}),
      profilePatch,
    });
  } else {
    changed = Boolean(sector && sector.sector !== company.sector);
  }

  return {
    company,
    changed,
    ...(targets[0]?.market ? { market: targets[0].market } : {}),
    ...(sector ? { sector: sector.sector } : {}),
    ...(sector ? { sectorRule: sector.rule } : {}),
    ...(sector ? { sectorLabel: sector.label } : {}),
    ...(sector ? { sectorMarket: sector.market } : {}),
    ...(sector?.url ? { sectorUrl: sector.url } : {}),
    ...(industry ? { industry } : {}),
    ...(industryCsrc ? { industryCsrc } : {}),
    ...(edgar?.sic ? { sic: edgar.sic } : {}),
    ...(edgar?.sicDescription ? { sicDescription: edgar.sicDescription } : {}),
    profilePatch,
    identifiers,
    errors,
    fetched,
    cached,
  };
}

interface SectorChoice {
  sector: CanonicalSector;
  rule: string;
  label: string;
  market: Market;
  source: "f10" | "sic" | "legacy";
  url?: string;
  fetchedAt?: string;
}

function chooseSector(
  profiles: F10CompanyProfile[],
  edgar: ReturnType<typeof parseEdgarProfile>,
): SectorChoice | null {
  for (const profile of profiles) {
    const decision = sectorFromEastmoneyIndustry(profile.industry, profile.market);
    if (decision) {
      return {
        sector: decision.sector,
        rule: decision.rule,
        label: decision.label,
        market: profile.market,
        source: "f10",
        url: profile.url,
        ...(profile.fetchedAt ? { fetchedAt: profile.fetchedAt } : {}),
      };
    }
  }
  if (edgar?.sic) {
    const decision = sectorFromSic(edgar.sic, edgar.sicDescription);
    if (decision) {
      return {
        sector: decision.sector,
        rule: decision.rule,
        label: decision.label,
        market: "US",
        source: "sic",
        ...(edgar.cik
          ? {
              url: `https://data.sec.gov/submissions/CIK${edgar.cik}.json`,
            }
          : {}),
      };
    }
  }
  return null;
}

/** Keep an existing canonical/legacy value when no vendor profile is usable. */
function legacySector(company: EntityCompany): SectorChoice | null {
  const legacy = sectorFromLegacyLabel(company.sector);
  if (!legacy) return null;
  return {
    sector: legacy.sector,
    rule: legacy.rule,
    label: legacy.label,
    market: securityTargets(company)[0]?.market ?? "US",
    source: "legacy",
  };
}

function securityTargets(company: EntityCompany): ProfileTarget[] {
  const targets: ProfileTarget[] = [];
  for (const security of company.securities) {
    const exchange = security.exchange.toUpperCase();
    if (exchange === "HKEX") {
      targets.push({
        market: "HK",
        code: security.ticker.replace(/^0*/, "").padStart(5, "0"),
        page: "CompanyProfile",
        ticker: security.ticker,
        exchange,
      });
    } else if (exchange === "SSE" || exchange === "SZSE") {
      targets.push({
        market: "A",
        code: security.ticker.replace(/\D/g, "").padStart(6, "0"),
        page: "gsgk",
        ticker: security.ticker,
        exchange,
      });
    } else {
      targets.push({
        market: "US",
        code: security.ticker.toUpperCase(),
        page: "gsgk",
        ticker: security.ticker.toUpperCase(),
        exchange,
      });
    }
  }
  // One profile per market is enough (GOOG/GOOGL, HK + A dual listings are
  // handled separately because A adds USCC).
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.market}:${target.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function loadOrFetchProfile(
  target: ProfileTarget,
  force: boolean,
): Promise<{ snapshot: ProfileSnapshot; fromCache: boolean }> {
  const file = path.join(
    config.f10Dir,
    target.market,
    target.code,
    `${target.page}.json`,
  );
  if (!force) {
    const cached = readJson<ProfileSnapshot>(file);
    if (cached?.page?.url && !cached.page.error) {
      return { snapshot: cached, fromCache: true };
    }
  }
  const client = new FinanceAnalystClient({ baseUrl: config.financeAnalystUrl });
  const response = await client.scrape(
    {
      market: target.market,
      code: target.code,
      pages: [target.page],
      capture_xhr: false,
    },
    { timeoutMs: 180_000 },
  );
  const page = response.pages[0];
  if (!page || page.error || page.http_status !== 200) {
    throw new Error(page?.error ?? `F10 page HTTP ${page?.http_status ?? "?"}`);
  }
  const snapshot: ProfileSnapshot = {
    meta: { fetched_at: response.meta.fetched_at },
    page: {
      ...(page.page ? { page: page.page } : {}),
      ...(page.label ? { label: page.label } : {}),
      url: page.url,
      ...(page.text ? { text: page.text } : {}),
      tables: page.tables ?? [],
      ...(page.http_status !== undefined ? { http_status: page.http_status } : {}),
    },
  };
  writeJson(file, snapshot);
  return { snapshot, fromCache: false };
}

function loadEdgarTickerMap(): Map<string, string> {
  const file = path.join(config.edgarDir, "company_tickers.json");
  const payload = readJson<Record<string, { cik_str?: number; ticker?: string }>>(file);
  const map = new Map<string, string>();
  if (!payload) return map;
  for (const entry of Object.values(payload)) {
    if (!entry?.ticker || entry.cik_str === undefined) continue;
    map.set(entry.ticker.toUpperCase(), String(entry.cik_str).padStart(10, "0"));
  }
  return map;
}

function loadEdgarProfile(
  company: EntityCompany,
  tickerMap: Map<string, string>,
): ReturnType<typeof parseEdgarProfile> {
  const us = company.securities.find((security) =>
    ["NASDAQ", "NYSE", "AMEX", "CBOE"].includes(security.exchange.toUpperCase()),
  );
  if (!us) return null;
  const fromIds = company.identifiers.find(
    (identifier) => identifier.idType === "cik",
  )?.idValue;
  const cik = fromIds ?? tickerMap.get(us.ticker.toUpperCase());
  if (!cik) return null;
  const submissions = readJson<Record<string, unknown>>(
    path.join(config.edgarDir, cik, "submissions.json"),
  );
  return parseEdgarProfile(submissions);
}

// ---------------------------------------------------------------------------
// coverage
// ---------------------------------------------------------------------------

interface CoverageReport {
  researched: number;
  stubs: number;
  sectors: {
    covered: number;
    missing: string[];
    bySector: Record<string, number>;
  };
  identifiers: Record<string, { covered: number; missing: string[] }>;
  duplicateIdentifiers: Array<{
    idType: string;
    idValue: string;
    companies: string[];
  }>;
}

const IDENTIFIER_TYPES = [
  "ticker",
  "cik",
  "cusip",
  "domain",
  "isin",
  "uscc",
  "lei",
  "wikidata",
  "ein",
] as const;

async function collectCoverage(db: Db): Promise<CoverageReport> {
  const companies = await listEntityCompanies(db);
  const researched = companies.filter(
    (company) => company.coverageTier !== "stub",
  );
  const stubs = companies.length - researched.length;
  const sector = summarizeSectors(
    researched.map((company) => ({
      slug: company.slug,
      sector: company.sector as CanonicalSector | null,
    })),
  );
  const identifiers: CoverageReport["identifiers"] = {};
  for (const idType of IDENTIFIER_TYPES) {
    const missing = researched
      .filter(
        (company) =>
          !company.identifiers.some((identifier) => identifier.idType === idType),
      )
      .map((company) => company.slug);
    identifiers[idType] = {
      covered: researched.length - missing.length,
      missing,
    };
  }
  const owners = new Map<string, Set<string>>();
  for (const company of researched) {
    for (const identifier of company.identifiers) {
      const key = `${identifier.idType}\0${identifier.idValue}`;
      const set = owners.get(key) ?? new Set<string>();
      set.add(company.slug);
      owners.set(key, set);
    }
  }
  const duplicateIdentifiers = [...owners.entries()]
    .filter(([, slugs]) => slugs.size > 1)
    .map(([key, slugs]) => {
      const [idType, idValue] = key.split("\0");
      return { idType: idType!, idValue: idValue!, companies: [...slugs] };
    });
  return {
    researched: researched.length,
    stubs,
    sectors: sector,
    identifiers,
    duplicateIdentifiers,
  };
}

function summarizeSectors(
  rows: Array<{ slug: string; sector: CanonicalSector | null }>,
): { covered: number; missing: string[]; bySector: Record<string, number> } {
  const bySector: Record<string, number> = {};
  const missing: string[] = [];
  let covered = 0;
  for (const row of rows) {
    if (row.sector && (CANONICAL_SECTORS as readonly string[]).includes(row.sector)) {
      covered += 1;
      bySector[row.sector] = (bySector[row.sector] ?? 0) + 1;
    } else {
      missing.push(row.slug);
    }
  }
  return { covered, missing, bySector };
}

/**
 * Fixtures still carry the old thematic sector labels (`AI 芯片`, `大模型`,
 * …). They are hidden from search, but A500/SPX index pages build their sector
 * filter from membership rows, so a fixture member would leak a non-canonical
 * value into the filter. Map those labels deterministically; never fetch a
 * profile and never touch stubs.
 */
async function normalizeFixtureSectors(
  db: Db,
  dryRun: boolean,
): Promise<{ changed: number; unmatched: string[] }> {
  const companies = await listEntityCompanies(db, { includeFixtures: true });
  const unmatched: string[] = [];
  let changed = 0;
  for (const company of companies) {
    if (!company.isFixture || company.coverageTier === "stub") continue;
    if (!company.sector) continue;
    const decision = sectorFromLegacyLabel(company.sector);
    if (!decision) {
      unmatched.push(`${company.slug}:${company.sector}`);
      continue;
    }
    if (decision.sector === company.sector) continue;
    changed += 1;
    if (dryRun) continue;
    await updateEntityProfile(db, {
      companyId: company.id,
      sector: decision.sector,
      profilePatch: {
        sectorTaxonomy: SECTOR_TAXONOMY_VERSION,
        sectorSource: {
          taxonomy: SECTOR_TAXONOMY_VERSION,
          rule: decision.rule,
          label: decision.label,
          market: securityTargets(company)[0]?.market ?? "US",
        },
      },
    });
  }
  return { changed, unmatched };
}

// ---------------------------------------------------------------------------
// resolve: deterministic cross-listing merges
// ---------------------------------------------------------------------------

export interface ResolveReport {
  apply: boolean;
  stubs: number;
  candidates: number;
  confirmed: number;
  merged: number;
  skipped: Array<{ slug: string; reason: string }>;
  blocked: Array<{ slug: string; reason: string }>;
  duplicateIdentifiers: CoverageReport["duplicateIdentifiers"];
  merges: Array<{
    survivor: string;
    merged: string;
    hCode: string;
    sourceUrl: string;
  }>;
}

export async function resolveEntities(
  options: {
    apply?: boolean;
    force?: boolean;
    limit?: number;
  } = {},
): Promise<ResolveReport> {
  const apply = Boolean(options.apply);
  if (apply) await migrate(config.databaseUrl);
  const { db, pool } = createDb(config.databaseUrl);
  try {
    const companies = await listEntityCompanies(db);
    const researched = companies.filter(
      (company) => company.coverageTier !== "stub",
    );
    const stubs = companies.filter((company) => company.coverageTier === "stub");
    const hkByTicker = new Map<string, EntityCompany>();
    for (const company of researched) {
      for (const security of company.securities) {
        if (security.exchange.toUpperCase() === "HKEX") {
          hkByTicker.set(
            security.ticker.replace(/^0*/, "").padStart(5, "0"),
            company,
          );
        }
      }
    }

    const coverage = await collectCoverage(db);
    const candidateStubs: Array<{
      stub: EntityCompany;
      targets: EntityCompany[];
    }> = [];
    for (const stub of stubs) {
      const aSecurity = stub.securities.find((security) =>
        ["SSE", "SZSE"].includes(security.exchange.toUpperCase()),
      );
      if (!aSecurity) continue;
      const stubNames = [stub.displayName, stub.legalName, ...stub.aliases];
      const matches = researched.filter((company) =>
        company.securities.some(
          (security) => security.exchange.toUpperCase() === "HKEX",
        ) && nameMatches(stubNames, [
          company.displayName,
          company.legalName,
          ...company.aliases,
        ]),
      );
      if (matches.length > 0) candidateStubs.push({ stub, targets: matches });
    }

    const limited = options.limit
      ? candidateStubs.slice(0, options.limit)
      : candidateStubs;
    const skipped: ResolveReport["skipped"] = [];
    const blocked: ResolveReport["blocked"] = [];
    const merges: ResolveReport["merges"] = [];
    let confirmed = 0;
    let merged = 0;
    const survivorIds = new Set<string>();

    for (const candidate of limited) {
      const aSecurity = candidate.stub.securities.find((security) =>
        ["SSE", "SZSE"].includes(security.exchange.toUpperCase()),
      );
      if (!aSecurity) continue;
      let profile: F10CompanyProfile;
      try {
        const snapshot = await loadOrFetchProfile(
          {
            market: "A",
            code: aSecurity.ticker.replace(/\D/g, "").padStart(6, "0"),
            page: "gsgk",
            ticker: aSecurity.ticker,
            exchange: aSecurity.exchange,
          },
          Boolean(options.force),
        );
        profile = parseF10CompanyProfile({
          market: "A",
          page: snapshot.snapshot.page,
        });
      } catch (error) {
        skipped.push({
          slug: candidate.stub.slug,
          reason: `profile unavailable: ${messageOf(error)}`,
        });
        continue;
      }
      if (!profile.hCode) {
        skipped.push({
          slug: candidate.stub.slug,
          reason: "no H股代码 in the A-share profile",
        });
        continue;
      }
      const survivor = hkByTicker.get(profile.hCode);
      if (!survivor) {
        skipped.push({
          slug: candidate.stub.slug,
          reason: `H股代码 ${profile.hCode} is not a researched HK company`,
        });
        continue;
      }
      confirmed += 1;
      const merge = {
        survivor: survivor.slug,
        merged: candidate.stub.slug,
        hCode: profile.hCode,
        sourceUrl: profile.url,
      };
      merges.push(merge);
      survivorIds.add(survivor.id);
      if (!apply) continue;
      // Carry the A-share profile identifiers into the merge so the survivor
      // keeps the USCC/domain evidence instead of losing it with the stub row.
      const carried = [
        ...(profile.uscc
          ? [{ companyId: candidate.stub.id, idType: "uscc", idValue: profile.uscc }]
          : []),
        ...(profile.domain
          ? [{ companyId: candidate.stub.id, idType: "domain", idValue: profile.domain }]
          : []),
      ];
      try {
        if (carried.length > 0) {
          await insertCompanyIdentifiers(db, carried);
        }
        await mergeEntityCompanies(db, {
          survivorId: survivor.id,
          mergedId: candidate.stub.id,
          reason: "cross-listing:H股代码",
          evidence: {
            source: "eastmoney-f10",
            page: "gsgk",
            field: "H股代码",
            value: profile.hCode,
            url: profile.url,
            stub: {
              companyId: candidate.stub.id,
              slug: candidate.stub.slug,
              displayName: candidate.stub.displayName,
            },
          },
        });
        merged += 1;
      } catch (error) {
        blocked.push({
          slug: candidate.stub.slug,
          reason: messageOf(error),
        });
      }
    }

    if (apply && survivorIds.size > 0) {
      await reindexCompanies([...survivorIds], {});
    }

    return {
      apply,
      stubs: stubs.length,
      candidates: candidateStubs.length,
      confirmed,
      merged,
      skipped,
      blocked,
      duplicateIdentifiers: coverage.duplicateIdentifiers,
      merges,
    };
  } finally {
    await pool.end();
  }
}

function nameMatches(left: string[], right: string[]): boolean {
  const normalizedLeft = left
    .map((value) => normalizeName(value))
    .filter((value) => value.length >= 3);
  const normalizedRight = right
    .map((value) => normalizeName(value))
    .filter((value) => value.length >= 3);
  for (const a of normalizedLeft) {
    for (const b of normalizedRight) {
      if (a === b) return true;
      if (a.length >= 4 && b.length >= 4 && (b.includes(a) || a.includes(b))) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// gleif: LEI coverage + parent edges
// ---------------------------------------------------------------------------

export interface GleifReport {
  apply: boolean;
  companies: number;
  alreadyKnown: number;
  resolved: number;
  /** Stub companies enriched with an LEI because they are a parent. */
  stubLeis: number;
  ambiguous: Array<{ slug: string; candidates: Array<{ lei: string; legalName: string; country?: string }> }>;
  unmatched: string[];
  identifiersInserted: number;
  identifierConflicts: number;
  edges: Array<{
    child: string;
    parent: string;
    childCompanyId: string;
    parentCompanyId: string;
    relation: "direct" | "ultimate";
    sourceUrl: string;
  }>;
  outOfUniverseParents: number;
  outOfUniverse: Array<{
    child: string;
    parentLei: string;
    parentName: string;
    relation: "direct" | "ultimate";
  }>;
  edgesWritten: number;
}

export async function gleifEntities(
  options: { apply?: boolean; limit?: number } = {},
): Promise<GleifReport> {
  const apply = Boolean(options.apply);
  if (apply) await migrate(config.databaseUrl);
  const { db, pool } = createDb(config.databaseUrl);
  const client = new GleifClient({ baseUrl: config.gleifBaseUrl });
  try {
    const allCompanies = await listEntityCompanies(db);
    const companies = allCompanies.filter(
      (company) => company.coverageTier !== "stub",
    );
    const stubs = allCompanies.filter(
      (company) => company.coverageTier === "stub",
    );
    const selected = options.limit ? companies.slice(0, options.limit) : companies;
    const byId = new Map(allCompanies.map((company) => [company.id, company]));
    const stubsByName = new Map<string, EntityCompany[]>();
    for (const stub of stubs) {
      for (const name of allCompanyNames(stub)) {
        const key = normalizeFullName(name);
        if (!key) continue;
        const list = stubsByName.get(key) ?? [];
        list.push(stub);
        stubsByName.set(key, list);
      }
    }

    const leiByCompany = new Map<string, string>();
    for (const company of allCompanies) {
      const lei = company.identifiers.find(
        (identifier) => identifier.idType === "lei",
      )?.idValue;
      if (lei) leiByCompany.set(company.id, lei);
    }
    const alreadyKnown = leiByCompany.size;
    let resolved = 0;
    let stubLeis = 0;
    const ambiguous: GleifReport["ambiguous"] = [];
    const unmatched: string[] = [];
    const planned: Array<{ companyId: string; idType: string; idValue: string }> = [];

    for (const company of selected) {
      if (leiByCompany.has(company.id)) continue;
      const names = companyNames(company);
      const allowedCountries = allowedLeiCountries(company);
      const records: GleifRecord[] = [];
      let decision: ReturnType<typeof matchGleifLei> = null;
      for (const name of names.slice(0, 3)) {
        try {
          records.push(...(await client.searchLegalName(name)));
        } catch {
          // A transient GLEIF failure must not abort the whole run.
        }
        decision = matchGleifLei(records, names, allowedCountries);
        if (isGleifResolution(decision)) break;
      }
      if (decision && isGleifResolution(decision)) {
        leiByCompany.set(company.id, decision.lei);
        planned.push({
          companyId: company.id,
          idType: "lei",
          idValue: decision.lei,
        });
        resolved += 1;
        continue;
      }
      if (decision && "candidates" in decision) {
        ambiguous.push({ slug: company.slug, candidates: decision.candidates });
      } else {
        unmatched.push(company.slug);
      }
    }

    const leiToCompany = new Map<string, EntityCompany>();
    for (const [companyId, lei] of leiByCompany) {
      const company = byId.get(companyId);
      if (company) leiToCompany.set(lei, company);
    }

    const edges: GleifReport["edges"] = [];
    const outOfUniverse: GleifReport["outOfUniverse"] = [];
    let outOfUniverseParents = 0;
    const seenEdges = new Set<string>();
    for (const [companyId, lei] of [...leiByCompany.entries()]) {
      const child = byId.get(companyId);
      // Only researched companies are children; stubs can become parents below.
      if (!child || child.coverageTier === "stub") continue;
      let parent = null;
      let relation: "direct" | "ultimate" = "direct";
      try {
        parent = await client.getParent(lei, "direct");
        if (!parent) {
          parent = await client.getParent(lei, "ultimate");
          relation = "ultimate";
        }
      } catch {
        continue;
      }
      if (!parent) continue;
      let parentCompany = leiToCompany.get(parent.parentLei);
      if (!parentCompany || parentCompany.id === child.id) {
        // A listed parent may already exist as an A500/SPX stub. Give that stub
        // its exact LEI so the real edge can be written instead of dropping it.
        const stub = uniqueStubByName(stubsByName, parent.parentName);
        const known = stub
          ? leiByCompany.get(stub.id)
          : undefined;
        if (stub && (!known || known === parent.parentLei)) {
          if (!known) {
            leiByCompany.set(stub.id, parent.parentLei);
            planned.push({
              companyId: stub.id,
              idType: "lei",
              idValue: parent.parentLei,
            });
            stubLeis += 1;
          }
          parentCompany = stub;
          leiToCompany.set(parent.parentLei, stub);
        }
      }
      if (!parentCompany || parentCompany.id === child.id) {
        outOfUniverseParents += 1;
        outOfUniverse.push({
          child: child.slug,
          parentLei: parent.parentLei,
          parentName: parent.parentName,
          relation,
        });
        continue;
      }
      const key = `${parentCompany.id}\0${child.id}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push({
        child: child.slug,
        parent: parentCompany.slug,
        childCompanyId: child.id,
        parentCompanyId: parentCompany.id,
        relation,
        sourceUrl: parent.sourceUrl,
      });
    }

    let identifiersInserted = 0;
    let identifierConflicts = 0;
    let edgesToWrite = edges;
    if (apply && planned.length > 0) {
      const inserted = await insertCompanyIdentifiers(db, planned);
      identifiersInserted = inserted.inserted;
      identifierConflicts = inserted.conflicts.length;
      const conflicted = new Set(
        inserted.conflicts.map((conflict) => conflict.companyId),
      );
      if (conflicted.size > 0) {
        edgesToWrite = edges.filter(
          (edge) =>
            !conflicted.has(edge.childCompanyId) &&
            !conflicted.has(edge.parentCompanyId),
        );
      }
    }

    let edgesWritten = 0;
    if (apply && edgesToWrite.length > 0) {
      const rows = edgesToWrite.map((edge) => {
        const parent = byId.get(edge.parentCompanyId)!;
        const child = byId.get(edge.childCompanyId)!;
        const quote = `GLEIF ${edge.relation} parent: ${child.displayName} (${child.slug}) → ${parent.displayName} (${parent.slug})`;
        return {
          id: relationId({
            srcCompanyId: parent.id,
            dstCompanyId: child.id,
            type: "parent_of",
            quote,
          }),
          parentCompanyId: parent.id,
          childCompanyId: child.id,
          quote,
          sourceUrl: edge.sourceUrl,
          sourceTitle: `GLEIF LEI ${edge.relation} parent relationship`,
          confidence: edge.relation === "direct" ? 0.9 : 0.8,
        };
      });
      const written = await upsertGleifRelations(db, rows);
      edgesWritten = written.relations;
    }

    return {
      apply,
      companies: companies.length,
      alreadyKnown,
      resolved,
      stubLeis,
      ambiguous,
      unmatched,
      identifiersInserted,
      identifierConflicts,
      edges,
      outOfUniverseParents,
      outOfUniverse,
      edgesWritten,
    };
  } finally {
    await pool.end();
  }
}

function allCompanyNames(company: EntityCompany): string[] {
  return [...new Set([...companyNames(company), ...company.aliases])];
}

function uniqueStubByName(
  stubsByName: Map<string, EntityCompany[]>,
  name: string,
): EntityCompany | null {
  const list = stubsByName.get(normalizeFullName(name));
  return list && list.length === 1 ? list[0]! : null;
}

function companyNames(company: EntityCompany): string[] {
  const names = [
    company.legalName,
    company.displayName,
    stringField(company.profile, "englishName"),
    stringField(company.profile, "companyName"),
  ].filter((value): value is string => Boolean(value && value.trim()));
  return [...new Set(names)];
}

function allowedLeiCountries(company: EntityCompany): string[] {
  if (company.country === "US") return ["US"];
  if (company.country === "CN") return ["CN", "HK"];
  if (company.country === "HK") return ["HK", "CN", "KY", "BM", "VG", "SG"];
  return [];
}

// ---------------------------------------------------------------------------
// wikidata
// ---------------------------------------------------------------------------

export interface WikidataReport {
  apply: boolean;
  companies: number;
  alreadyKnown: number;
  resolved: number;
  ambiguous: Array<{ slug: string; candidates: Array<{ qid: string; label: string }> }>;
  unmatched: string[];
  errors: Array<{ slug: string; error: string }>;
  identifiersInserted: number;
  identifierConflicts: number;
}

export async function wikidataEntities(
  options: { apply?: boolean; limit?: number } = {},
): Promise<WikidataReport> {
  const apply = Boolean(options.apply);
  if (apply) await migrate(config.databaseUrl);
  const { db, pool } = createDb(config.databaseUrl);
  const client = new WikidataClient({ baseUrl: config.wikidataApiUrl });
  try {
    const companies = (await listEntityCompanies(db)).filter(
      (company) => company.coverageTier !== "stub",
    );
    const selected = options.limit ? companies.slice(0, options.limit) : companies;
    const known = companies.filter((company) =>
      company.identifiers.some((identifier) => identifier.idType === "wikidata"),
    ).length;
    let resolved = 0;
    const ambiguous: WikidataReport["ambiguous"] = [];
    const unmatched: string[] = [];
    const errors: WikidataReport["errors"] = [];
    const planned: Array<{ companyId: string; idType: string; idValue: string }> = [];

    for (const company of selected) {
      if (
        company.identifiers.some(
          (identifier) => identifier.idType === "wikidata",
        )
      ) {
        continue;
      }
      const names = companyNames(company);
      let decision: ReturnType<typeof matchWikidataQid> = null;
      for (const name of names.slice(0, 3)) {
        const language = /[㐀-鿿]/.test(name) ? "zh" : "en";
        try {
          const candidates = await client.search(name, language);
          decision = matchWikidataQid(candidates, names);
        } catch (error) {
          errors.push({ slug: company.slug, error: messageOf(error) });
          decision = null;
          continue;
        }
        if (isWikidataResolution(decision)) break;
      }
      if (decision && isWikidataResolution(decision)) {
        planned.push({
          companyId: company.id,
          idType: "wikidata",
          idValue: decision.qid,
        });
        resolved += 1;
      } else if (decision && "candidates" in decision) {
        ambiguous.push({
          slug: company.slug,
          candidates: decision.candidates.map((candidate) => ({
            qid: candidate.qid,
            label: candidate.label,
          })),
        });
      } else {
        unmatched.push(company.slug);
      }
    }

    let identifiersInserted = 0;
    let identifierConflicts = 0;
    if (apply && planned.length > 0) {
      const inserted = await insertCompanyIdentifiers(db, planned);
      identifiersInserted = inserted.inserted;
      identifierConflicts = inserted.conflicts.length;
    }

    return {
      apply,
      companies: companies.length,
      alreadyKnown: known,
      resolved,
      ambiguous,
      unmatched,
      errors,
      identifiersInserted,
      identifierConflicts,
    };
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// reindex / output / command dispatch
// ---------------------------------------------------------------------------

async function reindexCompanies(
  companyIds: string[],
  options: { skip?: boolean },
): Promise<{
  reindexed: number;
  failures: Array<{ companyId: string; error: string }>;
}> {
  if (options.skip || companyIds.length === 0) {
    return { reindexed: 0, failures: [] };
  }
  let context: Awaited<ReturnType<typeof createIngestContext>> | null = null;
  const failures: Array<{ companyId: string; error: string }> = [];
  let reindexed = 0;
  try {
    context = await createIngestContext({
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
    for (const companyId of companyIds) {
      try {
        if (await reindexCompanyPoint(context.ctx, companyId)) reindexed += 1;
      } catch (error) {
        failures.push({ companyId, error: messageOf(error) });
      }
    }
  } catch (error) {
    failures.push({ companyId: "*", error: messageOf(error) });
  } finally {
    if (context) await context.close();
  }
  return { reindexed, failures };
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function stringField(
  profile: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = profile[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseMarkets(value: string | undefined): Market[] | undefined {
  if (!value) return undefined;
  const markets = value
    .split(",")
    .map((market) => market.trim().toUpperCase())
    .filter((market): market is Market =>
      market === "A" || market === "HK" || market === "US",
    );
  return markets.length > 0 ? markets : undefined;
}

function parseLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const limit = Number.parseInt(value, 10);
  return Number.isFinite(limit) && limit > 0 ? limit : undefined;
}

export async function entitiesCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  const rest = args.slice(1);
  if (!subcommand) {
    throw new Error(
      "usage: occ entities enrich|resolve|gleif|wikidata|coverage [options]",
    );
  }

  if (subcommand === "enrich") {
    const { values } = parseArgs({
      args: rest,
      options: {
        json: { type: "boolean" },
        "dry-run": { type: "boolean" },
        force: { type: "boolean" },
        "skip-index": { type: "boolean" },
        limit: { type: "string" },
        markets: { type: "string" },
      },
    });
    const report = await enrichEntities({
      force: Boolean(values.force),
      dryRun: Boolean(values["dry-run"]),
      skipIndex: Boolean(values["skip-index"]),
      markets: parseMarkets(values.markets),
      limit: parseLimit(values.limit),
    });
    if (values.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    printEnrich(report);
    return;
  }

  if (subcommand === "resolve") {
    const { values } = parseArgs({
      args: rest,
      options: {
        json: { type: "boolean" },
        apply: { type: "boolean" },
        force: { type: "boolean" },
        limit: { type: "string" },
      },
    });
    const report = await resolveEntities({
      apply: Boolean(values.apply),
      force: Boolean(values.force),
      limit: parseLimit(values.limit),
    });
    if (values.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    printResolve(report);
    return;
  }

  if (subcommand === "gleif") {
    const { values } = parseArgs({
      args: rest,
      options: {
        json: { type: "boolean" },
        apply: { type: "boolean" },
        limit: { type: "string" },
      },
    });
    const report = await gleifEntities({
      apply: Boolean(values.apply),
      limit: parseLimit(values.limit),
    });
    if (values.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    printGleif(report);
    return;
  }

  if (subcommand === "wikidata") {
    const { values } = parseArgs({
      args: rest,
      options: {
        json: { type: "boolean" },
        apply: { type: "boolean" },
        limit: { type: "string" },
      },
    });
    const report = await wikidataEntities({
      apply: Boolean(values.apply),
      limit: parseLimit(values.limit),
    });
    if (values.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    printWikidata(report);
    return;
  }

  if (subcommand === "coverage") {
    const { values } = parseArgs({
      args: rest,
      options: { json: { type: "boolean" } },
    });
    const { db, pool } = createDb(config.databaseUrl);
    try {
      const coverage = await collectCoverage(db);
      if (values.json) {
        console.log(JSON.stringify(coverage, null, 2));
        return;
      }
      printCoverage(coverage);
    } finally {
      await pool.end();
    }
    return;
  }

  throw new Error(
    "usage: occ entities enrich|resolve|gleif|wikidata|coverage [options]",
  );
}

function printCoverage(coverage: CoverageReport): void {
  console.log(
    `entities · ${coverage.researched} researched · ${coverage.stubs} stubs excluded`,
  );
  console.log(
    `  sector: ${coverage.sectors.covered}/${coverage.researched}` +
      (coverage.sectors.missing.length
        ? ` · missing ${coverage.sectors.missing.length}`
        : ""),
  );
  for (const [sector, count] of Object.entries(coverage.sectors.bySector).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`    ${String(count).padStart(3)}  ${sector}`);
  }
  for (const [idType, entry] of Object.entries(coverage.identifiers)) {
    console.log(
      `  ${idType.padEnd(8)} ${String(entry.covered).padStart(3)}/${coverage.researched}` +
        (entry.missing.length ? ` · missing ${entry.missing.length}` : ""),
    );
  }
  if (coverage.duplicateIdentifiers.length > 0) {
    console.log(`  duplicate identifiers: ${coverage.duplicateIdentifiers.length}`);
    for (const duplicate of coverage.duplicateIdentifiers.slice(0, 20)) {
      console.log(
        `    ${duplicate.idType}:${duplicate.idValue} → ${duplicate.companies.join(", ")}`,
      );
    }
  }
}

function printEnrich(report: EnrichReport): void {
  console.log(
    `entities enrich${report.dryRun ? " (dry run)" : ""} · ${report.processed}/${report.researched} companies`,
  );
  console.log(
    `  sector: ${report.sectors.covered}/${report.researched}` +
      (report.sectors.missing.length
        ? ` · missing ${report.sectors.missing.length}`
        : ""),
  );
  for (const [sector, count] of Object.entries(report.sectors.bySector).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`    ${String(count).padStart(3)}  ${sector}`);
  }
  console.log(
    `  profiles: ${report.fetchedProfiles} fetched · ${report.cachedProfiles} cached`,
  );
  console.log(
    `  identifiers: +${report.identifierInserted} · ${report.identifierExisting} existing` +
      (report.identifierConflicts.length
        ? ` · ${report.identifierConflicts.length} conflicts`
        : ""),
  );
  for (const [idType, entry] of Object.entries(report.identifiers)) {
    console.log(
      `    ${idType.padEnd(8)} ${String(entry.covered).padStart(3)}/${report.researched}` +
        (entry.missing.length ? ` · missing ${entry.missing.length}` : ""),
    );
  }
  console.log(
    `  reindexed ${report.sectorReindexed}` +
      (report.reindexFailures.length
        ? ` · reindex failures ${report.reindexFailures.length}`
        : ""),
  );
  if (report.fixturesNormalized > 0 || report.fixtureSectorUnmatched.length > 0) {
    console.log(
      `  fixture sectors normalized ${report.fixturesNormalized}` +
        (report.fixtureSectorUnmatched.length
          ? ` · unmatched ${report.fixtureSectorUnmatched.join(", ")}`
          : ""),
    );
  }
  if (report.sectors.missing.length > 0) {
    console.log(`  sector missing: ${report.sectors.missing.join(", ")}`);
  }
  if (report.failures.length > 0) {
    console.log(`  profile failures: ${report.failures.length}`);
    for (const failure of report.failures.slice(0, 20)) {
      console.log(`    ${failure.slug}: ${failure.error}`);
    }
  }
}

function printResolve(report: ResolveReport): void {
  console.log(
    `entities resolve${report.apply ? "" : " (dry run)"} · ${report.candidates} candidate stubs · ${report.confirmed} confirmed`,
  );
  for (const merge of report.merges) {
    console.log(
      `  ${report.apply ? "merged" : "would merge"} ${merge.merged} → ${merge.survivor} (H股 ${merge.hCode})`,
    );
  }
  for (const skipped of report.skipped.slice(0, 30)) {
    console.log(`  skipped ${skipped.slug}: ${skipped.reason}`);
  }
  for (const blocker of report.blocked) {
    console.log(`  BLOCKED ${blocker.slug}: ${blocker.reason}`);
  }
  if (report.duplicateIdentifiers.length > 0) {
    console.log(`  duplicate identifiers: ${report.duplicateIdentifiers.length}`);
  }
}

function printGleif(report: GleifReport): void {
  console.log(
    `entities gleif${report.apply ? "" : " (dry run)"} · ${report.companies} companies`,
  );
  console.log(
    `  LEI: ${report.alreadyKnown} known · +${report.resolved} resolved · ${report.stubLeis} stub parent(s) · ${report.ambiguous.length} ambiguous · ${report.unmatched.length} unmatched`,
  );
  console.log(
    `  identifiers: +${report.identifiersInserted} · ${report.identifierConflicts} conflicts`,
  );
  console.log(
    `  edges: ${report.edges.length} in-universe · ${report.outOfUniverseParents} under out-of-universe parents` +
      (report.apply ? ` · written ${report.edgesWritten}` : ""),
  );
  for (const edge of report.edges.slice(0, 30)) {
    console.log(
      `    ${edge.parent} --parent_of--> ${edge.child} (${edge.relation})`,
    );
  }
  for (const item of report.outOfUniverse.slice(0, 20)) {
    console.log(
      `  out-of-universe parent: ${item.child} → ${item.parentName} (${item.parentLei}, ${item.relation})`,
    );
  }
  for (const item of report.ambiguous.slice(0, 20)) {
    console.log(
      `  ambiguous ${item.slug}: ${item.candidates
        .map((candidate) => `${candidate.legalName} (${candidate.lei})`)
        .join(", ")}`,
    );
  }
  if (report.unmatched.length > 0) {
    console.log(`  unmatched: ${report.unmatched.slice(0, 30).join(", ")}`);
  }
}

function printWikidata(report: WikidataReport): void {
  console.log(
    `entities wikidata${report.apply ? "" : " (dry run)"} · ${report.companies} companies`,
  );
  console.log(
    `  QID: ${report.alreadyKnown} known · +${report.resolved} resolved · ${report.ambiguous.length} ambiguous · ${report.unmatched.length} unmatched`,
  );
  console.log(
    `  identifiers: +${report.identifiersInserted} · ${report.identifierConflicts} conflicts`,
  );
  if (report.unmatched.length > 0) {
    console.log(`  unmatched: ${report.unmatched.slice(0, 30).join(", ")}`);
  }
  if (report.errors.length > 0) {
    console.log(`  request errors: ${report.errors.length}`);
    for (const error of report.errors.slice(0, 10)) {
      console.log(`    ${error.slug}: ${error.error}`);
    }
  }
}

export { USAGE_OPTIONS };

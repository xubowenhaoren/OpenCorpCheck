import { parseArgs } from "node:util";

import { newId } from "@occ/core";
import {
  and,
  desc,
  eq,
  inArray,
  sql,
} from "drizzle-orm";
import {
  createDb,
  listEntityCompanies,
  migrate,
  ownershipSyncRuns,
  relations,
  reviewQueue,
  upsertOwnershipRelations,
  type Db,
  type EntityCompany,
  type OwnershipWriteResult,
} from "@occ/db";
import {
  buildNameIndex,
  coverPageColumns,
  DionClient,
  ensureThirteenFDataSet,
  HKEX_DION_VERSION,
  infoTableColumns,
  parseThirteenFNumber,
  planDionOwnership,
  readThirteenFTsv,
  resolveLatestThirteenFDataSet,
  resolveThirteenFDataSets,
  submissionColumns,
  THIRTEEN_F_VERSION,
  ThirteenFPlanner,
  type DionNotice,
  type OwnershipEdgeDraft,
  type ThirteenFDataSet,
  type ThirteenFStats,
} from "@occ/sources-ownership";

import { config } from "./config.js";

/**
 * `occ ownership sync` — US SEC Form 13F + HKEX DION ownership edges.
 *
 * Deterministic and LLM-free. Both adapters only connect companies that are
 * already in `companies`; out-of-universe counterparties are counted. Writes
 * are additive and idempotent, every edge gets evidence + a pending review
 * item, and a new quarter updates the existing `(holder, issuer, type)` edge.
 */

const USAGE_OPTIONS = `
Ownership options:
  --market US|HK|all    Market to sync (default: all)
  --apply               Write edges (default: dry run)
  --limit <n>           US: max 13F-HR filings; HK: max companies
  --days <n>            HK DION lookback in days (default: 365)
  --max-pages <n>       HK DION result pages per company (default: 10)
  --dataset <name>      Pin a 13F data set, e.g. 01mar2026-31may2026
  --refresh             Re-download the 13F data set
  --json                Machine-readable report
`;


export type OwnershipMarket = "US" | "HK" | "ALL";

export interface UsOwnershipReport {
  market: "US";
  apply: boolean;
  dataset: {
    name: string;
    url: string;
    sha256: string;
    bytes: number;
    downloaded: boolean;
  };
  submissions: {
    total: number;
    selected: number;
    skippedByType: Record<string, number>;
  };
  planner: ThirteenFStats;
  edges: number;
  write?: OwnershipWriteResult;
}

export interface HkOwnershipReport {
  market: "HK";
  apply: boolean;
  days: number;
  companies: number;
  notices: number;
  noticesWithLongPosition: number;
  matchedHolderCompanies: number;
  unmatchedHolderNames: string[];
  ambiguousHolderNames: string[];
  edges: number;
  latestEventDate: string | null;
  /** Companies whose notice list exceeded `--max-pages`. */
  truncatedCompanies: string[];
  failures: Array<{ company: string; code: string; error: string }>;
  write?: OwnershipWriteResult;
}

export interface OwnershipSyncReport {
  us?: UsOwnershipReport;
  hk?: HkOwnershipReport;
}

interface CompanyIndex {
  filerByCik: Map<string, string>;
  issuerByCusip: Map<string, string>;
  nameIndex: Map<string, string | null>;
}

export interface OwnershipSyncOptions {
  market?: OwnershipMarket;
  apply?: boolean;
  limit?: number;
  days?: number;
  maxPages?: number;
  dataset?: string;
  refresh?: boolean;
}

export async function ownershipSync(
  options: OwnershipSyncOptions = {},
): Promise<OwnershipSyncReport> {
  const apply = Boolean(options.apply);
  if (apply) await migrate(config.databaseUrl);
  const { db, pool } = createDb(config.databaseUrl);
  try {
    const companies = await listEntityCompanies(db);
    const index = buildCompanyIndex(companies);
    const market = options.market ?? "ALL";
    const report: OwnershipSyncReport = {};
    if (market === "US" || market === "ALL") {
      report.us = await syncUs(db, index, { ...options, apply });
    }
    if (market === "HK" || market === "ALL") {
      report.hk = await syncHk(db, companies, index, { ...options, apply });
    }
    return report;
  } finally {
    await pool.end();
  }
}

function buildCompanyIndex(companies: EntityCompany[]): CompanyIndex {
  const filerByCik = new Map<string, string>();
  const issuerByCusip = new Map<string, string>();
  for (const company of companies) {
    for (const identifier of company.identifiers) {
      if (identifier.idType === "cik") {
        filerByCik.set(normalizeCik(identifier.idValue), company.id);
      } else if (identifier.idType === "cusip") {
        issuerByCusip.set(identifier.idValue.trim().toUpperCase(), company.id);
      }
    }
  }
  const nameIndex = buildNameIndex(
    companies.map((company) => ({
      companyId: company.id,
      names: [
        company.displayName,
        company.legalName,
        stringField(company.profile, "englishName"),
        stringField(company.profile, "companyName"),
        ...company.aliasEntries
          // Pinyin initials and tickers are search keys, not counterparty
          // names: `sndl` for 深南电路 must not match SNDL Inc.
          .filter((entry) => entry.kind !== "pinyin" && entry.kind !== "ticker")
          .map((entry) => entry.alias),
      ].filter((value): value is string => Boolean(value)),
    })),
  );
  return { filerByCik, issuerByCusip, nameIndex };
}

async function syncUs(
  db: Db,
  index: CompanyIndex,
  options: OwnershipSyncOptions,
): Promise<UsOwnershipReport> {
  const userAgent = config.edgarUserAgent;
  let dataset: ThirteenFDataSet;
  if (options.dataset) {
    const datasets = await resolveThirteenFDataSets({ userAgent });
    const found = datasets.find((candidate) => candidate.name === options.dataset);
    if (!found) {
      throw new Error(
        `13F data set ${options.dataset} not found; available: ${datasets
          .map((candidate) => candidate.name)
          .join(", ")}`,
      );
    }
    dataset = found;
  } else {
    dataset = await resolveLatestThirteenFDataSet({ userAgent });
  }
  const cached = await ensureThirteenFDataSet({
    dataset,
    edgarDir: config.edgarDir,
    userAgent,
    refresh: Boolean(options.refresh),
    onProgress: (message) => console.error(`ownership US: ${message}`),
  });

  const managerNames = await readCoverPageNames(cached.zipPath);
  const planner = new ThirteenFPlanner({
    filerByCik: index.filerByCik,
    filerByName: index.nameIndex,
    issuerByCusip: index.issuerByCusip,
    issuerByName: index.nameIndex,
  });

  const skippedByType: Record<string, number> = {};
  let total = 0;
  let selected = 0;
  let submissionCols: ReturnType<typeof submissionColumns> | null = null;
  for await (const line of readThirteenFTsv(cached.zipPath, "SUBMISSION.tsv")) {
    if (!submissionCols) {
      submissionCols = submissionColumns(line);
      continue;
    }
    total += 1;
    const cells = line.split("\t");
    const type = (cells[submissionCols.submissionType] ?? "").trim().toUpperCase();
    if (type !== "13F-HR") {
      skippedByType[type] = (skippedByType[type] ?? 0) + 1;
      continue;
    }
    if (options.limit && selected >= options.limit) continue;
    const accession = cells[submissionCols.accession] ?? "";
    planner.addFiling({
      accession,
      cik: cells[submissionCols.cik] ?? "",
      period: cells[submissionCols.period] ?? "",
      filingDate: cells[submissionCols.filingDate] ?? "",
      managerName: managerNames.get(accession) ?? "",
    });
    selected += 1;
  }

  let infoCols: ReturnType<typeof infoTableColumns> | null = null;
  for await (const line of readThirteenFTsv(cached.zipPath, "INFOTABLE.tsv")) {
    if (!infoCols) {
      infoCols = infoTableColumns(line);
      continue;
    }
    const cells = line.split("\t");
    const accession = cells[infoCols.accession] ?? "";
    if (!planner.hasFiling(accession)) continue;
    planner.addHolding({
      accession,
      issuerName: cells[infoCols.issuerName] ?? "",
      cusip: cells[infoCols.cusip] ?? "",
      value: parseThirteenFNumber(cells[infoCols.value]),
      shares: parseThirteenFNumber(cells[infoCols.shares]),
      shareType: cells[infoCols.shareType] ?? "",
      putCall: cells[infoCols.putCall] ?? "",
    });
  }

  const plan = planner.finish();
  const write = await upsertOwnershipRelations(db, plan.edges, {
    dryRun: !options.apply,
  });
  const report: UsOwnershipReport = {
    market: "US",
    apply: Boolean(options.apply),
    dataset: {
      name: cached.name,
      url: cached.url,
      sha256: cached.sha256,
      bytes: cached.bytes,
      downloaded: cached.downloaded,
    },
    submissions: { total, selected, skippedByType },
    planner: plan.stats,
    edges: plan.edges.length,
    write,
  };
  if (options.apply) await recordRun(db, "US", cached.name, report);
  return report;
}

async function syncHk(
  db: Db,
  companies: EntityCompany[],
  index: CompanyIndex,
  options: OwnershipSyncOptions,
): Promise<HkOwnershipReport> {
  const client = new DionClient(config.financeAnalystUrl);
  const days = options.days ?? 365;
  const maxPages = options.maxPages ?? 10;
  const targets = companies
    .filter(
      (company) =>
        company.coverageTier !== "stub" &&
        company.securities.some(
          (security) => security.exchange.toUpperCase() === "HKEX",
        ),
    )
    .sort((left, right) => left.slug.localeCompare(right.slug));
  const selected = options.limit ? targets.slice(0, options.limit) : targets;
  const edges: OwnershipEdgeDraft[] = [];
  const unmatched = new Set<string>();
  const ambiguous = new Set<string>();
  const failures: HkOwnershipReport["failures"] = [];
  const truncatedCompanies: string[] = [];
  let notices = 0;
  let noticesWithLongPosition = 0;
  let latestEventDate: string | null = null;

  for (let position = 0; position < selected.length; position += 1) {
    const company = selected[position]!;
    const security = company.securities.find(
      (candidate) => candidate.exchange.toUpperCase() === "HKEX",
    )!;
    const code = security.ticker.replace(/\D/g, "").padStart(5, "0");
    try {
      const response = await client.notices(code, { days, maxPages });
      if (response.truncated) truncatedCompanies.push(company.slug);
      for (const error of response.errors ?? []) {
        failures.push({ company: company.slug, code, error });
      }
      const plan = planDionOwnership({
        issuerCompanyId: company.id,
        issuerCode: code,
        issuerName: company.displayName,
        notices: (response.notices ?? []) as DionNotice[],
        holderByName: index.nameIndex,
      });
      edges.push(...plan.edges);
      notices += plan.stats.notices;
      noticesWithLongPosition += plan.stats.noticesWithLongPosition;
      for (const name of plan.stats.unmatchedHolderNames) unmatched.add(name);
      for (const name of plan.stats.ambiguousHolderNames) ambiguous.add(name);
      if (
        plan.stats.latestEventDate &&
        (!latestEventDate || plan.stats.latestEventDate > latestEventDate)
      ) {
        latestEventDate = plan.stats.latestEventDate;
      }
    } catch (error) {
      const message = messageOf(error);
      if (message.includes("sidecar is unavailable")) throw error;
      failures.push({ company: company.slug, code, error: message });
    }
    if ((position + 1) % 10 === 0) {
      console.error(
        `ownership HK: ${position + 1}/${selected.length} companies, ${edges.length} edges`,
      );
    }
  }

  const deduped = dedupeEdges(edges);
  const write = await upsertOwnershipRelations(db, deduped, {
    dryRun: !options.apply,
  });
  const report: HkOwnershipReport = {
    market: "HK",
    apply: Boolean(options.apply),
    days,
    companies: selected.length,
    notices,
    noticesWithLongPosition,
    matchedHolderCompanies: new Set(deduped.map((edge) => edge.srcCompanyId)).size,
    unmatchedHolderNames: [...unmatched].sort(),
    ambiguousHolderNames: [...ambiguous].sort(),
    edges: deduped.length,
    latestEventDate,
    truncatedCompanies,
    failures,
    write,
  };
  if (options.apply) await recordRun(db, "HK", null, report);
  return report;
}

async function readCoverPageNames(zipPath: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  let columns: ReturnType<typeof coverPageColumns> | null = null;
  for await (const line of readThirteenFTsv(zipPath, "COVERPAGE.tsv")) {
    if (!columns) {
      columns = coverPageColumns(line);
      continue;
    }
    const cells = line.split("\t");
    const accession = cells[columns.accession];
    if (!accession || names.has(accession)) continue;
    names.set(accession, cells[columns.managerName] ?? "");
  }
  return names;
}

function dedupeEdges(edges: OwnershipEdgeDraft[]): OwnershipEdgeDraft[] {
  const byKey = new Map<string, OwnershipEdgeDraft>();
  for (const edge of edges) {
    const key = `${edge.srcCompanyId}\0${edge.dstCompanyId}\0${edge.type}`;
    const previous = byKey.get(key);
    if (!previous || (edge.validFrom ?? "") > (previous.validFrom ?? "")) {
      byKey.set(key, edge);
    }
  }
  return [...byKey.values()];
}

async function recordRun(
  db: Db,
  market: "US" | "HK",
  dataset: string | null,
  stats: unknown,
): Promise<void> {
  await db.insert(ownershipSyncRuns).values({
    id: newId(),
    market,
    dataset,
    applied: true,
    stats: stats as Record<string, unknown>,
  });
}

function normalizeCik(value: string): string {
  return value.trim().replace(/\D/g, "").padStart(10, "0");
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

// ---------------------------------------------------------------------------
// coverage
// ---------------------------------------------------------------------------

export interface OwnershipCoverageSide {
  companies: number;
  relations: number;
  holders: number;
  issuers: number;
  pendingReviews: number;
  latestPeriod: string | null;
  lastRun: {
    ranAt: string;
    dataset: string | null;
    stats: Record<string, unknown>;
  } | null;
}

export interface OwnershipCoverageReport {
  us: OwnershipCoverageSide & { cusipCompanies: number; cusipIds: number };
  hk: OwnershipCoverageSide;
}

export async function ownershipCoverage(): Promise<OwnershipCoverageReport> {
  const { db, pool } = createDb(config.databaseUrl);
  try {
    const companies = await listEntityCompanies(db);
    const usCompanies = companies.filter((company) => company.country === "US");
    const usWithCusip = usCompanies.filter((company) =>
      company.identifiers.some((identifier) => identifier.idType === "cusip"),
    );
    const cusipIds = usCompanies.reduce(
      (total, company) =>
        total +
        company.identifiers.filter(
          (identifier) => identifier.idType === "cusip",
        ).length,
      0,
    );
    const hkCompanies = companies.filter(
      (company) =>
        company.coverageTier !== "stub" &&
        company.securities.some(
          (security) => security.exchange.toUpperCase() === "HKEX",
        ),
    );
    const stats = await relationStats(db);
    const runs = await latestRuns(db);
    const us = stats.get(THIRTEEN_F_VERSION);
    const hk = stats.get(HKEX_DION_VERSION);
    return {
      us: {
        companies: usCompanies.length,
        cusipCompanies: usWithCusip.length,
        cusipIds,
        relations: us?.count ?? 0,
        holders: us?.holders ?? 0,
        issuers: us?.issuers ?? 0,
        pendingReviews: us?.pending ?? 0,
        latestPeriod: us?.latest ?? null,
        lastRun: runs.get("US") ?? null,
      },
      hk: {
        companies: hkCompanies.length,
        relations: hk?.count ?? 0,
        holders: hk?.holders ?? 0,
        issuers: hk?.issuers ?? 0,
        pendingReviews: hk?.pending ?? 0,
        latestPeriod: hk?.latest ?? null,
        lastRun: runs.get("HK") ?? null,
      },
    };
  } finally {
    await pool.end();
  }
}

interface VersionStats {
  count: number;
  holders: number;
  issuers: number;
  latest: string | null;
  pending: number;
}

async function relationStats(
  db: Db,
): Promise<Map<string, VersionStats>> {
  const versions = [THIRTEEN_F_VERSION, HKEX_DION_VERSION];
  const rows = await db
    .select({
      version: relations.extractorVersion,
      count: sql<number>`count(*)::int`,
      holders: sql<number>`count(distinct ${relations.srcCompanyId})::int`,
      issuers: sql<number>`count(distinct ${relations.dstCompanyId})::int`,
      latest: sql<string | null>`max(${relations.validFrom})::text`,
    })
    .from(relations)
    .where(inArray(relations.extractorVersion, versions))
    .groupBy(relations.extractorVersion);
  const pendingRows = await db
    .select({
      version: relations.extractorVersion,
      pending: sql<number>`count(*)::int`,
    })
    .from(relations)
    .innerJoin(reviewQueue, eq(relations.reviewId, reviewQueue.id))
    .where(
      and(
        inArray(relations.extractorVersion, versions),
        eq(reviewQueue.status, "pending"),
      ),
    )
    .groupBy(relations.extractorVersion);
  const pending = new Map(
    pendingRows.map((row) => [row.version ?? "", row.pending]),
  );
  const out = new Map<string, VersionStats>();
  for (const row of rows) {
    if (!row.version) continue;
    out.set(row.version, {
      count: row.count,
      holders: row.holders,
      issuers: row.issuers,
      latest: row.latest,
      pending: pending.get(row.version) ?? 0,
    });
  }
  return out;
}

async function latestRuns(
  db: Db,
): Promise<
  Map<
    string,
    { ranAt: string; dataset: string | null; stats: Record<string, unknown> }
  >
> {
  const out = new Map<
    string,
    { ranAt: string; dataset: string | null; stats: Record<string, unknown> }
  >();
  for (const market of ["US", "HK"]) {
    const [row] = await db
      .select()
      .from(ownershipSyncRuns)
      .where(eq(ownershipSyncRuns.market, market))
      .orderBy(desc(ownershipSyncRuns.ranAt))
      .limit(1);
    if (!row) continue;
    out.set(market, {
      ranAt: row.ranAt.toISOString(),
      dataset: row.dataset,
      stats: row.stats,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// command dispatch
// ---------------------------------------------------------------------------

export async function ownershipCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  const rest = args.slice(1);
  if (subcommand === "sync") {
    const { values } = parseArgs({
      args: rest,
      options: {
        market: { type: "string", default: "all" },
        apply: { type: "boolean" },
        limit: { type: "string" },
        days: { type: "string", default: "365" },
        "max-pages": { type: "string", default: "10" },
        dataset: { type: "string" },
        refresh: { type: "boolean" },
        json: { type: "boolean" },
      },
    });
    const market = parseMarket(values.market);
    const report = await ownershipSync({
      market,
      apply: Boolean(values.apply),
      limit: parsePositive(values.limit),
      days: parsePositive(values.days) ?? 365,
      maxPages: parsePositive(values["max-pages"]) ?? 10,
      dataset: values.dataset,
      refresh: Boolean(values.refresh),
    });
    if (values.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    printSync(report);
    return;
  }

  if (subcommand === "coverage") {
    const { values } = parseArgs({
      args: rest,
      options: { json: { type: "boolean" } },
    });
    const report = await ownershipCoverage();
    if (values.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    printCoverage(report);
    return;
  }

  throw new Error(
    "usage: occ ownership sync|coverage [--market US|HK|all] [--apply] [--json]",
  );
}

function parseMarket(value: string | undefined): OwnershipMarket {
  const market = (value ?? "all").trim().toUpperCase();
  if (market === "US" || market === "HK" || market === "ALL") return market;
  throw new Error(`unknown market ${value}; use US, HK or all`);
}

function parsePositive(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function printSync(report: OwnershipSyncReport): void {
  const apply = report.us?.apply ?? report.hk?.apply ?? false;
  console.log(`ownership sync${apply ? "" : " (dry run)"}`);
  if (report.us) {
    const us = report.us;
    console.log(
      `US · ${us.dataset.name}${us.dataset.downloaded ? " (downloaded)" : " (cached)"} · ` +
        `${us.submissions.selected}/${us.submissions.total} 13F-HR selected`,
    );
    console.log(
      `  filers: ${us.planner.filingsMatched}/${us.planner.filings} filings matched ` +
        `(${us.planner.holdersMatchedByCik} by CIK, ${us.planner.holdersMatchedByName} by name) · ` +
        `${us.planner.filingsUnmatched} filings unmatched (${us.planner.filersUnmatched} distinct filers) · ${us.planner.ambiguousFilers} ambiguous`,
    );
    console.log(
      `  issuers: ${us.planner.issuers} matched (${us.planner.issuerNameMatchedCompanies} by name) · ` +
        `${us.planner.unmatchedIssuerCusips} unmatched CUSIPs · ${us.planner.issuerNameMatches} name-matched rows · ${us.planner.ambiguousIssuerNames} ambiguous`,
    );
    console.log(
      `  rows: ${us.planner.holdingsRows} in selected filings · ${us.planner.optionRows} options · ${us.planner.nonShareRows} non-share · ${us.planner.selfRows} self`,
    );
    console.log(`  edges: ${us.edges}`);
    if (us.write) printWrite(us.write);
  }
  if (report.hk) {
    const hk = report.hk;
    console.log(
      `HK · ${hk.companies} companies · ${hk.notices} notices · ${hk.noticesWithLongPosition} long-position notices · ${hk.latestEventDate ?? "no dated notice"}`,
    );
    console.log(
      `  holders: ${hk.matchedHolderCompanies} matched companies · ${hk.unmatchedHolderNames.length} out-of-universe · ${hk.ambiguousHolderNames.length} ambiguous`,
    );
    console.log(`  edges: ${hk.edges}`);
    if (hk.truncatedCompanies.length > 0) {
      console.log(
        `  truncated: ${hk.truncatedCompanies.length} companies exceeded --max-pages ` +
          `(${hk.truncatedCompanies.slice(0, 8).join(", ")}${hk.truncatedCompanies.length > 8 ? ", …" : ""})`,
      );
    }
    if (hk.write) printWrite(hk.write);
    if (hk.unmatchedHolderNames.length > 0) {
      console.log(
        `  out-of-universe holders: ${hk.unmatchedHolderNames.slice(0, 12).join(", ")}` +
          (hk.unmatchedHolderNames.length > 12 ? ", …" : ""),
      );
    }
    for (const failure of hk.failures.slice(0, 10)) {
      console.log(`  failure ${failure.company} (${failure.code}): ${failure.error}`);
    }
    if (hk.failures.length > 10) {
      console.log(`  … ${hk.failures.length - 10} more failures`);
    }
  }
}

function printWrite(write: OwnershipWriteResult): void {
  console.log(
    `  write: +${write.inserted} inserted · ~${write.updated} updated · ${write.duplicates} duplicate-source · ` +
      `evidence +${write.evidenceInserted} · reviews +${write.reviewsInserted} · sources +${write.sourcesInserted}`,
  );
}

function printCoverage(report: OwnershipCoverageReport): void {
  const us = report.us;
  console.log(
    `ownership coverage · US: ${us.cusipCompanies}/${us.companies} companies with CUSIP (${us.cusipIds} ids)`,
  );
  console.log(
    `  13F edges ${us.relations} · ${us.holders} holders · ${us.issuers} issuers · ` +
      `${us.pendingReviews} pending reviews · latest ${us.latestPeriod ?? "—"}`,
  );
  if (us.lastRun) {
    const stats = us.lastRun.stats as {
      planner?: {
        filingsMatched?: number;
        filersUnmatched?: number;
        issuers?: number;
        unmatchedIssuerCusips?: number;
      };
    };
    const planner = stats.planner;
    console.log(
      `  last US run ${us.lastRun.ranAt.slice(0, 10)} · ${us.lastRun.dataset ?? ""}` +
        (planner
          ? ` · ${planner.filingsMatched ?? 0} filers matched / ${planner.filersUnmatched ?? 0} out-of-universe` +
            ` · ${planner.issuers ?? 0} issuers matched / ${planner.unmatchedIssuerCusips ?? 0} out-of-universe CUSIPs`
          : ""),
    );
  }
  const hk = report.hk;
  console.log(
    `  HK: ${hk.companies} researched companies · DION edges ${hk.relations} · ` +
      `${hk.holders} holders · ${hk.issuers} issuers · ${hk.pendingReviews} pending reviews · latest ${hk.latestPeriod ?? "—"}`,
  );
  if (hk.lastRun) {
    const stats = hk.lastRun.stats as {
      unmatchedHolderNames?: unknown[];
      ambiguousHolderNames?: unknown[];
    };
    console.log(
      `  last HK run ${hk.lastRun.ranAt.slice(0, 10)} · ` +
        `${stats.unmatchedHolderNames?.length ?? 0} out-of-universe holders · ` +
        `${stats.ambiguousHolderNames?.length ?? 0} ambiguous`,
    );
  }
}

export { USAGE_OPTIONS };

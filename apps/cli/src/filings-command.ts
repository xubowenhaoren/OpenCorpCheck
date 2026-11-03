import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  createDb,
  listEntityCompanies,
  resolveCompanyId,
  type Db,
  type EntityCompany,
} from "@occ/db";
import {
  createIngestContext,
  filingCoverage,
  ingestFilings,
  type FilingContent,
  type LoadFilingContent,
} from "@occ/ingest";
import {
  extractPdfPages,
  fetchCninfoFilings,
  fetchEdgarFilings,
  fetchGdeltArticles,
  fetchHkexNewsFilings,
  fetchIrFeed,
  fetchPdfBytes,
  sha256Text,
  type FilingItem,
  type FilingSource,
} from "@occ/sources-filings";
import { parse as parseYaml } from "yaml";

import { config } from "./config.js";

/**
 * `occ filings sync|coverage` — official filing discovery + ingestion (P1.4).
 *
 * Discovery is deterministic and LLM-free. `--apply` fetches the filing PDF,
 * extracts text/tables through the finance sidecar, writes `documents`/`chunks`
 * and indexes them in Qdrant. Without `--apply` this is a polite dry run: only
 * the announcement index is fetched.
 */

const USAGE_OPTIONS = `
Filings options:
  --market A|HK|US|all   Market to sync (default: all)
  --company <ref>        Only this ticker/slug/name
  --apply                Fetch PDFs and write documents/chunks (default: dry run)
  --limit <n>            Max companies
  --days <n>             Lookback window in days (default: 180)
  --max-items <n>        Max filings per company (default: 10)
  --include-stubs        Also poll A500/SPX placeholder rows (default: no)
  --sources <list>       official (default) | all | comma list:
                         edgar,cninfo,hkexnews,ir-rss,gdelt
  --skip-pdf             Store link-only documents (no PDF fetch/extraction)
  --full-text            Also extract EDGAR HTML primary documents
  --max-pages <n>        PDF page cap per filing (default: 80)
  --refresh              Ignore cached EDGAR JSON / PDFs / extraction JSON
  --skip-index           Write Postgres only; do not touch Qdrant
  --delay-ms <n>         Pause between companies (default: 400)
  --ir-feeds <path>      IR feed registry (default: config/ir-feeds.yaml)
  --json                 Machine-readable report
`;

export type FilingsMarket = "A" | "HK" | "US" | "ALL";

export interface FilingsSyncOptions {
  market?: FilingsMarket;
  company?: string;
  apply?: boolean;
  limit?: number;
  days?: number;
  maxItems?: number;
  sources?: string;
  includeStubs?: boolean;
  skipPdf?: boolean;
  fullText?: boolean;
  maxPages?: number;
  refresh?: boolean;
  skipIndex?: boolean;
  delayMs?: number;
  irFeedsFile?: string;
}

interface Discovered {
  items: FilingItem[];
  total: number;
  errors: string[];
}

interface CompanyResult {
  company: string;
  name: string;
  markets: Array<{
    market: "A" | "HK" | "US";
    sources: string[];
    discovered: number;
    total: number;
    inserted: number;
    updated: number;
    skipped: number;
    failed: number;
    linkOnly: number;
    chunks: number;
    indexedChunks: number;
    items: FilingItem[];
    errors: string[];
  }>;
}

export interface FilingsSyncReport {
  apply: boolean;
  days: number;
  market: FilingsMarket;
  companies: number;
  discovered: number;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  linkOnly: number;
  chunks: number;
  indexedChunks: number;
  results: CompanyResult[];
  errors: string[];
}

const OFFICIAL_SOURCES: FilingSource[] = ["edgar", "cninfo", "hkexnews"];
const ALL_SOURCES: FilingSource[] = [...OFFICIAL_SOURCES, "ir-rss", "gdelt"];

export async function filingsSync(
  options: FilingsSyncOptions = {},
): Promise<FilingsSyncReport> {
  const apply = Boolean(options.apply);
  const market = options.market ?? "ALL";
  const days = options.days ?? 180;
  const maxItems = options.maxItems ?? 10;
  const sources = parseSources(options.sources);
  const { db, pool } = createDb(config.databaseUrl);
  let close: (() => Promise<void>) | undefined;
  try {
    const all = await listEntityCompanies(db);
    let companies = all.filter(
      (company) => options.includeStubs || company.coverageTier !== "stub",
    );
    if (options.company) {
      const resolved = await resolveCompanyId(db, options.company);
      if (!resolved) throw new Error(`company not found: ${options.company}`);
      companies = companies.filter((company) => company.id === resolved);
      if (companies.length === 0) {
        throw new Error(
          `company ${options.company} is a fixture or a stub; pass --include-stubs to poll stubs`,
        );
      }
    }
    companies = companies
      .filter((company) =>
        marketsOf(company).some(
          (value) => market === "ALL" || market === value,
        ),
      )
      .sort((left, right) => left.slug.localeCompare(right.slug));
    const selected = options.limit
      ? companies.slice(0, Math.max(0, options.limit))
      : companies;
    const irFeeds = loadIrFeeds(
      path.resolve(options.irFeedsFile ?? config.irFeedsFile),
    );
    const report: FilingsSyncReport = {
      apply,
      days,
      market,
      companies: selected.length,
      discovered: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      linkOnly: 0,
      chunks: 0,
      indexedChunks: 0,
      results: [],
      errors: [],
    };
    let ctx: Awaited<ReturnType<typeof createIngestContext>>["ctx"] | undefined;
    if (apply) {
      const context = await createIngestContext({
        databaseUrl: config.databaseUrl,
        qdrantUrl: config.qdrantUrl,
        qdrantApiKey: config.qdrantApiKey,
        embeddingUrl: config.embeddingUrl,
        embeddingModel: config.embeddingModel,
        embeddingDim: config.embeddingDim,
        embeddingVersion: config.embeddingVersion,
        embeddingTimeoutMs: config.embeddingTimeoutMs,
        collections: config.collections,
        skipIndex: Boolean(options.skipIndex),
      });
      ctx = context.ctx;
      close = context.close;
    }

    const loadContent = createContentLoader(options);

    for (let index = 0; index < selected.length; index += 1) {
      const company = selected[index]!;
      const markets = marketsOf(company).filter(
        (value) => market === "ALL" || market === value,
      );
      const result: CompanyResult = {
        company: company.slug,
        name: company.displayName,
        markets: [],
      };
      for (const companyMarket of markets) {
        const discovered = await discoverForMarket(
          db,
          company,
          companyMarket,
          { days, maxItems, sources, refresh: Boolean(options.refresh) },
          irFeeds,
        );
        report.discovered += discovered.items.length;
        const entry: CompanyResult["markets"][number] = {
          market: companyMarket,
          sources: [...new Set(discovered.items.map((item) => item.source))],
          discovered: discovered.items.length,
          total: discovered.total,
          inserted: 0,
          updated: 0,
          skipped: 0,
          failed: 0,
          linkOnly: 0,
          chunks: 0,
          indexedChunks: 0,
          items: discovered.items,
          errors: discovered.errors,
        };
        if (apply && ctx && discovered.items.length > 0) {
          const ingested = await ingestFilings(ctx, {
            companyId: company.id,
            companyName: company.displayName,
            market: companyMarket,
            items: discovered.items,
            loadContent,
            skipContent: Boolean(options.skipPdf),
            allowHtmlContent: Boolean(options.fullText),
            force: Boolean(options.refresh),
            maxItems,
          });
          entry.inserted = ingested.inserted;
          entry.updated = ingested.updated;
          entry.skipped = ingested.skipped;
          entry.failed = ingested.failed;
          entry.linkOnly = ingested.linkOnly;
          entry.chunks = ingested.chunks;
          entry.indexedChunks = ingested.indexedChunks;
          for (const document of ingested.documents) {
            if (document.status === "failed" && document.error) {
              entry.errors.push(`${document.externalId}: ${document.error}`);
            }
          }
          report.inserted += ingested.inserted;
          report.updated += ingested.updated;
          report.skipped += ingested.skipped;
          report.failed += ingested.failed;
          report.linkOnly += ingested.linkOnly;
          report.chunks += ingested.chunks;
          report.indexedChunks += ingested.indexedChunks;
        }
        report.errors.push(
          ...entry.errors.map(
            (error) => `${company.slug} ${companyMarket}: ${error}`,
          ),
        );
        result.markets.push(entry);
      }
      if (result.markets.length > 0) report.results.push(result);
      const pause = options.delayMs ?? 400;
      if (pause > 0 && index < selected.length - 1) await sleep(pause);
    }
    return report;
  } finally {
    if (close) await close();
    await pool.end();
  }
}

export async function filingsCoverageCommand(): Promise<
  Awaited<ReturnType<typeof filingCoverage>>
> {
  const { db, pool } = createDb(config.databaseUrl);
  try {
    return await filingCoverage(db, { limit: 200 });
  } finally {
    await pool.end();
  }
}

function marketsOf(company: EntityCompany): Array<"A" | "HK" | "US"> {
  const exchanges = new Set(
    company.securities.map((security) => security.exchange.toUpperCase()),
  );
  const out: Array<"A" | "HK" | "US"> = [];
  if (exchanges.has("SSE") || exchanges.has("SZSE")) out.push("A");
  if (exchanges.has("HKEX")) out.push("HK");
  if (
    exchanges.has("NYSE") ||
    exchanges.has("NASDAQ") ||
    exchanges.has("CBOE") ||
    exchanges.has("AMEX")
  ) {
    out.push("US");
  }
  return out;
}

function tickerFor(company: EntityCompany, market: "A" | "HK" | "US"): string | null {
  const exchanges =
    market === "A"
      ? ["SSE", "SZSE"]
      : market === "HK"
        ? ["HKEX"]
        : ["NYSE", "NASDAQ", "CBOE", "AMEX"];
  const security = company.securities.find((candidate) =>
    exchanges.includes(candidate.exchange.toUpperCase()),
  );
  return security?.ticker ?? null;
}

async function discoverForMarket(
  db: Db,
  company: EntityCompany,
  market: "A" | "HK" | "US",
  options: {
    days: number;
    maxItems: number;
    sources: Set<FilingSource>;
    refresh: boolean;
  },
  irFeeds: Map<string, IrFeed>,
): Promise<Discovered> {
  const items: FilingItem[] = [];
  const errors: string[] = [];
  let total = 0;
  const ticker = tickerFor(company, market);
  if (!ticker) {
    return { items, total, errors: [`no ${market} security for ${company.slug}`] };
  }
  const from = new Date(Date.now() - options.days * 86_400_000);
  const to = new Date();

  if (market === "US" && options.sources.has("edgar")) {
    const cik = company.identifiers.find((identifier) => identifier.idType === "cik")
      ?.idValue;
    if (!cik) {
      errors.push(`no SEC CIK identifier for ${company.slug}`);
    } else {
      try {
        const result = await fetchEdgarFilings(cik, {
          edgarDir: config.edgarDir,
          since: from,
          limit: options.maxItems,
          force: options.refresh,
          userAgent: config.edgarUserAgent,
        });
        items.push(...result.items);
        total += result.items.length;
      } catch (error) {
        errors.push(`edgar: ${messageOf(error)}`);
      }
    }
  }

  if (market === "A" && options.sources.has("cninfo")) {
    try {
      const result = await fetchCninfoFilings({
        code: ticker.replace(/\D/g, ""),
        from,
        to,
        maxItems: options.maxItems,
        userAgent: config.edgarUserAgent,
      });
      items.push(...result.items);
      total += result.total;
    } catch (error) {
      errors.push(`cninfo: ${messageOf(error)}`);
    }
  }

  if (market === "HK" && options.sources.has("hkexnews")) {
    try {
      const result = await fetchHkexNewsFilings({
        code: ticker.replace(/\D/g, "").padStart(5, "0"),
        days: options.days,
        maxItems: options.maxItems,
        sidecarUrl: config.financeAnalystUrl,
      });
      items.push(...result.items);
      total += result.total;
      errors.push(...result.errors.map((error) => `hkexnews: ${error}`));
    } catch (error) {
      errors.push(`hkexnews: ${messageOf(error)}`);
    }
  }

  if (options.sources.has("ir-rss")) {
    const feed = irFeeds.get(ticker.toUpperCase());
    if (feed) {
      try {
        const feedItems = await fetchIrFeed(feed.url, {
          market,
          sourceName: feed.sourceName,
          language: feed.language,
          limit: options.maxItems,
          sinceDays: options.days,
        });
        items.push(...feedItems);
        total += feedItems.length;
      } catch (error) {
        errors.push(`ir-rss: ${messageOf(error)}`);
      }
    }
  }

  if (options.sources.has("gdelt")) {
    const query = englishName(company) ?? company.displayName;
    try {
      const articles = await fetchGdeltArticles({
        query: `"${query}"`,
        market,
        from,
        to,
        maxRecords: options.maxItems,
      });
      items.push(...articles);
      total += articles.length;
    } catch (error) {
      errors.push(`gdelt: ${messageOf(error)}`);
    }
  }

  // Dedupe within one company/market by source + external id.
  const seen = new Set<string>();
  const deduped = items.filter((item) => {
    const key = `${item.source}|${item.externalId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Newest first, then cap. Different sources can otherwise starve a source.
  deduped.sort((left, right) =>
    (right.publishedAt ?? "").localeCompare(left.publishedAt ?? ""),
  );
  return {
    items: deduped.slice(0, options.maxItems),
    total,
    errors,
  };
}

function createContentLoader(options: FilingsSyncOptions): LoadFilingContent {
  return async (item: FilingItem): Promise<FilingContent | null> => {
    if (options.skipPdf) return null;
    const key = sha256Text(
      `${item.source}|${item.externalId}|${item.url}`,
    ).slice(0, 32);
    const dir = path.join(config.filingsDir, item.source);
    const pdfPath = path.join(dir, `${key}.pdf`);
    const extractionPath = path.join(dir, `${key}.json`);
    try {
      if (item.pdfUrl) {
        if (!options.refresh && fs.existsSync(extractionPath)) {
          try {
            const cached = JSON.parse(
              fs.readFileSync(extractionPath, "utf8"),
            ) as FilingContent & { rawSha256?: string };
            if (cached.pages?.length) return cached;
          } catch {
            // A corrupt extraction cache is ignored and rebuilt below.
          }
        }
        let bytes: Buffer;
        if (!options.refresh && fs.existsSync(pdfPath)) {
          bytes = fs.readFileSync(pdfPath);
        } else {
          const fetched = await fetchPdfBytes(item.pdfUrl, {
            userAgent: config.edgarUserAgent,
          });
          bytes = fetched.bytes;
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(pdfPath, bytes);
        }
        const extracted = await extractPdfPages(bytes, {
          sidecarUrl: config.financeAnalystUrl,
          maxPages: options.maxPages ?? 80,
        });
        const content: FilingContent = {
          pages: extracted.pages,
          mime: "application/pdf",
          rawSha256: createHash("sha256").update(bytes).digest("hex"),
          warnings: extracted.warnings,
          truncated: extracted.truncated,
        };
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          extractionPath,
          `${JSON.stringify({ ...content, pageCount: extracted.pageCount })}\n`,
          "utf8",
        );
        return content;
      }
      if (options.fullText && item.source === "edgar") {
        const response = await fetch(item.url, {
          headers: { "user-agent": config.edgarUserAgent },
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) return null;
        const html = await response.text();
        const text = htmlToText(html).slice(0, 300_000);
        if (!text.trim()) return null;
        return {
          pages: [{ page: 1, text }],
          mime: "text/html",
          rawSha256: sha256Text(html),
          warnings: text.length >= 300_000 ? ["HTML text truncated to 300k chars"] : [],
        };
      }
      return null;
    } catch (error) {
      // Let ingest keep the announcement as link-only; surface why.
      throw new Error(`${item.source} content: ${messageOf(error)}`);
    }
  };
}

interface IrFeed {
  url: string;
  sourceName?: string;
  language?: "zh" | "en";
}

function loadIrFeeds(file: string): Map<string, IrFeed> {
  const map = new Map<string, IrFeed>();
  if (!fs.existsSync(file)) return map;
  const parsed = parseYaml(fs.readFileSync(file, "utf8")) as {
    feeds?: Record<
      string,
      { url?: string; source_name?: string; sourceName?: string; language?: string }
    >;
  } | null;
  for (const [ticker, value] of Object.entries(parsed?.feeds ?? {})) {
    if (!value?.url) continue;
    map.set(ticker.trim().toUpperCase(), {
      url: value.url,
      sourceName: value.sourceName ?? value.source_name,
      language: value.language === "zh" ? "zh" : value.language === "en" ? "en" : undefined,
    });
  }
  return map;
}

function parseSources(value: string | undefined): Set<FilingSource> {
  if (!value || value.trim() === "official") {
    return new Set(OFFICIAL_SOURCES);
  }
  if (value.trim() === "all") return new Set(ALL_SOURCES);
  const allowed = new Set(ALL_SOURCES);
  const out = new Set<FilingSource>();
  for (const part of value.split(",")) {
    const source = part.trim() as FilingSource;
    if (!allowed.has(source)) {
      throw new Error(`unknown source ${part}; use ${[...allowed].join(", ")}`);
    }
    out.add(source);
  }
  return out;
}

function englishName(company: EntityCompany): string | null {
  for (const key of ["englishName", "companyName"]) {
    const value = company.profile[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// command dispatch
// ---------------------------------------------------------------------------

export async function filingsCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  const rest = args.slice(1);
  if (subcommand === "sync") {
    const { values } = parseArgs({
      args: rest,
      options: {
        market: { type: "string", default: "all" },
        company: { type: "string" },
        apply: { type: "boolean" },
        limit: { type: "string" },
        days: { type: "string", default: "180" },
        "max-items": { type: "string", default: "10" },
        "include-stubs": { type: "boolean" },
        sources: { type: "string" },
        "skip-pdf": { type: "boolean" },
        "full-text": { type: "boolean" },
        "max-pages": { type: "string", default: "80" },
        refresh: { type: "boolean" },
        "skip-index": { type: "boolean" },
        "delay-ms": { type: "string", default: "400" },
        "ir-feeds": { type: "string" },
        json: { type: "boolean" },
      },
    });
    const report = await filingsSync({
      market: parseMarket(values.market),
      company: values.company,
      apply: Boolean(values.apply),
      limit: parsePositive(values.limit),
      days: parsePositive(values.days) ?? 180,
      maxItems: Math.min(parsePositive(values["max-items"]) ?? 10, 200),
      sources: values.sources,
      includeStubs: Boolean(values["include-stubs"]),
      skipPdf: Boolean(values["skip-pdf"]),
      fullText: Boolean(values["full-text"]),
      maxPages: Math.min(parsePositive(values["max-pages"]) ?? 80, 200),
      refresh: Boolean(values.refresh),
      skipIndex: Boolean(values["skip-index"]),
      delayMs: parseNonNegative(values["delay-ms"]) ?? 400,
      irFeedsFile: values["ir-feeds"],
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
    const rows = await filingsCoverageCommand();
    if (values.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    printCoverage(rows);
    return;
  }

  throw new Error(
    "usage: occ filings sync|coverage [--market A|HK|US|all] [--apply] [--json]",
  );
}

function parseMarket(value: string | undefined): FilingsMarket {
  const market = (value ?? "all").trim().toUpperCase();
  if (market === "A" || market === "HK" || market === "US" || market === "ALL") {
    return market;
  }
  throw new Error(`unknown market ${value}; use A, HK, US or all`);
}

function parsePositive(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegative(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function printSync(report: FilingsSyncReport): void {
  console.log(
    `filings sync${report.apply ? "" : " (dry run)"} · ${report.market} · ` +
      `${report.companies} companies · ${report.days} days`,
  );
  if (report.apply) {
    console.log(
      `  total: ${report.discovered} discovered · +${report.inserted} inserted · ` +
        `~${report.updated} updated · ${report.skipped} skipped · ${report.failed} failed · ` +
        `${report.linkOnly} link-only · ${report.chunks} chunks (${report.indexedChunks} indexed)`,
    );
  } else {
    console.log(`  total: ${report.discovered} discovered`);
  }
  for (const result of report.results) {
    for (const entry of result.markets) {
      const counts = report.apply
        ? `+${entry.inserted}/~${entry.updated}/${entry.skipped} skipped/${entry.failed} failed · ${entry.linkOnly} link-only`
        : `${entry.discovered} discovered`;
      console.log(
        `  ${result.company} (${entry.market}): ${counts} · ${entry.total} total reported` +
          (entry.sources.length ? ` · ${entry.sources.join(",")}` : ""),
      );
      for (const item of entry.items.slice(0, 3)) {
        console.log(
          `    - ${item.form ?? item.category ?? item.source} · ${item.publishedAt?.slice(0, 10) ?? "—"} · ${item.title.slice(0, 100)}`,
        );
      }
      for (const error of entry.errors.slice(0, 5)) {
        console.log(`    ! ${error}`);
      }
      if (entry.errors.length > 5) {
        console.log(`    … ${entry.errors.length - 5} more errors`);
      }
    }
  }
}

function printCoverage(
  rows: Awaited<ReturnType<typeof filingCoverage>>,
): void {
  console.log("filings coverage");
  if (rows.length === 0) {
    console.log("  no filing documents yet");
    return;
  }
  let documents = 0;
  let chunks = 0;
  for (const row of rows) {
    documents += row.documents;
    chunks += row.chunks;
    console.log(
      `  ${row.source} (${row.market ?? "—"}): ${row.documents} documents · ` +
        `${row.chunks} chunks · ${row.linkOnly} link-only · latest ${row.latest?.slice(0, 10) ?? "—"}`,
    );
  }
  console.log(`  total: ${documents} documents · ${chunks} chunks`);
}

export { USAGE_OPTIONS };

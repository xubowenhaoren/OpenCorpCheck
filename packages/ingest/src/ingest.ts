import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { newId, slugify, type Market } from "@occ/core";
import {
  aliases,
  chunks,
  companies,
  companyIds,
  createDb,
  documents,
  indexMemberships,
  securities,
  sources,
  type Db,
} from "@occ/db";
import {
  HttpEmbeddingClient,
  QdrantClient,
  ensureCollections,
  indexChunks,
  indexCompanies,
  toPointId,
  type EmbeddingClient,
  type IndexableChunk,
  type IndexableCompany,
  type RetrievalCollections,
} from "@occ/retrieval";
import { and, eq, inArray, sql } from "drizzle-orm";

import {
  buildChunks,
  estimateTokens,
  parseSectionMarkdown,
  type ParsedSection,
} from "./sections.js";
import { pinyinAliasForms, pinyinVariants } from "./pinyin.js";
import {
  countryForMarket,
  currencyForMarket,
  exchangeForMarket,
  tickerIdValue,
  type IngestTarget,
} from "./targets.js";

export interface IngestRuntimeOptions {
  databaseUrl: string;
  qdrantUrl: string;
  qdrantApiKey?: string;
  embeddingUrl: string;
  embeddingModel?: string;
  embeddingDim?: number;
  embeddingVersion?: string;
  embeddingTimeoutMs?: number;
  collections: RetrievalCollections;
  skipIndex?: boolean;
}

export interface IngestContext {
  db: Db;
  pool: ReturnType<typeof createDb>["pool"];
  qdrant: QdrantClient;
  embeddings: EmbeddingClient;
  collections: RetrievalCollections;
  embeddingDim: number;
  embeddingVersion: string;
  skipIndex: boolean;
}

export async function createIngestContext(
  options: IngestRuntimeOptions,
): Promise<{ ctx: IngestContext; close: () => Promise<void> }> {
  const { db, pool } = createDb(options.databaseUrl, 6);
  const ctx: IngestContext = {
    db,
    pool,
    qdrant: new QdrantClient({
      url: options.qdrantUrl,
      apiKey: options.qdrantApiKey,
    }),
    embeddings: new HttpEmbeddingClient({
      baseUrl: options.embeddingUrl,
      model: options.embeddingModel,
      dim: options.embeddingDim,
      version: options.embeddingVersion,
      timeoutMs: options.embeddingTimeoutMs,
    }),
    collections: options.collections,
    embeddingDim: options.embeddingDim ?? 1024,
    embeddingVersion: options.embeddingVersion ?? "bge-m3@1024",
    skipIndex: Boolean(options.skipIndex),
  };
  return {
    ctx,
    close: async () => {
      await pool.end();
    },
  };
}

export interface IngestOptions {
  sectionPath: string;
  target: IngestTarget;
  force?: boolean;
  skipIndex?: boolean;
  model?: string;
  now?: Date;
}

export interface IngestResult {
  key: string;
  ticker: string;
  companyId: string;
  slug: string;
  displayName: string;
  documentId: string;
  sectionTitle: string;
  chunks: number;
  indexedChunks: number;
  companyIndexed: boolean;
  skipped: boolean;
}

export interface IngestBatchItem {
  target: IngestTarget;
  sectionPath: string;
}

export interface IngestFailure {
  key: string;
  ticker: string;
  sectionPath: string;
  error: string;
}

export interface IngestBatchOptions {
  concurrency?: number;
  force?: boolean;
  skipIndex?: boolean;
  model?: string;
  onProgress?: (result: IngestResult) => void;
}

export interface IngestBatchResult {
  total: number;
  processed: number;
  skipped: number;
  failed: IngestFailure[];
  chunks: number;
  indexedChunks: number;
  results: IngestResult[];
}

interface ResolvedCompany {
  id: string;
  slug: string;
  displayName: string;
  legalName: string;
  created: boolean;
}

interface TransactionOutput {
  result: IngestResult;
  companyText: string;
  indexableChunks: IndexableChunk[];
}

/**
 * Ingest one research section:
 *   markdown → company/securities/aliases → source → document → chunks
 *   → Qdrant document points + company point.
 *
 * Idempotent by content hash: rerunning an unchanged section writes nothing and
 * re-embeds nothing. `force` rewrites chunks and re-indexes.
 */
export async function ingestSection(
  ctx: IngestContext,
  options: IngestOptions,
): Promise<IngestResult> {
  const markdown = fs.readFileSync(options.sectionPath, "utf8");
  const sectionHash = sha256Text(markdown);
  const parsed = parseSectionMarkdown(markdown);
  const textChunks = buildChunks(parsed);
  if (textChunks.length === 0) {
    throw new Error(`section has no content: ${options.sectionPath}`);
  }

  const target = options.target;
  const now = options.now ?? new Date();
  const exchange =
    target.exchange ?? exchangeForMarket(target.market, target.code ?? target.ticker);
  const displayName = chooseDisplayName(parsed, target);
  const coverageTier =
    target.coverageTier ?? (target.indexCode ? "index_member" : "discovered");
  const companyText = companyIndexText(parsed);
  const language = detectLanguage(markdown);

  const output = await ctx.db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`occ:ingest:${target.key}`}))`,
    );

    const company = await resolveCompany(tx, {
      target,
      parsed,
      displayName,
      exchange,
      coverageTier,
      now,
    });

    const sourceId = `src_research_${company.slug}`;
    const sourceUrl = `occ://research/${target.market}/${target.ticker}`;
    await tx
      .insert(sources)
      .values({
        id: sourceId,
        url: sourceUrl,
        canonicalUrl: sourceUrl,
        domain: "occ.local",
        title: `${company.displayName} 公司研究 profile`,
        fetchedAt: now,
        httpStatus: 200,
        contentHash: sectionHash,
        trustTier: "research",
        license: "internal-research",
        robotsOk: true,
      })
      .onConflictDoUpdate({
        target: sources.id,
        set: {
          url: sourceUrl,
          canonicalUrl: sourceUrl,
          title: `${company.displayName} 公司研究 profile`,
          fetchedAt: now,
          contentHash: sectionHash,
          trustTier: "research",
        },
      });

    await writeCompanyRelations(tx, {
      companyId: company.id,
      target,
      parsed,
      exchange,
      sourceId,
      now,
    });

    const documentId = `doc_profile_${company.slug}`;
    const existing = await tx
      .select({ sha256: documents.sha256 })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);

    if (!options.force && existing[0]?.sha256 === sectionHash) {
      const counts = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(chunks)
        .where(eq(chunks.documentId, documentId));
      if ((counts[0]?.count ?? 0) === textChunks.length) {
        return {
          result: {
            key: target.key,
            ticker: target.ticker,
            companyId: company.id,
            slug: company.slug,
            displayName: company.displayName,
            documentId,
            sectionTitle: parsed.title,
            chunks: textChunks.length,
            indexedChunks: 0,
            companyIndexed: false,
            skipped: true,
          },
          companyText,
          indexableChunks: [],
        } satisfies TransactionOutput;
      }
    }

    const storageKey = `sections/${path.basename(options.sectionPath)}`;
    await tx
      .insert(documents)
      .values({
        id: documentId,
        sourceId,
        companyId: company.id,
        docType: "company_profile",
        mime: "text/markdown",
        storageKey,
        sha256: sectionHash,
        language,
        pageCount: null,
        extractorVersion: `research-${options.model ?? "deepseek-flash"}`,
        title: `${company.displayName} — 公司研究 profile`,
        publishedAt: now,
        isFixture: false,
        metadata: {
          source: "backfill",
          ticker: target.ticker,
          market: target.market,
          indexCode: target.indexCode ?? null,
          indexAsOf: target.indexAsOf ?? null,
          sectionPath: storageKey,
          sectionTitle: parsed.title,
          chapters: parsed.chapters.map((chapter) => chapter.section),
          chunkCount: textChunks.length,
          model: options.model ?? null,
        },
      })
      .onConflictDoUpdate({
        target: documents.id,
        set: {
          sourceId,
          companyId: company.id,
          docType: "company_profile",
          mime: "text/markdown",
          storageKey,
          sha256: sectionHash,
          language,
          extractorVersion: `research-${options.model ?? "deepseek-flash"}`,
          title: `${company.displayName} — 公司研究 profile`,
          publishedAt: now,
          isFixture: false,
          metadata: {
            source: "backfill",
            ticker: target.ticker,
            market: target.market,
            indexCode: target.indexCode ?? null,
            indexAsOf: target.indexAsOf ?? null,
            sectionPath: storageKey,
            sectionTitle: parsed.title,
            chapters: parsed.chapters.map((chapter) => chapter.section),
            chunkCount: textChunks.length,
            model: options.model ?? null,
          },
        },
      });

    await tx.delete(chunks).where(eq(chunks.documentId, documentId));
    const indexableChunks: IndexableChunk[] = textChunks.map((chunk, ordinal) => {
      const chunkId = `${documentId}_c${ordinal}`;
      return {
        id: chunkId,
        documentId,
        companyId: company.id,
        text: chunk.text,
        title: `${company.displayName} — 公司研究 profile`,
        docType: "company_profile",
        market: target.market,
        lang: language,
        sourceUrl,
        page: null,
        section: chunk.section,
        publishedAt: now.toISOString(),
        isFixture: false,
      };
    });

    await tx.insert(chunks).values(
      textChunks.map((chunk, ordinal) => ({
        id: `${documentId}_c${ordinal}`,
        documentId,
        companyId: company.id,
        ordinal,
        page: null,
        section: chunk.section,
        text: chunk.text,
        tokenCount: chunk.tokenCount,
        qdrantPointId: toPointId(`${documentId}_c${ordinal}`),
        embeddingVersion: ctx.embeddingVersion,
      })),
    );

    return {
      result: {
        key: target.key,
        ticker: target.ticker,
        companyId: company.id,
        slug: company.slug,
        displayName: company.displayName,
        documentId,
        sectionTitle: parsed.title,
        chunks: textChunks.length,
        indexedChunks: 0,
        companyIndexed: false,
        skipped: false,
      },
      companyText,
      indexableChunks,
    } satisfies TransactionOutput;
  });

  if (output.result.skipped || options.skipIndex || ctx.skipIndex) {
    return output.result;
  }

  await ensureCollections(ctx.qdrant, ctx.collections, ctx.embeddingDim);
  await ctx.qdrant.deleteByFilter(ctx.collections.documents, {
    must: [{ key: "document_id", match: { value: output.result.documentId } }],
  });
  const indexedChunks = await indexChunks(
    ctx.qdrant,
    ctx.embeddings,
    ctx.collections,
    output.indexableChunks,
  );

  const indexableCompany = await loadIndexableCompany(
    ctx.db,
    output.result.companyId,
    output.companyText,
  );
  let companyIndexed = false;
  if (indexableCompany) {
    await indexCompanies(
      ctx.qdrant,
      ctx.embeddings,
      ctx.collections,
      [indexableCompany],
    );
    companyIndexed = true;
  }

  return {
    ...output.result,
    indexedChunks,
    companyIndexed,
  };
}

/**
 * Ingest many sections with a bounded worker pool. One bad section never stops
 * the batch; failures are returned with their error text.
 */
export async function ingestSections(
  ctx: IngestContext,
  items: IngestBatchItem[],
  options: IngestBatchOptions = {},
): Promise<IngestBatchResult> {
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? 1, items.length || 1),
  );
  const results: IngestResult[] = [];
  const failed: IngestFailure[] = [];
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (!item) return;
      try {
        const result = await ingestSection(ctx, {
          sectionPath: item.sectionPath,
          target: item.target,
          force: options.force,
          skipIndex: options.skipIndex,
          model: options.model,
        });
        results.push(result);
        options.onProgress?.(result);
      } catch (error) {
        failed.push({
          key: item.target.key,
          ticker: item.target.ticker,
          sectionPath: item.sectionPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    total: items.length,
    processed: results.length,
    skipped: results.filter((result) => result.skipped).length,
    failed,
    chunks: results.reduce((sum, result) => sum + result.chunks, 0),
    indexedChunks: results.reduce((sum, result) => sum + result.indexedChunks, 0),
    results,
  };
}

type Executor = Pick<Db, "select" | "insert" | "update" | "delete" | "execute">;

interface ResolveInput {
  target: IngestTarget;
  parsed: ParsedSection;
  displayName: string;
  exchange: string;
  coverageTier: string;
  now: Date;
}

interface CompanyRow {
  id: string;
  slug: string;
  displayName: string;
  legalName: string;
  coverageTier: string;
}

async function resolveCompany(
  tx: Executor,
  input: ResolveInput,
): Promise<ResolvedCompany> {
  const { target, parsed, displayName, exchange, coverageTier, now } = input;

  const bySecurity = await tx
    .select({
      id: companies.id,
      slug: companies.slug,
      displayName: companies.displayName,
      legalName: companies.legalName,
      coverageTier: companies.coverageTier,
    })
    .from(securities)
    .innerJoin(companies, eq(securities.companyId, companies.id))
    .where(
      and(eq(securities.ticker, target.ticker), eq(securities.exchange, exchange)),
    )
    .limit(1);

  let existing = bySecurity[0] as CompanyRow | undefined;

  if (!existing) {
    const byTicker = await tx
      .select({
        id: companies.id,
        slug: companies.slug,
        displayName: companies.displayName,
        legalName: companies.legalName,
        coverageTier: companies.coverageTier,
      })
      .from(securities)
      .innerJoin(companies, eq(securities.companyId, companies.id))
      .where(eq(securities.ticker, target.ticker))
      .limit(1);
    existing = byTicker[0] as CompanyRow | undefined;
  }

  if (!existing) {
    const byId = await tx
      .select({
        id: companies.id,
        slug: companies.slug,
        displayName: companies.displayName,
        legalName: companies.legalName,
        coverageTier: companies.coverageTier,
      })
      .from(companyIds)
      .innerJoin(companies, eq(companyIds.companyId, companies.id))
      .where(
        and(
          eq(companyIds.idType, "ticker"),
          inArray(companyIds.idValue, [
            tickerIdValue(target),
            target.ticker,
          ]),
        ),
      )
      .limit(1);
    existing = byId[0] as CompanyRow | undefined;
  }

  if (!existing) {
    const candidates = uniqueSlugs([
      companySlug(displayName),
      companySlug(parsed.legalName),
      companySlug(target.name),
      slugify(target.ticker),
    ]);
    if (candidates.length > 0) {
      const bySlug = await tx
        .select({
          id: companies.id,
          slug: companies.slug,
          displayName: companies.displayName,
          legalName: companies.legalName,
          coverageTier: companies.coverageTier,
        })
        .from(companies)
        .where(inArray(companies.slug, candidates))
        .limit(1);
      existing = bySlug[0] as CompanyRow | undefined;
    }
  }

  const country = target.country ?? countryForMarket(target.market);
  const website = target.website ?? null;
  const description = summaryOf(parsed);
  const profile = {
    source: "backfill",
    ticker: target.ticker,
    market: target.market,
    lastIngestAt: now.toISOString(),
  };

  if (existing) {
    const nextDisplay = isPlaceholderName(existing.displayName, target.ticker)
      ? displayName
      : existing.displayName;
    const nextLegal = isPlaceholderName(existing.legalName, target.ticker)
      ? parsed.legalName || displayName
      : existing.legalName;
    await tx
      .update(companies)
      .set({
        displayName: nextDisplay,
        legalName: nextLegal,
        country: sql`coalesce(${companies.country}, ${country})`,
        website: sql`coalesce(${companies.website}, ${website})`,
        description: sql`coalesce(${companies.description}, ${description})`,
        coverageTier: higherCoverage(existing.coverageTier, coverageTier),
        isFixture: false,
        profile: sql`${companies.profile} || ${JSON.stringify(profile)}::jsonb`,
        updatedAt: now,
      })
      .where(eq(companies.id, existing.id));
    return {
      id: existing.id,
      slug: existing.slug,
      displayName: nextDisplay,
      legalName: nextLegal,
      created: false,
    };
  }

  const preferredSlug =
    companySlug(displayName) ||
    companySlug(target.name) ||
    slugify(target.ticker) ||
    `company-${sha1(target.key).slice(0, 10)}`;

  const inserted = await tx
    .insert(companies)
    .values({
      id: newId(),
      slug: preferredSlug,
      legalName: parsed.legalName || displayName,
      displayName,
      country,
      website,
      coverageTier,
      description,
      sector: null,
      isFixture: false,
      profile,
    })
    .onConflictDoNothing({ target: companies.slug })
    .returning({
      id: companies.id,
      slug: companies.slug,
      displayName: companies.displayName,
      legalName: companies.legalName,
    });

  if (inserted[0]) {
    return {
      id: inserted[0].id,
      slug: inserted[0].slug,
      displayName: inserted[0].displayName,
      legalName: inserted[0].legalName,
      created: true,
    };
  }

  // Slug raced with another ingest; reuse the row that won.
  const raced = await tx
    .select({
      id: companies.id,
      slug: companies.slug,
      displayName: companies.displayName,
      legalName: companies.legalName,
    })
    .from(companies)
    .where(eq(companies.slug, preferredSlug))
    .limit(1);
  if (!raced[0]) {
    throw new Error(`failed to resolve company for ${target.key}`);
  }
  return { ...raced[0], created: false };
}

interface RelationsInput {
  companyId: string;
  target: IngestTarget;
  parsed: ParsedSection;
  exchange: string;
  sourceId: string;
  now: Date;
}

async function writeCompanyRelations(
  tx: Executor,
  input: RelationsInput,
): Promise<void> {
  const { companyId, target, parsed, exchange, sourceId, now } = input;

  const aliasRows = new Map<
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
  const addAlias = (value: string | undefined | null, kind: string): void => {
    const alias = value?.trim();
    if (!alias) return;
    const lang = langOf(alias);
    const variants = pinyinVariants(alias);
    aliasRows.set(`${alias}\0${lang}`, {
      companyId,
      alias,
      lang,
      kind,
      pinyin: variants?.full ?? null,
      initials: variants?.initials ?? null,
    });
    // Exact-match support for users typing full pinyin or initials.
    for (const form of pinyinAliasForms(alias)) {
      aliasRows.set(`${form}\0zh`, {
        companyId,
        alias: form,
        lang: "zh",
        kind: "pinyin",
        pinyin: null,
        initials: null,
      });
    }
  };
  addAlias(parsed.legalName, "legal");
  addAlias(parsed.displayName, "brand");
  addAlias(target.name, "brand");
  addAlias(target.ticker, "ticker");
  addAlias(stripCorporateSuffix(parsed.legalName), "brand");
  if (aliasRows.size > 0) {
    await tx.insert(aliases).values([...aliasRows.values()]).onConflictDoNothing();
  }

  const existingSecurities = await tx
    .select({ ticker: securities.ticker, exchange: securities.exchange })
    .from(securities)
    .where(eq(securities.companyId, companyId));
  if (!existingSecurities.some((row) => row.ticker === target.ticker)) {
    await tx
      .insert(securities)
      .values({
        companyId,
        ticker: target.ticker,
        exchange,
        currency: currencyForMarket(target.market),
        status: "listed",
      })
      .onConflictDoNothing();
  }

  await tx
    .insert(companyIds)
    .values({
      companyId,
      idType: "ticker",
      idValue: tickerIdValue(target),
    })
    .onConflictDoNothing();

  if (target.indexCode) {
    const asOf = target.indexAsOf ?? now.toISOString().slice(0, 10);
    await tx
      .insert(indexMemberships)
      .values({
        indexCode: target.indexCode,
        companyId,
        weight: null,
        asOf,
        sourceId,
      })
      .onConflictDoUpdate({
        target: [
          indexMemberships.indexCode,
          indexMemberships.companyId,
          indexMemberships.asOf,
        ],
        set: { sourceId },
      });
  }
}

async function loadIndexableCompany(
  db: Db,
  companyId: string,
  documentText: string,
): Promise<IndexableCompany | null> {
  const rows = await db
    .select()
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  const company = rows[0];
  if (!company) return null;

  const aliasRows = await db
    .select({ alias: aliases.alias })
    .from(aliases)
    .where(eq(aliases.companyId, companyId));
  const securityRows = await db
    .select({
      ticker: securities.ticker,
      exchange: securities.exchange,
    })
    .from(securities)
    .where(eq(securities.companyId, companyId));
  const indexRows = await db
    .select({ indexCode: indexMemberships.indexCode })
    .from(indexMemberships)
    .where(eq(indexMemberships.companyId, companyId));
  const documentRows = await db
    .select({ title: documents.title })
    .from(documents)
    .where(
      and(eq(documents.companyId, companyId), eq(documents.isFixture, false)),
    )
    .limit(5);

  const markets = [
    ...new Set(
      securityRows
        .map((row) => marketForExchange(row.exchange))
        .filter((market): market is Market => Boolean(market)),
    ),
  ];

  return {
    id: company.id,
    slug: company.slug,
    displayName: company.displayName,
    legalName: company.legalName,
    aliases: aliasRows.map((row) => row.alias),
    description: company.description,
    sector: company.sector,
    country: company.country,
    coverageTier: company.coverageTier,
    isFixture: company.isFixture,
    tickers: securityRows.map((row) => row.ticker),
    markets,
    indices: [...new Set(indexRows.map((row) => row.indexCode))],
    marketCapBucket: company.marketCapBucket,
    documentText: [
      documentText,
      ...documentRows.map((row) => row.title ?? ""),
    ]
      .filter(Boolean)
      .join("\n"),
    updatedAt: new Date().toISOString(),
  };
}

function chooseDisplayName(parsed: ParsedSection, target: IngestTarget): string {
  const parsedName = parsed.displayName.trim();
  if (parsedName && parsedName.toUpperCase() !== target.ticker.toUpperCase()) {
    return parsedName;
  }
  const targetName = target.name.trim();
  if (targetName && targetName.toUpperCase() !== target.ticker.toUpperCase()) {
    return targetName;
  }
  return parsedName || targetName || target.ticker;
}

function companyIndexText(parsed: ParsedSection): string {
  const body = parsed.chapters
    .map((chapter) => `${chapter.section}\n${chapter.text}`)
    .join("\n")
    .slice(0, 2_000);
  return [parsed.title, body]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join("\n");
}

/** First chapter (usually "一句话") as a company description, citations stripped. */
function summaryOf(parsed: ParsedSection): string | null {
  const text =
    parsed.chapters.find((chapter) => chapter.section === "一句话")?.text ??
    parsed.chapters[0]?.text ??
    "";
  const clean = text
    .replace(/\[\d+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? clean.slice(0, 400) : null;
}

/** Strip common corporate suffixes so `Apple Inc.` → `apple`. */
export function companySlug(name: string): string {
  return slugify(
    name
      .replace(/[.,]/g, " ")
      .replace(
        /\b(incorporated|inc|corp(?:oration)?|co(?:mpany)?|ltd|limited|plc|holdings?|group|class [a-c]|the)\b/gi,
        " ",
      ),
  );
}

function stripCorporateSuffix(name: string): string {
  return name
    .replace(
      /[,\s]+(incorporated|inc\.?|corp(?:oration)?|co\.?|ltd\.?|limited|plc|holdings?|group)\.?\s*$/i,
      "",
    )
    .trim();
}

function uniqueSlugs(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function isPlaceholderName(value: string, ticker: string): boolean {
  const normalized = value.trim();
  return (
    normalized.length === 0 ||
    normalized.toUpperCase() === ticker.toUpperCase()
  );
}

function higherCoverage(current: string, next: string): string {
  const rank: Record<string, number> = {
    stub: 0,
    discovered: 1,
    ai_watchlist: 2,
    index_member: 3,
  };
  return (rank[next] ?? 0) > (rank[current] ?? 0) ? next : current;
}

function langOf(value: string): string {
  return /[㐀-鿿]/.test(value) ? "zh" : "en";
}

/** Section-level language: Chinese profile unless Latin dominates. */
function detectLanguage(text: string): "zh" | "en" {
  const cjk = (text.match(/[㐀-鿿]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (cjk === 0) return "en";
  return cjk / (cjk + latin) >= 0.2 ? "zh" : "en";
}

function marketForExchange(exchange: string): Market | undefined {
  switch (exchange.toUpperCase()) {
    case "SSE":
    case "SZSE":
    case "BSE":
      return "A";
    case "HKEX":
      return "HK";
    case "NASDAQ":
    case "NYSE":
    case "AMEX":
      return "US";
    default:
      return undefined;
  }
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

export { estimateTokens };

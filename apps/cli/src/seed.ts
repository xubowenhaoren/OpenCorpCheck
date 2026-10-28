import { eq, sql } from "drizzle-orm";

import { newId } from "@occ/core";
import {
  aliases,
  chunks,
  companies,
  companyIds,
  createDb,
  documents,
  indexMemberships,
  migrate,
  securities,
  sources,
} from "@occ/db";
import {
  HttpEmbeddingClient,
  QdrantClient,
  ensureCollections,
  indexChunks,
  indexCompanies,
  toPointId,
  tokenize,
  type IndexableChunk,
  type IndexableCompany,
} from "@occ/retrieval";
import { pinyinAliasForms, pinyinVariants } from "@occ/ingest";

import { config } from "./config.js";
import { SEED_COMPANIES, type SeedCompany } from "./seed-data.js";

const AS_OF = "2026-10-27";

export interface SeedOptions {
  reset?: boolean;
  skipIndex?: boolean;
}

export interface SeedResult {
  companies: number;
  documents: number;
  chunks: number;
  indexedCompanies: number;
  indexedChunks: number;
}

export async function seed(options: SeedOptions = {}): Promise<SeedResult> {
  const applied = await migrate(config.databaseUrl);
  if (applied.length > 0) {
    console.log(JSON.stringify({ level: "info", msg: "migrations applied", applied }));
  }

  const { db, pool } = createDb(config.databaseUrl);
  const qdrant = new QdrantClient({
    url: config.qdrantUrl,
    apiKey: config.qdrantApiKey,
  });
  const embeddings = new HttpEmbeddingClient({
    baseUrl: config.embeddingUrl,
    model: config.embeddingModel,
    dim: config.embeddingDim,
    version: config.embeddingVersion,
    timeoutMs: config.embeddingTimeoutMs,
  });

  try {
    if (options.reset) {
      await qdrant.deleteCollection(config.collections.companies);
      await qdrant.deleteCollection(config.collections.documents);
      await db.execute(sql`
        TRUNCATE TABLE relation_evidence, relations, products, financial_facts, facts,
         chunks, documents, sources, index_memberships, securities, aliases,
         company_ids, companies RESTART IDENTITY CASCADE
      `);
    }

    const indexableCompanies: IndexableCompany[] = [];
    const indexableChunks: IndexableChunk[] = [];
    let documentCount = 0;

    for (const seedCompany of SEED_COMPANIES) {
      const id = await upsertCompany(db, seedCompany);
      const bundle = await writeCompanyRelations(db, id, seedCompany);
      const documentText = seedCompany.documents
        .map((doc) => `${doc.title}\n${doc.text.slice(0, 240)}`)
        .join("\n");
      indexableCompanies.push({
        id,
        slug: seedCompany.slug,
        displayName: seedCompany.displayName,
        legalName: seedCompany.legalName,
        aliases: seedCompany.aliases.map((alias) => alias.alias),
        description: seedCompany.description,
        sector: seedCompany.sector,
        country: seedCompany.country,
        coverageTier: seedCompany.coverageTier,
        isFixture: true,
        tickers: seedCompany.securities.map((security) => security.ticker),
        markets: bundle.markets,
        indices: seedCompany.indices,
        documentText,
      });

      for (const [documentIndex, doc] of seedCompany.documents.entries()) {
        const documentId = `doc_${seedCompany.slug}_${documentIndex}`;
        const sourceId = `src_${seedCompany.slug}_${documentIndex}`;
        const url = `fixture://${seedCompany.slug}/${doc.key}`;
        const publishedAt = doc.publishedAt
          ? new Date(doc.publishedAt)
          : new Date(`${AS_OF}T00:00:00Z`);

        await db
          .insert(sources)
          .values({
            id: sourceId,
            url,
            canonicalUrl: url,
            domain: "fixture.opencorpcheck.local",
            title: doc.title,
            fetchedAt: new Date(`${AS_OF}T00:00:00Z`),
            httpStatus: 200,
            trustTier: "fixture",
            license: "CC0-1.0",
            robotsOk: true,
          })
          .onConflictDoUpdate({
            target: sources.id,
            set: {
              url,
              title: doc.title,
              fetchedAt: new Date(`${AS_OF}T00:00:00Z`),
            },
          });

        await db
          .insert(documents)
          .values({
            id: documentId,
            sourceId,
            companyId: id,
            docType: doc.docType,
            mime: "text/markdown",
            language: doc.lang,
            extractorVersion: "fixture-v1",
            title: doc.title,
            publishedAt,
            isFixture: true,
            metadata: { fixture: true, synthetic: true },
          })
          .onConflictDoUpdate({
            target: documents.id,
            set: {
              sourceId,
              companyId: id,
              title: doc.title,
              language: doc.lang,
              publishedAt,
              isFixture: true,
            },
          });

        await db.delete(chunks).where(eq(chunks.documentId, documentId));
        const parts = splitText(doc.text);
        for (const [ordinal, text] of parts.entries()) {
          const chunkId = `${documentId}_c${ordinal}`;
          indexableChunks.push({
            id: chunkId,
            documentId,
            companyId: id,
            text,
            title: doc.title,
            docType: doc.docType,
            market: bundle.markets[0] ?? null,
            lang: doc.lang,
            sourceUrl: url,
            page: null,
            section: doc.docType,
            publishedAt: publishedAt.toISOString(),
            isFixture: true,
          });
          await db.insert(chunks).values({
            id: chunkId,
            documentId,
            companyId: id,
            ordinal,
            text,
            tokenCount: tokenize(text).length,
            qdrantPointId: toPointId(chunkId),
            embeddingVersion: config.embeddingVersion,
          });
        }
        documentCount += 1;
      }
    }

    let indexedCompanies = 0;
    let indexedChunks = 0;
    if (!options.skipIndex) {
      await ensureCollections(qdrant, config.collections, config.embeddingDim);
      indexedCompanies = await indexCompanies(
        qdrant,
        embeddings,
        config.collections,
        indexableCompanies,
      );
      indexedChunks = await indexChunks(
        qdrant,
        embeddings,
        config.collections,
        indexableChunks,
      );
    }

    return {
      companies: indexableCompanies.length,
      documents: documentCount,
      chunks: indexableChunks.length,
      indexedCompanies,
      indexedChunks,
    };
  } finally {
    await pool.end();
  }
}

async function upsertCompany(
  db: ReturnType<typeof createDb>["db"],
  seedCompany: SeedCompany,
): Promise<string> {
  const existing = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.slug, seedCompany.slug))
    .limit(1);
  const id = existing[0]?.id ?? newId();
  const values = {
    id,
    slug: seedCompany.slug,
    legalName: seedCompany.legalName,
    displayName: seedCompany.displayName,
    country: seedCompany.country,
    website: seedCompany.website ?? null,
    coverageTier: seedCompany.coverageTier,
    description: seedCompany.description,
    sector: seedCompany.sector,
    isFixture: true,
    profile: { fixture: true },
    updatedAt: new Date(),
  };
  await db.insert(companies).values(values).onConflictDoUpdate({
    target: companies.id,
    set: {
      slug: values.slug,
      legalName: values.legalName,
      displayName: values.displayName,
      country: values.country,
      website: values.website,
      coverageTier: values.coverageTier,
      description: values.description,
      sector: values.sector,
      profile: values.profile,
      updatedAt: values.updatedAt,
    },
  });
  return id;
}

async function writeCompanyRelations(
  db: ReturnType<typeof createDb>["db"],
  companyId: string,
  seedCompany: SeedCompany,
): Promise<{ markets: string[] }> {
  await db.delete(aliases).where(eq(aliases.companyId, companyId));
  await db.delete(companyIds).where(eq(companyIds.companyId, companyId));
  await db.delete(securities).where(eq(securities.companyId, companyId));
  await db.delete(indexMemberships).where(eq(indexMemberships.companyId, companyId));

  if (seedCompany.aliases.length > 0) {
    const rows = new Map<
      string,
      {
        companyId: string;
        alias: string;
        lang: string;
        pinyin: string | null;
        initials: string | null;
        kind: string;
      }
    >();
    for (const alias of seedCompany.aliases) {
      const variants = pinyinVariants(alias.alias);
      rows.set(`${alias.alias}\0${alias.lang}`, {
        companyId,
        alias: alias.alias,
        lang: alias.lang,
        pinyin: alias.pinyin ?? variants?.full ?? null,
        initials: alias.initials ?? variants?.initials ?? null,
        kind: alias.kind,
      });
      for (const form of pinyinAliasForms(alias.alias)) {
        rows.set(`${form}\0zh`, {
          companyId,
          alias: form,
          lang: "zh",
          pinyin: null,
          initials: null,
          kind: "pinyin",
        });
      }
    }
    await db.insert(aliases).values([...rows.values()]);
  }
  if (seedCompany.ids.length > 0) {
    await db.insert(companyIds).values(
      seedCompany.ids.map((identifier) => ({
        companyId,
        idType: identifier.type,
        idValue: identifier.value,
      })),
    );
  }
  if (seedCompany.securities.length > 0) {
    await db.insert(securities).values(
      seedCompany.securities.map((security) => ({
        companyId,
        ticker: security.ticker,
        exchange: security.exchange,
        currency: security.currency,
        status: "listed",
      })),
    );
  }
  if (seedCompany.indices.length > 0) {
    await db.insert(indexMemberships).values(
      seedCompany.indices.map((indexCode) => ({
        indexCode,
        companyId,
        asOf: AS_OF,
        weight: null,
        sourceId: null,
      })),
    );
  }

  const markets = [
    ...new Set(
      seedCompany.securities
        .map((security) => marketForExchange(security.exchange))
        .filter((market): market is string => Boolean(market)),
    ),
  ];
  return { markets };
}

function marketForExchange(exchange: string): string | undefined {
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

function splitText(text: string, maxChars = 800): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const parts: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 1 > maxChars) {
      parts.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n${paragraph}` : paragraph;
    }
  }
  if (current) parts.push(current);
  return parts.length > 0 ? parts : [text];
}

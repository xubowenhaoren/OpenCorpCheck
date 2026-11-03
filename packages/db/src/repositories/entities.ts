import { createHash } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import { newId } from "@occ/core";
import type { Db } from "../client.js";
import {
  aliases,
  companies,
  companyIds,
  chunks,
  documents,
  entityMergeLog,
  facts,
  financialFacts,
  globalNewsLastUpdate,
  indexMemberships,
  relationEvidence,
  relations,
  reviewQueue,
  securities,
  sources,
} from "../schema.js";

export interface EntitySecurity {
  ticker: string;
  exchange: string;
  currency: string | null;
}

export interface EntityIdentifier {
  idType: string;
  idValue: string;
}

export interface EntityCompany {
  id: string;
  slug: string;
  displayName: string;
  legalName: string;
  country: string | null;
  coverageTier: string;
  sector: string | null;
  profile: Record<string, unknown>;
  isFixture: boolean;
  securities: EntitySecurity[];
  identifiers: EntityIdentifier[];
  aliases: string[];
  /** Alias + kind, so callers can exclude pinyin/ticker noise. */
  aliasEntries: Array<{ alias: string; kind: string }>;
}

export interface EntityCompanyListOptions {
  /** Include synthetic fixtures (default false). */
  includeFixtures?: boolean;
  /** Restrict to coverage tiers; omit for all. */
  coverageTiers?: string[];
}

/** Load companies with their securities and identifiers for enrichment. */
export async function listEntityCompanies(
  db: Db,
  options: EntityCompanyListOptions = {},
): Promise<EntityCompany[]> {
  const conditions = [];
  if (!options.includeFixtures) conditions.push(eq(companies.isFixture, false));
  if (options.coverageTiers?.length) {
    conditions.push(inArray(companies.coverageTier, options.coverageTiers));
  }
  const rows = await db
    .select({
      id: companies.id,
      slug: companies.slug,
      displayName: companies.displayName,
      legalName: companies.legalName,
      country: companies.country,
      coverageTier: companies.coverageTier,
      sector: companies.sector,
      profile: companies.profile,
      isFixture: companies.isFixture,
    })
    .from(companies)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(companies.slug);
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [securityRows, identifierRows, aliasRows] = await Promise.all([
    db
      .select({
        companyId: securities.companyId,
        ticker: securities.ticker,
        exchange: securities.exchange,
        currency: securities.currency,
      })
      .from(securities)
      .where(inArray(securities.companyId, ids)),
    db
      .select({
        companyId: companyIds.companyId,
        idType: companyIds.idType,
        idValue: companyIds.idValue,
      })
      .from(companyIds)
      .where(inArray(companyIds.companyId, ids)),
    db
      .select({
        companyId: aliases.companyId,
        alias: aliases.alias,
        kind: aliases.kind,
      })
      .from(aliases)
      .where(inArray(aliases.companyId, ids)),
  ]);

  const byId = new Map<string, EntityCompany>();
  for (const row of rows) {
    byId.set(row.id, {
      ...row,
      securities: [],
      identifiers: [],
      aliases: [],
      aliasEntries: [],
    });
  }
  for (const row of securityRows) {
    byId.get(row.companyId)?.securities.push({
      ticker: row.ticker,
      exchange: row.exchange,
      currency: row.currency,
    });
  }
  for (const row of identifierRows) {
    byId.get(row.companyId)?.identifiers.push({
      idType: row.idType,
      idValue: row.idValue,
    });
  }
  for (const row of aliasRows) {
    const company = byId.get(row.companyId);
    if (!company) continue;
    company.aliases.push(row.alias);
    company.aliasEntries.push({ alias: row.alias, kind: row.kind });
  }
  return [...byId.values()];
}

export interface EntityProfileUpdate {
  companyId: string;
  /** New canonical sector, or null to leave it untouched. */
  sector?: string | null;
  /** Shallow-merged into `companies.profile`. */
  profilePatch?: Record<string, unknown>;
}

/** Update sector/profile only when something actually changes. */
export async function updateEntityProfile(
  db: Db,
  update: EntityProfileUpdate,
): Promise<boolean> {
  const [row] = await db
    .select({
      sector: companies.sector,
      profile: companies.profile,
    })
    .from(companies)
    .where(eq(companies.id, update.companyId))
    .limit(1);
  if (!row) return false;
  const nextProfile = update.profilePatch
    ? { ...row.profile, ...update.profilePatch }
    : row.profile;
  const sectorChanged =
    update.sector !== undefined && update.sector !== row.sector;
  const profileChanged =
    update.profilePatch !== undefined &&
    JSON.stringify(nextProfile) !== JSON.stringify(row.profile);
  if (!sectorChanged && !profileChanged) return false;
  await db
    .update(companies)
    .set({
      ...(sectorChanged ? { sector: update.sector } : {}),
      ...(profileChanged ? { profile: nextProfile } : {}),
      updatedAt: new Date(),
    })
    .where(eq(companies.id, update.companyId));
  return true;
}

export interface IdentifierInsertInput {
  companyId: string;
  idType: string;
  idValue: string;
}

export interface IdentifierInsertResult {
  inserted: number;
  existing: number;
  conflicts: Array<{
    companyId: string;
    idType: string;
    idValue: string;
    ownerCompanyId: string;
  }>;
}

/**
 * Insert identifiers without ever stealing one from another company.
 *
 * `company_ids` has a global `(id_type, id_value)` unique key, so an identifier
 * is a deterministic entity key. A conflict with a different company is
 * reported and skipped; resolution (merge) is a separate, explicit step.
 */
export async function insertCompanyIdentifiers(
  db: Db,
  rows: IdentifierInsertInput[],
): Promise<IdentifierInsertResult> {
  const unique = new Map<string, IdentifierInsertInput>();
  for (const row of rows) {
    if (!row.companyId || !row.idType || !row.idValue) continue;
    unique.set(`${row.idType}\0${row.idValue}`, row);
  }
  const candidates = [...unique.values()];
  if (candidates.length === 0) {
    return { inserted: 0, existing: 0, conflicts: [] };
  }
  const idTypes = [...new Set(candidates.map((row) => row.idType))];
  const idValues = [...new Set(candidates.map((row) => row.idValue))];
  const existingRows = await db
    .select({
      companyId: companyIds.companyId,
      idType: companyIds.idType,
      idValue: companyIds.idValue,
    })
    .from(companyIds)
    .where(
      and(
        inArray(companyIds.idType, idTypes),
        inArray(companyIds.idValue, idValues),
      ),
    );
  const owners = new Map(
    existingRows.map((row) => [
      `${row.idType}\0${row.idValue}`,
      row.companyId,
    ]),
  );

  const conflicts: IdentifierInsertResult["conflicts"] = [];
  const toInsert: IdentifierInsertInput[] = [];
  let existing = 0;
  for (const row of candidates) {
    const key = `${row.idType}\0${row.idValue}`;
    const owner = owners.get(key);
    if (!owner) {
      toInsert.push(row);
      continue;
    }
    if (owner === row.companyId) {
      existing += 1;
      continue;
    }
    conflicts.push({
      companyId: row.companyId,
      idType: row.idType,
      idValue: row.idValue,
      ownerCompanyId: owner,
    });
  }
  if (toInsert.length === 0) {
    return { inserted: 0, existing, conflicts };
  }
  const inserted = await db
    .insert(companyIds)
    .values(toInsert)
    .onConflictDoNothing()
    .returning({ id: companyIds.id });
  return { inserted: inserted.length, existing, conflicts };
}

export interface GleifRelationInput {
  id: string;
  parentCompanyId: string;
  childCompanyId: string;
  quote: string;
  sourceUrl: string;
  sourceTitle: string;
  confidence: number;
  validFrom?: string;
}

/**
 * Additive, review-queued GLEIF parent edges.
 *
 * Unlike the F10 refresher this never removes an edge and never touches a
 * non-GLEIF relation. A human decision remains the only route to `verified`.
 */
export async function upsertGleifRelations(
  db: Db,
  rows: GleifRelationInput[],
): Promise<{ relations: number; evidence: number; reviews: number }> {
  let evidenceCount = 0;
  let reviewCount = 0;
  const sourceIds = new Map<string, string>();
  for (const row of rows) {
    let sourceId = sourceIds.get(row.sourceUrl);
    if (!sourceId) {
      sourceId = `src_gleif_${sha1(row.sourceUrl).slice(0, 24)}`;
      await db
        .insert(sources)
        .values({
          id: sourceId,
          url: row.sourceUrl,
          canonicalUrl: row.sourceUrl,
          domain: domainOf(row.sourceUrl),
          title: row.sourceTitle,
          trustTier: "secondary",
          robotsOk: true,
        })
        .onConflictDoUpdate({
          target: sources.id,
          set: { url: row.sourceUrl, title: row.sourceTitle },
        });
      sourceIds.set(row.sourceUrl, sourceId);
    }

    const dedupeKey = `relation:${row.id}`;
    let review = (
      await db
        .select({ id: reviewQueue.id })
        .from(reviewQueue)
        .where(eq(reviewQueue.dedupeKey, dedupeKey))
        .limit(1)
    )[0];
    if (!review) {
      const reviewId = `rq_${sha1(dedupeKey).slice(0, 24)}`;
      await db
        .insert(reviewQueue)
        .values({
          id: reviewId,
          kind: "relation",
          payload: {
            relationId: row.id,
            srcCompanyId: row.parentCompanyId,
            dstCompanyId: row.childCompanyId,
            type: "parent_of",
            confidence: row.confidence,
            origin: "gleif",
          },
          evidence: {
            quote: row.quote,
            sourceId,
            sourceUrl: row.sourceUrl,
          },
          dedupeKey,
        })
        .onConflictDoNothing({ target: reviewQueue.id });
      review = { id: reviewId };
      reviewCount += 1;
    }

    await db
      .insert(relations)
      .values({
        id: row.id,
        srcCompanyId: row.parentCompanyId,
        dstCompanyId: row.childCompanyId,
        type: "parent_of",
        status: "reported",
        confidence: row.confidence,
        validFrom: row.validFrom,
        extractorVersion: "gleif-lei-v1",
        reviewId: review.id,
      })
      .onConflictDoUpdate({
        target: relations.id,
        set: {
          type: "parent_of",
          confidence: row.confidence,
          validFrom: row.validFrom,
          reviewId: review.id,
          status: sql`CASE
            WHEN ${relations.status} = 'inferred' THEN 'reported'
            ELSE ${relations.status}
          END`,
        },
      });
    await db
      .insert(relationEvidence)
      .values({
        relationId: row.id,
        sourceId,
        quote: row.quote,
      })
      .onConflictDoNothing();
    evidenceCount += 1;
  }
  return { relations: rows.length, evidence: evidenceCount, reviews: reviewCount };
}

export interface MergeResult {
  survivorId: string;
  mergedId: string;
  moved: {
    securities: number;
    aliases: number;
    identifiers: number;
    memberships: number;
    droppedDuplicates: number;
  };
  snapshot: Record<string, unknown>;
}

export class EntityMergeBlocked extends Error {
  constructor(
    readonly companyId: string,
    readonly blockers: Record<string, number>,
  ) {
    super(
      `refusing to merge ${companyId}: it still owns documents/facts/relations ` +
        `(${Object.entries(blockers)
          .map(([key, count]) => `${key}=${count}`)
          .join(", ")})`,
    );
    this.name = "EntityMergeBlocked";
  }
}

/**
 * Merge a stub/duplicate into a surviving company inside one transaction.
 *
 * Only reference rows (securities, aliases, identifiers, index memberships)
 * move; the duplicate must have no documents, chunks, facts, financials,
 * relations, review items or news cursor. The pre-merge snapshot is written to
 * `entity_merge_log` so the decision is auditable.
 */
export async function mergeEntityCompanies(
  db: Db,
  input: {
    survivorId: string;
    mergedId: string;
    reason: string;
    evidence: Record<string, unknown>;
  },
): Promise<MergeResult> {
  return db.transaction(async (tx) => {
    const blockers = await countBlockers(tx, input.mergedId);
    if (Object.values(blockers).some((count) => count > 0)) {
      throw new EntityMergeBlocked(input.mergedId, blockers);
    }

    const [survivor] = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, input.survivorId))
      .limit(1);
    const [merged] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, input.mergedId))
      .limit(1);
    if (!survivor || !merged) {
      throw new Error(
        `cannot merge ${input.mergedId} into ${input.survivorId}: company row missing`,
      );
    }

    // Sequential reads: one pg client cannot run overlapping queries.
    const mergedSecurities = await tx
      .select()
      .from(securities)
      .where(eq(securities.companyId, input.mergedId));
    const mergedAliases = await tx
      .select()
      .from(aliases)
      .where(eq(aliases.companyId, input.mergedId));
    const mergedIdentifiers = await tx
      .select()
      .from(companyIds)
      .where(eq(companyIds.companyId, input.mergedId));
    const mergedMemberships = await tx
      .select()
      .from(indexMemberships)
      .where(eq(indexMemberships.companyId, input.mergedId));

    const snapshot = {
      company: merged,
      securities: mergedSecurities,
      aliases: mergedAliases,
      identifiers: mergedIdentifiers,
      memberships: mergedMemberships,
    };

    let movedSecurities = 0;
    let movedAliases = 0;
    let movedIdentifiers = 0;
    let movedMemberships = 0;
    let dropped = 0;

    for (const row of mergedSecurities) {
      const [duplicate] = await tx
        .select({ id: securities.id })
        .from(securities)
        .where(
          and(
            eq(securities.companyId, input.survivorId),
            eq(securities.ticker, row.ticker),
            eq(securities.exchange, row.exchange),
          ),
        )
        .limit(1);
      if (duplicate) {
        await tx.delete(securities).where(eq(securities.id, row.id));
        dropped += 1;
      } else {
        await tx
          .update(securities)
          .set({ companyId: input.survivorId })
          .where(eq(securities.id, row.id));
        movedSecurities += 1;
      }
    }

    for (const row of mergedAliases) {
      const [duplicate] = await tx
        .select({ id: aliases.id })
        .from(aliases)
        .where(
          and(
            eq(aliases.companyId, input.survivorId),
            eq(aliases.alias, row.alias),
            eq(aliases.lang, row.lang),
          ),
        )
        .limit(1);
      if (duplicate) {
        await tx.delete(aliases).where(eq(aliases.id, row.id));
        dropped += 1;
      } else {
        await tx
          .update(aliases)
          .set({ companyId: input.survivorId })
          .where(eq(aliases.id, row.id));
        movedAliases += 1;
      }
    }

    for (const row of mergedIdentifiers) {
      const [duplicate] = await tx
        .select({ id: companyIds.id })
        .from(companyIds)
        .where(
          and(
            eq(companyIds.companyId, input.survivorId),
            eq(companyIds.idType, row.idType),
            eq(companyIds.idValue, row.idValue),
          ),
        )
        .limit(1);
      if (duplicate) {
        await tx.delete(companyIds).where(eq(companyIds.id, row.id));
        dropped += 1;
      } else {
        await tx
          .update(companyIds)
          .set({ companyId: input.survivorId })
          .where(eq(companyIds.id, row.id));
        movedIdentifiers += 1;
      }
    }

    for (const row of mergedMemberships) {
      const [duplicate] = await tx
        .select({ id: indexMemberships.id })
        .from(indexMemberships)
        .where(
          and(
            eq(indexMemberships.companyId, input.survivorId),
            eq(indexMemberships.indexCode, row.indexCode),
            eq(indexMemberships.asOf, row.asOf),
          ),
        )
        .limit(1);
      if (duplicate) {
        await tx.delete(indexMemberships).where(eq(indexMemberships.id, row.id));
        dropped += 1;
      } else {
        await tx
          .update(indexMemberships)
          .set({ companyId: input.survivorId })
          .where(eq(indexMemberships.id, row.id));
        movedMemberships += 1;
      }
    }

    await tx.insert(entityMergeLog).values({
      id: newId(),
      survivorId: input.survivorId,
      mergedId: input.mergedId,
      reason: input.reason,
      evidence: input.evidence,
      snapshot,
    });
    await tx
      .update(companies)
      .set({ updatedAt: new Date() })
      .where(eq(companies.id, input.survivorId));
    await tx.delete(companies).where(eq(companies.id, input.mergedId));

    return {
      survivorId: input.survivorId,
      mergedId: input.mergedId,
      moved: {
        securities: movedSecurities,
        aliases: movedAliases,
        identifiers: movedIdentifiers,
        memberships: movedMemberships,
        droppedDuplicates: dropped,
      },
      snapshot,
    };
  });
}

async function countBlockers(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  companyId: string,
): Promise<Record<string, number>> {
  const [documentCount] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(documents)
    .where(eq(documents.companyId, companyId));
  const [chunkCount] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(chunks)
    .where(eq(chunks.companyId, companyId));
  const [factCount] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(facts)
    .where(eq(facts.companyId, companyId));
  const [financialCount] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(financialFacts)
    .where(eq(financialFacts.companyId, companyId));
  const [outgoing] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(relations)
    .where(eq(relations.srcCompanyId, companyId));
  const [incoming] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(relations)
    .where(eq(relations.dstCompanyId, companyId));
  const [reviews] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(reviewQueue)
    .where(
      sql`(${reviewQueue.payload}->>'srcCompanyId' = ${companyId}
        OR ${reviewQueue.payload}->>'dstCompanyId' = ${companyId})`,
    );
  const [news] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(globalNewsLastUpdate)
    .where(eq(globalNewsLastUpdate.companyId, companyId));
  return {
    documents: documentCount?.count ?? 0,
    chunks: chunkCount?.count ?? 0,
    facts: factCount?.count ?? 0,
    financials: financialCount?.count ?? 0,
    relations: (outgoing?.count ?? 0) + (incoming?.count ?? 0),
    news: news?.count ?? 0,
    reviewItems: reviews?.count ?? 0,
  };
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function domainOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

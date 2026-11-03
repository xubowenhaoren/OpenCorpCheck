import { createHash } from "node:crypto";

import { inArray, sql } from "drizzle-orm";

import type { Db } from "../client.js";
import {
  relationEvidence,
  relations,
  reviewQueue,
  sources,
} from "../schema.js";

/**
 * Additive, review-queued ownership edges (P1.3).
 *
 * 13F and HKEX DION are large, repeating sources: a new quarter updates the
 * same `(holder, issuer, type)` edge instead of inserting another one, and a
 * rerun must be a no-op. Other extractors' edges are never modified; they are
 * counted as duplicates in the report.
 */
export type OwnershipEdgeType = "owns" | "invests_in" | "parent_of";

export interface OwnershipRelationInput {
  srcCompanyId: string;
  dstCompanyId: string;
  type: OwnershipEdgeType;
  quote: string;
  sourceUrl: string;
  sourceTitle: string;
  confidence: number;
  validFrom?: string;
  publishedAt?: Date;
  amount?: number;
  currency?: string;
  metadata: Record<string, unknown>;
  extractorVersion: string;
  /** Short origin tag for source ids, e.g. `sec-13f`, `hkex-dion`. */
  origin: string;
}

export interface OwnershipWriteResult {
  planned: number;
  inserted: number;
  updated: number;
  /** Same `(holder, issuer, type)` already owned by another extractor. */
  duplicates: number;
  evidenceInserted: number;
  reviewsInserted: number;
  sourcesInserted: number;
}

const CHUNK = 300;

export async function upsertOwnershipRelations(
  db: Db,
  rows: OwnershipRelationInput[],
  options: { dryRun?: boolean } = {},
): Promise<OwnershipWriteResult> {
  const result: OwnershipWriteResult = {
    planned: rows.length,
    inserted: 0,
    updated: 0,
    duplicates: 0,
    evidenceInserted: 0,
    reviewsInserted: 0,
    sourcesInserted: 0,
  };
  if (rows.length === 0) return result;

  const planned = dedupePlanned(rows);

  const existing = await db
    .select({
      id: relations.id,
      srcCompanyId: relations.srcCompanyId,
      dstCompanyId: relations.dstCompanyId,
      type: relations.type,
      extractorVersion: relations.extractorVersion,
      reviewId: relations.reviewId,
    })
    .from(relations);
  const byKey = new Map<
    string,
    Array<{ id: string; extractorVersion: string | null; reviewId: string | null }>
  >();
  const existingIds = new Set<string>();
  for (const row of existing) {
    existingIds.add(row.id);
    const key = relationKey(row.srcCompanyId, row.dstCompanyId, row.type);
    const list = byKey.get(key) ?? [];
    list.push({
      id: row.id,
      extractorVersion: row.extractorVersion,
      reviewId: row.reviewId,
    });
    byKey.set(key, list);
  }

  interface Target {
    input: OwnershipRelationInput;
    id: string;
    mode: "insert" | "update";
    reviewId?: string;
  }
  const targets: Target[] = [];
  for (const input of planned) {
    const key = relationKey(input.srcCompanyId, input.dstCompanyId, input.type);
    const candidates = byKey.get(key) ?? [];
    const sameSource = candidates.find(
      (candidate) => candidate.extractorVersion === input.extractorVersion,
    );
    if (!sameSource) {
      if (candidates.length > 0) {
        // This pair is already owned by another extractor; do not duplicate it.
        result.duplicates += 1;
        continue;
      }
      const id = deterministicRelationId(input);
      if (existingIds.has(id)) {
        // A hash collision is practically impossible; fail loudly instead of
        // silently overwriting an unrelated edge.
        throw new Error(`ownership relation id collision: ${id}`);
      }
      existingIds.add(id);
      targets.push({ input, id, mode: "insert" });
      continue;
    }
    targets.push({
      input,
      id: sameSource.id,
      mode: "update",
      ...(sameSource.reviewId ? { reviewId: sameSource.reviewId } : {}),
    });
  }
  if (targets.length === 0) return result;

  result.inserted = targets.filter((target) => target.mode === "insert").length;
  result.updated = targets.length - result.inserted;
  if (options.dryRun) return result;

  // Sources first: relations/evidence reference them.
  const sourceRows = new Map<string, typeof sources.$inferInsert>();
  for (const target of targets) {
    const { input } = target;
    if (sourceRows.has(input.sourceUrl)) continue;
    sourceRows.set(input.sourceUrl, {
      id: `src_${sanitize(input.origin)}_${sha1(input.sourceUrl).slice(0, 24)}`,
      url: input.sourceUrl,
      canonicalUrl: input.sourceUrl,
      domain: domainOf(input.sourceUrl),
      title: input.sourceTitle,
      trustTier: "official",
      robotsOk: true,
      fetchedAt: input.publishedAt ?? new Date(),
    });
  }
  const sourceIdByUrl = new Map(
    [...sourceRows.entries()].map(([url, row]) => [url, row.id!]),
  );
  const sourceIds = [...sourceIdByUrl.values()];
  if (sourceIds.length > 0) {
    const existingSources = await db
      .select({ id: sources.id })
      .from(sources)
      .where(inArray(sources.id, sourceIds));
    result.sourcesInserted = sourceIds.length - existingSources.length;
  }
  for (const chunk of chunks([...sourceRows.values()], CHUNK)) {
    await db
      .insert(sources)
      .values(chunk)
      .onConflictDoUpdate({
        target: sources.id,
        set: {
          url: sql`excluded.url`,
          canonicalUrl: sql`excluded.canonical_url`,
          title: sql`excluded.title`,
          trustTier: sql`excluded.trust_tier`,
        },
      });
  }

  // Review items next: relations.review_id is a FK.
  const dedupeKeys = targets.map((target) => `relation:${target.id}`);
  const knownReviews = new Map<string, string>();
  for (const chunk of chunks(dedupeKeys, CHUNK)) {
    const found = await db
      .select({ id: reviewQueue.id, dedupeKey: reviewQueue.dedupeKey })
      .from(reviewQueue)
      .where(inArray(reviewQueue.dedupeKey, chunk));
    for (const row of found) {
      if (row.dedupeKey) knownReviews.set(row.dedupeKey, row.id);
    }
  }
  const missingReviews: Array<typeof reviewQueue.$inferInsert> = [];
  const reviewByRelation = new Map<string, string>();
  for (const target of targets) {
    const dedupeKey = `relation:${target.id}`;
    const known = target.reviewId ?? knownReviews.get(dedupeKey);
    if (known) {
      reviewByRelation.set(target.id, known);
      continue;
    }
    const reviewId = `rq_${sha1(dedupeKey).slice(0, 24)}`;
    reviewByRelation.set(target.id, reviewId);
    const sourceId = sourceIdByUrl.get(target.input.sourceUrl);
    missingReviews.push({
      id: reviewId,
      kind: "relation",
      payload: {
        relationId: target.id,
        srcCompanyId: target.input.srcCompanyId,
        dstCompanyId: target.input.dstCompanyId,
        type: target.input.type,
        confidence: target.input.confidence,
        origin: target.input.origin,
        metadata: target.input.metadata,
      },
      evidence: {
        quote: target.input.quote,
        ...(sourceId ? { sourceId } : {}),
        sourceUrl: target.input.sourceUrl,
      },
      dedupeKey,
    });
  }
  for (const chunk of chunks(missingReviews, CHUNK)) {
    await db.insert(reviewQueue).values(chunk).onConflictDoNothing();
    result.reviewsInserted += chunk.length;
  }
  // A dedupe-key conflict could carry a different deterministic id (e.g. a
  // review created by another writer); always resolve the id that actually
  // exists before pointing relations at it.
  const missingKeys = missingReviews
    .map((row) => row.dedupeKey)
    .filter((key): key is string => Boolean(key));
  const actualReviews = new Map<string, string>();
  for (const chunk of chunks(missingKeys, CHUNK)) {
    const found = await db
      .select({ id: reviewQueue.id, dedupeKey: reviewQueue.dedupeKey })
      .from(reviewQueue)
      .where(inArray(reviewQueue.dedupeKey, chunk));
    for (const row of found) {
      if (row.dedupeKey) actualReviews.set(row.dedupeKey, row.id);
    }
  }
  for (const target of targets) {
    const actual = actualReviews.get(`relation:${target.id}`);
    if (actual) reviewByRelation.set(target.id, actual);
  }

  const relationRows = targets.map((target) => {
    const { input } = target;
    return {
      id: target.id,
      srcCompanyId: input.srcCompanyId,
      dstCompanyId: input.dstCompanyId,
      type: input.type,
      status: "reported",
      confidence: input.confidence,
      validFrom: input.validFrom,
      extractorVersion: input.extractorVersion,
      metadata: input.metadata,
      amount: input.amount,
      currency: input.currency,
      reviewId: reviewByRelation.get(target.id),
    } satisfies typeof relations.$inferInsert;
  });
  for (const chunk of chunks(relationRows, CHUNK)) {
    await db
      .insert(relations)
      .values(chunk)
      .onConflictDoUpdate({
        target: relations.id,
        set: {
          type: sql`excluded.type`,
          confidence: sql`excluded.confidence`,
          validFrom: sql`excluded.valid_from`,
          amount: sql`excluded.amount`,
          currency: sql`excluded.currency`,
          extractorVersion: sql`excluded.extractor_version`,
          metadata: sql`excluded.metadata`,
          reviewId: sql`excluded.review_id`,
          status: sql`CASE
            WHEN ${relations.status} = 'inferred' THEN 'reported'
            ELSE ${relations.status}
          END`,
        },
      });
  }

  const evidenceRows: Array<typeof relationEvidence.$inferInsert> = [];
  for (const target of targets) {
    const sourceId = sourceIdByUrl.get(target.input.sourceUrl);
    if (!sourceId) continue;
    evidenceRows.push({
      relationId: target.id,
      sourceId,
      quote: target.input.quote,
      publishedAt: target.input.publishedAt,
    });
  }
  for (const chunk of chunks(evidenceRows, CHUNK)) {
    const inserted = await db
      .insert(relationEvidence)
      .values(chunk)
      .onConflictDoNothing()
      .returning({ id: relationEvidence.id });
    result.evidenceInserted += inserted.length;
  }

  return result;
}

function dedupePlanned(rows: OwnershipRelationInput[]): OwnershipRelationInput[] {
  const seen = new Map<string, OwnershipRelationInput>();
  for (const row of rows) {
    const key = relationKey(row.srcCompanyId, row.dstCompanyId, row.type);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, row);
      continue;
    }
    // Keep the newest period when the same edge is emitted twice.
    const left = row.validFrom ?? "";
    const right = existing.validFrom ?? "";
    if (left > right) seen.set(key, row);
  }
  return [...seen.values()];
}

function deterministicRelationId(input: OwnershipRelationInput): string {
  return `rel_${sha1(
    `${input.extractorVersion}|${input.srcCompanyId}|${input.dstCompanyId}|${input.type}`,
  ).slice(0, 24)}`;
}

function relationKey(src: string, dst: string, type: string): string {
  return `${src}\0${dst}\0${type}`;
}

function sanitize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
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

function chunks<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    out.push(rows.slice(index, index + size));
  }
  return out;
}

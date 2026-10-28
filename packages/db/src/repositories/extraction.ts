import { createHash } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import type { Db } from "../client.js";
import {
  extractionCache,
  facts,
  financialFacts,
  relationEvidence,
  relations,
  reviewQueue,
  sources,
} from "../schema.js";

export type NewFinancialFact = typeof financialFacts.$inferInsert;
export type NewFact = typeof facts.$inferInsert;

export interface CitationInput {
  ref: number;
  url: string;
  title?: string;
  publisher?: string;
  publishedAt?: string;
  fetchedAt?: string;
}

export interface InferredRelationInput {
  id: string;
  srcCompanyId: string;
  dstCompanyId: string;
  type: string;
  confidence: number;
  quote: string;
  sourceId?: string | null;
  sourceRefs?: number[];
  amount?: number;
  currency?: string;
  extractorVersion?: string;
}

export interface ExtractionCacheInput {
  companyId: string;
  stage: "deterministic" | "relations";
  inputSha256: string;
  promptHash?: string;
  model?: string;
  status: "ok" | "partial" | "failed";
  stats?: Record<string, unknown>;
  error?: string;
  tokensInput?: number;
  tokensOutput?: number;
  durationMs?: number;
}

export interface ReviewItemInput {
  kind: "fact" | "relation";
  payload: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  dedupeKey: string;
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function financialFactId(input: {
  companyId: string;
  statement: string;
  item: string;
  periodEnd: string;
}): string {
  return `ff_${sha1(
    `${input.companyId}|${input.statement}|${input.item}|${input.periodEnd}`,
  ).slice(0, 24)}`;
}

export function factId(input: {
  companyId: string;
  predicate: string;
  value: unknown;
  observedAt?: string;
}): string {
  return `fact_${sha1(
    `${input.companyId}|${input.predicate}|${stableJson(input.value)}|${input.observedAt ?? ""}`,
  ).slice(0, 24)}`;
}

export function relationId(input: {
  srcCompanyId: string;
  dstCompanyId: string;
  type: string;
  quote: string;
}): string {
  return `rel_${sha1(
    `${input.srcCompanyId}|${input.dstCompanyId}|${input.type}|${input.quote}`,
  ).slice(0, 24)}`;
}

export function reviewItemId(dedupeKey: string): string {
  return `rvw_${sha1(dedupeKey).slice(0, 24)}`;
}

/** Remove tracking parameters but keep meaningful fragments (F10 uses #/cwfx). */
export function canonicalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|trk($|[_-]))/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return raw;
  }
}

export function trustTierForUrl(raw: string): string {
  let host = "";
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return "secondary";
  }
  if (
    host === "sec.gov" ||
    host.endsWith(".sec.gov") ||
    host.endsWith("cninfo.com.cn") ||
    host.endsWith("hkexnews.hk") ||
    host.endsWith("hkex.com.hk") ||
    host.endsWith(".gov")
  ) {
    return "official";
  }
  if (/(^|\.)(apple|microsoft|amazon|alphabet|nvidia)\.com$/.test(host)) {
    return "company_ir";
  }
  if (
    host.endsWith("eastmoney.com") ||
    host.endsWith("stockanalysis.com") ||
    host.endsWith("fool.com")
  ) {
    return "secondary";
  }
  return "media";
}

export async function upsertCitationSources(
  db: Db,
  citations: CitationInput[],
  now = new Date(),
): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  for (const citation of citations) {
    const canonical = canonicalizeUrl(citation.url);
    const id = `src_web_${sha1(canonical).slice(0, 24)}`;
    const fetchedAt = citation.fetchedAt ? new Date(citation.fetchedAt) : now;
    await db
      .insert(sources)
      .values({
        id,
        url: citation.url,
        canonicalUrl: canonical,
        domain: (() => {
          try {
            return new URL(canonical).hostname;
          } catch {
            return undefined;
          }
        })(),
        title: citation.title ?? citation.publisher ?? undefined,
        fetchedAt: Number.isNaN(fetchedAt.getTime()) ? now : fetchedAt,
        httpStatus: 200,
        trustTier: trustTierForUrl(citation.url),
      })
      .onConflictDoUpdate({
        target: sources.id,
        set: {
          url: citation.url,
          canonicalUrl: canonical,
          title: citation.title ?? citation.publisher ?? undefined,
          trustTier: trustTierForUrl(citation.url),
        },
      });
    map.set(citation.ref, id);
  }
  return map;
}

export async function upsertFinancialFacts(
  db: Db,
  rows: NewFinancialFact[],
): Promise<number> {
  if (rows.length === 0) return 0;
  await db
    .insert(financialFacts)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        financialFacts.companyId,
        financialFacts.statement,
        financialFacts.item,
        financialFacts.periodEnd,
      ],
      set: {
        periodKind: excluded("period_kind"),
        periodLabel: excluded("period_label"),
        periodStart: excluded("period_start"),
        fiscalYear: excluded("fiscal_year"),
        fiscalQuarter: excluded("fiscal_quarter"),
        value: excluded("value"),
        unit: excluded("unit"),
        currency: excluded("currency"),
        sourceId: excluded("source_id"),
        quote: excluded("quote"),
        method: excluded("method"),
        confidence: excluded("confidence"),
        extractorVersion: excluded("extractor_version"),
        sourceRefs: excluded("source_refs"),
      },
    });
  return rows.length;
}

export async function upsertFacts(db: Db, rows: NewFact[]): Promise<number> {
  if (rows.length === 0) return 0;
  await db
    .insert(facts)
    .values(rows)
    .onConflictDoUpdate({
      target: facts.id,
      set: {
        value: excluded("value"),
        sourceId: excluded("source_id"),
        quote: excluded("quote"),
        method: excluded("method"),
        confidence: excluded("confidence"),
        observedAt: excluded("observed_at"),
        extractorVersion: excluded("extractor_version"),
        sourceRefs: excluded("source_refs"),
      },
    });
  return rows.length;
}

/** Replace the inferred edges sourced from one company, keeping human edits. */
export async function replaceInferredRelations(
  db: Db,
  companyId: string,
  rows: InferredRelationInput[],
): Promise<{ relations: number; evidence: number; reviews: number }> {
  await db.delete(relations).where(
    and(
      eq(relations.srcCompanyId, companyId),
      eq(relations.status, "inferred"),
    ),
  );

  let evidenceCount = 0;
  let reviewCount = 0;
  for (const row of rows) {
    const dedupeKey = `relation:${row.id}`;
    let review = (
      await db
        .select({ id: reviewQueue.id })
        .from(reviewQueue)
        .where(eq(reviewQueue.dedupeKey, dedupeKey))
        .limit(1)
    )[0];
    if (!review) {
      const reviewId = reviewItemId(dedupeKey);
      await db
        .insert(reviewQueue)
        .values({
          id: reviewId,
          kind: "relation",
          payload: {
            relationId: row.id,
            srcCompanyId: row.srcCompanyId,
            dstCompanyId: row.dstCompanyId,
            type: row.type,
            confidence: row.confidence,
          },
          evidence: {
            quote: row.quote,
            sourceId: row.sourceId ?? null,
            sourceRefs: row.sourceRefs ?? [],
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
        srcCompanyId: row.srcCompanyId,
        dstCompanyId: row.dstCompanyId,
        type: row.type,
        status: "inferred",
        confidence: row.confidence,
        amount: row.amount,
        currency: row.currency,
        extractorVersion: row.extractorVersion,
        reviewId: review.id,
      })
      .onConflictDoNothing({ target: relations.id });

    await db
      .insert(relationEvidence)
      .values({
        relationId: row.id,
        sourceId: row.sourceId ?? null,
        quote: row.quote,
        publishedAt: null,
      })
      .onConflictDoNothing();
    evidenceCount += 1;
  }
  return { relations: rows.length, evidence: evidenceCount, reviews: reviewCount };
}

export async function getExtractionCache(
  db: Db,
  companyId: string,
  stage: "deterministic" | "relations",
): Promise<typeof extractionCache.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(extractionCache)
    .where(
      and(
        eq(extractionCache.companyId, companyId),
        eq(extractionCache.stage, stage),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function upsertExtractionCache(
  db: Db,
  input: ExtractionCacheInput,
): Promise<void> {
  await db
    .insert(extractionCache)
    .values({
      companyId: input.companyId,
      stage: input.stage,
      inputSha256: input.inputSha256,
      promptHash: input.promptHash,
      model: input.model,
      status: input.status,
      stats: input.stats ?? {},
      error: input.error,
      tokensInput: input.tokensInput ?? 0,
      tokensOutput: input.tokensOutput ?? 0,
      durationMs: input.durationMs,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [extractionCache.companyId, extractionCache.stage],
      set: {
        inputSha256: input.inputSha256,
        promptHash: input.promptHash,
        model: input.model,
        status: input.status,
        stats: input.stats ?? {},
        error: input.error,
        tokensInput: input.tokensInput ?? 0,
        tokensOutput: input.tokensOutput ?? 0,
        durationMs: input.durationMs,
        updatedAt: new Date(),
      },
    });
}

export async function upsertReviewItem(
  db: Db,
  input: ReviewItemInput,
): Promise<{ item: { id: string }; created: boolean }> {
  const existing = (
    await db
      .select({ id: reviewQueue.id })
      .from(reviewQueue)
      .where(eq(reviewQueue.dedupeKey, input.dedupeKey))
      .limit(1)
  )[0];
  if (existing) {
    // Refresh evidence only; never overwrite a human decision.
    await db
      .update(reviewQueue)
      .set({
        payload: input.payload,
        evidence: input.evidence,
        updatedAt: new Date(),
      })
      .where(eq(reviewQueue.id, existing.id));
    return { item: existing, created: false };
  }
  const id = reviewItemId(input.dedupeKey);
  await db
    .insert(reviewQueue)
    .values({
      id,
      kind: input.kind,
      payload: input.payload,
      evidence: input.evidence,
      dedupeKey: input.dedupeKey,
    })
    .onConflictDoNothing({ target: reviewQueue.id });
  return { item: { id }, created: true };
}

/** Drizzle helper: reference the excluded (incoming) value in an upsert. */
function excluded(column: string) {
  return sql.raw(`excluded."${column}"`);
}

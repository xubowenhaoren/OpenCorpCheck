import { createHash } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

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

export interface ReportRelationInput {
  id: string;
  srcCompanyId: string;
  dstCompanyId: string;
  type: string;
  quote: string;
  sourceUrl: string;
  sourceTitle?: string;
  confidence: number;
  validFrom?: string;
}

/**
 * Upsert directly reported (F10 table) relations without deleting anything.
 *
 * Unlike `replaceInferredRelations`, this is additive: a page refresh must not
 * remove LLM-extracted or human-reviewed edges. Existing `verified`/`rejected`
 * rows keep their status; `inferred` rows with the same identity are upgraded
 * to `reported`, which is still unreviewed.
 */
export async function upsertReportedRelations(
  db: Db,
  rows: ReportRelationInput[],
  options: { dstCompanyId?: string } = {},
): Promise<{ relations: number; evidence: number; reviews: number }> {
  let evidenceCount = 0;
  let reviewCount = 0;
  const sourceIds = new Map<string, string>();
  const nextIds = new Set(rows.map((row) => row.id));
  const destinations = [
    ...new Set([
      ...rows.map((row) => row.dstCompanyId),
      ...(options.dstCompanyId ? [options.dstCompanyId] : []),
    ]),
  ];

  // Refresh semantics: replace *unreviewed F10 edges into this company* so a
  // changed percentage/quote does not leave a stale duplicate. Verified and
  // rejected rows, and every LLM-inferred edge, are never touched.
  for (const dstCompanyId of destinations) {
    const previous = await db
      .select({ id: relations.id })
      .from(relations)
      .where(
        and(
          eq(relations.dstCompanyId, dstCompanyId),
          eq(relations.status, "reported"),
          eq(relations.extractorVersion, "f10-table-v1"),
        ),
      );
    const stale = previous
      .map((row) => row.id)
      .filter((id) => !nextIds.has(id));
    if (stale.length === 0) continue;
    await db.delete(relations).where(inArray(relations.id, stale));
    await db.delete(reviewQueue).where(
      and(
        eq(reviewQueue.kind, "relation"),
        eq(reviewQueue.status, "pending"),
        inArray(
          reviewQueue.dedupeKey,
          stale.map((id) => `relation:${id}`),
        ),
      ),
    );
  }

  for (const row of rows) {
    let sourceId = sourceIds.get(row.sourceUrl);
    if (!sourceId) {
      sourceId = `src_f10_${sha1(row.sourceUrl).slice(0, 24)}`;
      await db
        .insert(sources)
        .values({
          id: sourceId,
          url: row.sourceUrl,
          canonicalUrl: canonicalizeUrl(row.sourceUrl),
          domain: (() => {
            try {
              return new URL(row.sourceUrl).hostname;
            } catch {
              return undefined;
            }
          })(),
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
            origin: "f10_table",
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
        srcCompanyId: row.srcCompanyId,
        dstCompanyId: row.dstCompanyId,
        type: row.type,
        status: "reported",
        confidence: row.confidence,
        validFrom: row.validFrom,
        extractorVersion: "f10-table-v1",
        reviewId: review.id,
      })
      .onConflictDoUpdate({
        target: relations.id,
        set: {
          type: row.type,
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

export type ExtractionStage =
  | "deterministic"
  | "relations"
  | "f10_relations"
  | "financials";

export interface ExtractionCacheInput {
  companyId: string;
  stage: ExtractionStage;
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
  periodKind?: string;
}): string {
  return `ff_${sha1(
    `${input.companyId}|${input.statement}|${input.item}|${input.periodEnd}|${input.periodKind ?? "annual"}`,
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

/** Remove previous deterministic output so changed values do not linger. */
export async function clearDeterministicFacts(
  db: Db,
  companyId: string,
  extractorVersion: string,
): Promise<void> {
  await db
    .delete(financialFacts)
    .where(
      and(
        eq(financialFacts.companyId, companyId),
        eq(financialFacts.extractorVersion, extractorVersion),
      ),
    );
  await db
    .delete(facts)
    .where(
      and(
        eq(facts.companyId, companyId),
        eq(facts.extractorVersion, extractorVersion),
      ),
    );
}

export async function upsertFinancialFacts(
  db: Db,
  rows: NewFinancialFact[],
  options: { rank?: number } = {},
): Promise<number> {
  if (rows.length === 0) return 0;
  // ON CONFLICT cannot update the same row twice in one statement; collapse
  // duplicates that share the natural key (e.g. two columns parsing to the
  // same period).
  const unique = new Map<string, NewFinancialFact>();
  for (const row of rows) {
    unique.set(
      `${row.companyId}|${row.statement}|${row.item}|${row.periodEnd}|${row.periodKind}`,
      row,
    );
  }
  const values = [...unique.values()];
  const rank = options.rank ?? 10;
  await db
    .insert(financialFacts)
    .values(values)
    .onConflictDoUpdate({
      target: [
        financialFacts.companyId,
        financialFacts.statement,
        financialFacts.item,
        financialFacts.periodEnd,
        financialFacts.periodKind,
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
      // Precedence: a profile row never overwrites F10 or XBRL; F10 never
      // overwrites XBRL. Same-rank refreshes still update.
      where: sql`(CASE ${financialFacts.method}
        WHEN 'xbrl' THEN 30
        WHEN 'f10' THEN 20
        ELSE 10
      END) <= ${rank}`,
    });
  return values.length;
}

/** Delete rows owned by one structured extractor, leaving other methods alone. */
export async function clearFinancialFactsByExtractor(
  db: Db,
  companyId: string,
  extractorVersion: string,
): Promise<void> {
  await db
    .delete(financialFacts)
    .where(
      and(
        eq(financialFacts.companyId, companyId),
        eq(financialFacts.extractorVersion, extractorVersion),
      ),
    );
}

export interface SourceRecordInput {
  url: string;
  title?: string;
  trustTier: string;
  fetchedAt?: Date;
  license?: string;
}

/**
 * Upsert one provenance row for a structured financial cell and return its id.
 * The id is derived from the canonical URL, so repeated runs reuse the row.
 */
export async function upsertSourceRecord(
  db: Db,
  input: SourceRecordInput,
): Promise<string> {
  const canonical = canonicalizeUrl(input.url);
  const id = `src_web_${sha1(canonical).slice(0, 24)}`;
  await db
    .insert(sources)
    .values({
      id,
      url: input.url,
      canonicalUrl: canonical,
      domain: (() => {
        try {
          return new URL(canonical).hostname;
        } catch {
          return undefined;
        }
      })(),
      title: input.title,
      fetchedAt: input.fetchedAt,
      httpStatus: 200,
      trustTier: input.trustTier,
      license: input.license,
    })
    .onConflictDoUpdate({
      target: sources.id,
      set: {
        url: input.url,
        canonicalUrl: canonical,
        title: input.title,
        trustTier: input.trustTier,
        ...(input.license ? { license: input.license } : {}),
      },
    });
  return id;
}

export async function upsertFacts(
  db: Db,
  rows: NewFact[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const unique = new Map(rows.map((row) => [row.id, row]));
  const values = [...unique.values()];
  await db
    .insert(facts)
    .values(values)
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
  const previous = await db
    .select({ id: relations.id })
    .from(relations)
    .where(
      and(
        eq(relations.srcCompanyId, companyId),
        eq(relations.status, "inferred"),
      ),
    );
  await db.delete(relations).where(
    and(
      eq(relations.srcCompanyId, companyId),
      eq(relations.status, "inferred"),
    ),
  );

  // Drop pending proposals for edges that no longer exist. Never touch rows a
  // human already reviewed.
  const nextIds = new Set(rows.map((row) => row.id));
  const staleKeys = previous
    .filter((row) => !nextIds.has(row.id))
    .map((row) => `relation:${row.id}`);
  if (staleKeys.length > 0) {
    await db
      .delete(reviewQueue)
      .where(
        and(
          eq(reviewQueue.kind, "relation"),
          eq(reviewQueue.status, "pending"),
          inArray(reviewQueue.dedupeKey, staleKeys),
        ),
      );
  }

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
  stage: ExtractionStage,
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

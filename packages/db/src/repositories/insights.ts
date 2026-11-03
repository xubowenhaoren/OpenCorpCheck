import { createHash } from "node:crypto";

import {
  relationLabel,
  type CompanyFactView,
  type CompanySummary,
  type FinancialFactView,
  type NewsEventView,
  type PeriodKind,
  type RelationEvidenceView,
  type RelationStatus,
  type RelationType,
  type RelationView,
  type ReviewItemView,
  type ReviewKind,
  type ReviewStatus,
  type SourceRefView,
} from "@occ/core";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";

import type { Db } from "../client.js";
import {
  companies,
  companyIds,
  documents,
  facts,
  financialFacts,
  relationEvidence,
  relations,
  reviewQueue,
  securities,
  sources,
} from "../schema.js";
import { getCompanyBundles, type CompanyBundle } from "./companies.js";

type SourceRow = typeof sources.$inferSelect;
type FinancialFactRow = typeof financialFacts.$inferSelect;
type FactRow = typeof facts.$inferSelect;
type RelationRow = typeof relations.$inferSelect;
type ReviewRow = typeof reviewQueue.$inferSelect;

export interface FinancialFactFilter {
  statement?: string;
  item?: string;
  periodKind?: string;
  fiscalYear?: number;
  limit?: number;
  offset?: number;
}

export interface FactFilter {
  predicate?: string;
  limit?: number;
  offset?: number;
}

export interface RelationFilter {
  direction?: "outgoing" | "incoming" | "both";
  type?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface ReviewItemFilter {
  status?: string;
  kind?: string;
  limit?: number;
  offset?: number;
}

function toSource(row: SourceRow | null): SourceRefView | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    url: row.url,
    title: row.title ?? undefined,
    trustTier: row.trustTier,
  };
}

function toFinancialFactView(
  row: FinancialFactRow,
  source: SourceRow | null,
): FinancialFactView {
  return {
    id: row.id,
    companyId: row.companyId,
    statement: row.statement,
    item: row.item,
    periodKind: row.periodKind as PeriodKind,
    periodLabel: row.periodLabel ?? undefined,
    periodStart: row.periodStart ?? undefined,
    periodEnd: row.periodEnd,
    fiscalYear: row.fiscalYear ?? undefined,
    fiscalQuarter: row.fiscalQuarter ?? undefined,
    value: row.value,
    unit: row.unit,
    currency: row.currency ?? undefined,
    method: row.method,
    confidence: row.confidence ?? undefined,
    quote: row.quote ?? undefined,
    sourceRefs: row.sourceRefs ?? [],
    source: toSource(source),
  };
}

function toCompanyFactView(row: FactRow, source: SourceRow | null): CompanyFactView {
  return {
    id: row.id,
    companyId: row.companyId,
    predicate: row.predicate,
    value: row.value,
    method: row.method,
    confidence: row.confidence ?? undefined,
    observedAt: row.observedAt?.toISOString(),
    quote: row.quote ?? undefined,
    sourceRefs: row.sourceRefs ?? [],
    source: toSource(source),
  };
}

function asRelationType(value: string): RelationType {
  const allowed: RelationType[] = [
    "owns",
    "parent_of",
    "invests_in",
    "supplies",
    "buys_from",
    "competes_with",
    "partners_with",
    "joint_venture_with",
    "licenses_to",
    "licenses_from",
    "other",
  ];
  return allowed.includes(value as RelationType) ? (value as RelationType) : "other";
}

function asStatus(value: string): RelationStatus {
  const allowed: RelationStatus[] = ["reported", "inferred", "verified", "rejected"];
  return allowed.includes(value as RelationStatus)
    ? (value as RelationStatus)
    : "reported";
}

function summaryOf(bundle: CompanyBundle): CompanySummary {
  return {
    id: bundle.company.id,
    slug: bundle.company.slug,
    displayName: bundle.company.displayName,
    legalName: bundle.company.legalName,
    tickers: bundle.securities.map((security) => ({
      ticker: security.ticker,
      exchange: security.exchange,
      currency: security.currency ?? undefined,
    })),
  };
}

/** Resolve a ULID, slug, ticker or external ticker id to a company id. */
export async function resolveCompanyId(db: Db, ref: string): Promise<string | null> {
  const value = ref.trim();
  if (!value) return null;

  const direct = await db
    .select({ id: companies.id })
    .from(companies)
    .where(or(eq(companies.id, value), eq(companies.slug, value)))
    .limit(1);
  if (direct[0]) return direct[0].id;

  const byTicker = await db
    .select({ companyId: securities.companyId })
    .from(securities)
    .where(sql`lower(${securities.ticker}) = lower(${value})`)
    .limit(1);
  if (byTicker[0]) return byTicker[0].companyId;

  const byExternal = await db
    .select({ companyId: companyIds.companyId })
    .from(companyIds)
    .where(sql`lower(${companyIds.idValue}) = lower(${value})`)
    .limit(1);
  return byExternal[0]?.companyId ?? null;
}

export async function listFinancialFacts(
  db: Db,
  companyId: string,
  filter: FinancialFactFilter = {},
): Promise<FinancialFactView[]> {
  const conditions = [eq(financialFacts.companyId, companyId)];
  if (filter.statement) {
    conditions.push(eq(financialFacts.statement, filter.statement));
  }
  if (filter.item) conditions.push(eq(financialFacts.item, filter.item));
  if (filter.periodKind) {
    conditions.push(eq(financialFacts.periodKind, filter.periodKind));
  }
  if (filter.fiscalYear !== undefined) {
    conditions.push(eq(financialFacts.fiscalYear, filter.fiscalYear));
  }

  const rows = await db
    .select({ fact: financialFacts, source: sources })
    .from(financialFacts)
    .leftJoin(sources, eq(financialFacts.sourceId, sources.id))
    .where(and(...conditions))
    .orderBy(desc(financialFacts.periodEnd), financialFacts.statement, financialFacts.item)
    .limit(filter.limit ?? 20)
    .offset(filter.offset ?? 0);
  return rows.map((row) => toFinancialFactView(row.fact, row.source));
}

export async function listFacts(
  db: Db,
  companyId: string,
  filter: FactFilter = {},
): Promise<CompanyFactView[]> {
  const conditions = [eq(facts.companyId, companyId)];
  if (filter.predicate) conditions.push(eq(facts.predicate, filter.predicate));

  const rows = await db
    .select({ fact: facts, source: sources })
    .from(facts)
    .leftJoin(sources, eq(facts.sourceId, sources.id))
    .where(and(...conditions))
    .orderBy(desc(facts.observedAt), facts.predicate)
    .limit(filter.limit ?? 30)
    .offset(filter.offset ?? 0);
  return rows.map((row) => toCompanyFactView(row.fact, row.source));
}

export async function listRelations(
  db: Db,
  companyId: string,
  filter: RelationFilter = {},
): Promise<RelationView[]> {
  const direction = filter.direction ?? "both";
  const directionClause =
    direction === "outgoing"
      ? eq(relations.srcCompanyId, companyId)
      : direction === "incoming"
        ? eq(relations.dstCompanyId, companyId)
        : or(
            eq(relations.srcCompanyId, companyId),
            eq(relations.dstCompanyId, companyId),
          );
  const conditions = [directionClause];
  if (filter.type) conditions.push(eq(relations.type, filter.type));
  if (filter.status) conditions.push(eq(relations.status, filter.status));

  const rows = await db
    .select()
    .from(relations)
    .where(and(...conditions))
    .orderBy(
      desc(relations.confidence),
      sql`${relations.amount} DESC NULLS LAST`,
      relations.id,
    )
    .limit(filter.limit ?? 20)
    .offset(filter.offset ?? 0);
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const companyIds = [
    ...new Set(rows.flatMap((row) => [row.srcCompanyId, row.dstCompanyId])),
  ];
  const [bundles, evidenceRows] = await Promise.all([
    getCompanyBundles(db, companyIds),
    db
      .select({ evidence: relationEvidence, source: sources })
      .from(relationEvidence)
      .leftJoin(sources, eq(relationEvidence.sourceId, sources.id))
      .where(inArray(relationEvidence.relationId, ids))
      .orderBy(desc(relationEvidence.publishedAt), desc(relationEvidence.id)),
  ]);

  const evidenceByRelation = new Map<string, RelationEvidenceView[]>();
  for (const { evidence, source } of evidenceRows) {
    const list = evidenceByRelation.get(evidence.relationId) ?? [];
    list.push({
      sourceId: evidence.sourceId ?? undefined,
      url: source?.url,
      title: source?.title ?? undefined,
      trustTier: source?.trustTier,
      quote: evidence.quote ?? undefined,
      publishedAt: evidence.publishedAt?.toISOString(),
    });
    evidenceByRelation.set(evidence.relationId, list);
  }

  return rows.map((row) => {
    const edgeDirection: "outgoing" | "incoming" =
      row.srcCompanyId === companyId ? "outgoing" : "incoming";
    const type = asRelationType(row.type);
    const srcBundle = bundles.get(row.srcCompanyId);
    const dstBundle = bundles.get(row.dstCompanyId);
    return {
      id: row.id,
      src: srcBundle
        ? summaryOf(srcBundle)
        : { id: row.srcCompanyId, slug: "", displayName: row.srcCompanyId, tickers: [] },
      dst: dstBundle
        ? summaryOf(dstBundle)
        : { id: row.dstCompanyId, slug: "", displayName: row.dstCompanyId, tickers: [] },
      type,
      label: relationLabel(type, edgeDirection),
      direction: edgeDirection,
      status: asStatus(row.status),
      confidence: row.confidence ?? undefined,
      amount: row.amount ?? undefined,
      currency: row.currency ?? undefined,
      validFrom: row.validFrom ?? undefined,
      validTo: row.validTo ?? undefined,
      extractorVersion: row.extractorVersion ?? undefined,
      metadata: row.metadata,
      evidence: evidenceByRelation.get(row.id) ?? [],
    };
  });
}

export async function listEvents(
  db: Db,
  companyId: string,
  limit = 10,
): Promise<NewsEventView[]> {
  const [timeline, news] = await Promise.all([
    db
      .select({ fact: facts, source: sources })
      .from(facts)
      .leftJoin(sources, eq(facts.sourceId, sources.id))
      .where(and(eq(facts.companyId, companyId), eq(facts.predicate, "timeline_event")))
      .orderBy(desc(facts.observedAt))
      .limit(limit),
    db
      .select({ document: documents, source: sources })
      .from(documents)
      .leftJoin(sources, eq(documents.sourceId, sources.id))
      .where(
        and(
          eq(documents.companyId, companyId),
          inArray(documents.docType, ["news", "press_release"]),
          eq(documents.isFixture, false),
        ),
      )
      .orderBy(desc(documents.publishedAt))
      .limit(limit),
  ]);

  const events: NewsEventView[] = timeline.map(({ fact, source }) => {
    const value = fact.value as { date?: string; title?: string; text?: string };
    return {
      id: fact.id,
      companyId,
      kind: "profile_event",
      date: value?.date,
      title: value?.title ?? value?.text ?? fact.quote ?? "事件",
      summary: value?.text,
      quote: fact.quote ?? undefined,
      source: toSource(source),
    };
  });
  for (const { document, source } of news) {
    events.push({
      id: document.id,
      companyId,
      kind: "news",
      date: document.publishedAt?.toISOString(),
      title: document.title ?? "新闻",
      source: toSource(source),
    });
  }
  return events
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
    .slice(0, limit);
}

/**
 * Official filing events (P1.4). Kept separate from news so a busy news day
 * cannot push a company's announcements out of the timeline.
 */
export async function listFilingEvents(
  db: Db,
  companyId: string,
  limit = 20,
): Promise<NewsEventView[]> {
  const rows = await db
    .select({ document: documents, source: sources })
    .from(documents)
    .leftJoin(sources, eq(documents.sourceId, sources.id))
    .where(
      and(
        eq(documents.companyId, companyId),
        eq(documents.docType, "filing"),
        eq(documents.isFixture, false),
      ),
    )
    .orderBy(sql`${documents.publishedAt} DESC NULLS LAST`)
    .limit(limit);
  return rows.map(({ document, source }) => {
    const metadata = (document.metadata ?? {}) as Record<string, unknown>;
    const form = typeof metadata.form === "string" ? metadata.form : undefined;
    const category =
      typeof metadata.category === "string" ? metadata.category : undefined;
    const label = [form, category]
      .filter((value, index, values) => value && values.indexOf(value) === index)
      .join(" · ");
    return {
      id: document.id,
      companyId,
      kind: "filing" as const,
      date: document.publishedAt?.toISOString(),
      title: document.title ?? "公告",
      ...(label ? { summary: label } : {}),
      source: toSource(source),
    };
  });
}

export async function getCompanyCounts(
  db: Db,
  companyId: string,
): Promise<{
  financials: number;
  facts: number;
  relationsOutgoing: number;
  relationsIncoming: number;
  events: number;
}> {
  const count = async (query: Promise<Array<{ value: number }>>) =>
    (await query)[0]?.value ?? 0;

  const [financialCount, factCount, outgoing, incoming, timelineCount, newsCount] =
    await Promise.all([
      count(
        db
          .select({ value: sql<number>`count(*)::int` })
          .from(financialFacts)
          .where(eq(financialFacts.companyId, companyId)),
      ),
      count(
        db
          .select({ value: sql<number>`count(*)::int` })
          .from(facts)
          .where(eq(facts.companyId, companyId)),
      ),
      count(
        db
          .select({ value: sql<number>`count(*)::int` })
          .from(relations)
          .where(eq(relations.srcCompanyId, companyId)),
      ),
      count(
        db
          .select({ value: sql<number>`count(*)::int` })
          .from(relations)
          .where(eq(relations.dstCompanyId, companyId)),
      ),
      count(
        db
          .select({ value: sql<number>`count(*)::int` })
          .from(facts)
          .where(
            and(
              eq(facts.companyId, companyId),
              eq(facts.predicate, "timeline_event"),
            ),
          ),
      ),
      count(
        db
          .select({ value: sql<number>`count(*)::int` })
          .from(documents)
          .where(
            and(
              eq(documents.companyId, companyId),
              inArray(documents.docType, ["news", "press_release"]),
              eq(documents.isFixture, false),
            ),
          ),
      ),
    ]);

  return {
    financials: financialCount,
    facts: factCount,
    relationsOutgoing: outgoing,
    relationsIncoming: incoming,
    events: timelineCount + newsCount,
  };
}

function toReviewItem(row: ReviewRow): ReviewItemView {
  return {
    id: row.id,
    kind: row.kind as ReviewKind,
    payload: row.payload,
    evidence: row.evidence ?? undefined,
    status: row.status as ReviewStatus,
    reviewer: row.reviewer ?? undefined,
    dedupeKey: row.dedupeKey ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listReviewItems(
  db: Db,
  filter: ReviewItemFilter = {},
): Promise<{ items: ReviewItemView[]; total: number }> {
  const conditions = [];
  if (filter.status) conditions.push(eq(reviewQueue.status, filter.status));
  if (filter.kind) conditions.push(eq(reviewQueue.kind, filter.kind));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, totalRows] = await Promise.all([
    db
      .select()
      .from(reviewQueue)
      .where(where)
      .orderBy(desc(reviewQueue.createdAt))
      .limit(filter.limit ?? 50)
      .offset(filter.offset ?? 0),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(reviewQueue)
      .where(where),
  ]);
  return {
    items: rows.map(toReviewItem),
    total: totalRows[0]?.value ?? 0,
  };
}

export async function getReviewItem(
  db: Db,
  id: string,
): Promise<ReviewItemView | null> {
  const [row] = await db
    .select()
    .from(reviewQueue)
    .where(eq(reviewQueue.id, id))
    .limit(1);
  return row ? toReviewItem(row) : null;
}

export interface ReviewDecisionFilter {
  /** Explicit queue item ids. */
  ids?: string[];
  kind?: ReviewKind;
  /** Matches `payload.companyId` (fact) or the source company (relation). */
  companyId?: string;
  limit?: number;
  /** Explicit opt-in to every pending item; requires a `limit`. */
  all?: boolean;
}

export interface ReviewDecisionOutcome {
  updated: number;
  skipped: number;
  items: ReviewItemView[];
}

type ReviewTx = Pick<Db, "select" | "insert" | "update" | "delete" | "execute">;

/**
 * Move pending review items to `accepted`/`rejected` and apply the canonical
 * write for accepted items:
 *
 *   - extracted relations (`relations.review_id = item.id`) → status verified/rejected;
 *   - accepted relation proposals without a row → create the edge + evidence;
 *   - accepted fact proposals → insert a `facts` row with an `agent_proposal` source.
 *
 * Only pending rows transition, so retries are idempotent. Rejected items never
 * create rows. A human decision is the only path from `inferred` to `verified`.
 */
export async function decideReviewItems(
  db: Db,
  filter: ReviewDecisionFilter,
  decision: { status: "accepted" | "rejected"; reviewer?: string },
): Promise<ReviewDecisionOutcome> {
  const ids = filter.ids?.filter(Boolean) ?? [];
  if (
    !filter.all &&
    ids.length === 0 &&
    !filter.kind &&
    !filter.companyId
  ) {
    throw new Error("review decision needs ids, kind, company or all");
  }
  const limit = Math.max(1, Math.min(filter.limit ?? 200, 500));
  const pendingConditions = [eq(reviewQueue.status, "pending")];
  if (ids.length > 0) pendingConditions.push(inArray(reviewQueue.id, ids));
  if (filter.kind) pendingConditions.push(eq(reviewQueue.kind, filter.kind));
  if (filter.companyId) {
    pendingConditions.push(
      sql`${reviewQueue.payload}->>'companyId' = ${filter.companyId}`,
    );
  }
  const where = and(...pendingConditions);

  return db.transaction(async (tx) => {
    const candidates = await tx
      .select()
      .from(reviewQueue)
      .where(where)
      .orderBy(asc(reviewQueue.createdAt))
      .limit(limit)
      .for("update");

    if (candidates.length === 0) {
      return { updated: 0, skipped: ids.length, items: [] };
    }

    // Count before the update: afterwards the updated rows are no longer
    // `pending`, so a post-update count would under-report skipped items.
    const [selectedTotalRow] = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(reviewQueue)
      .where(where);

    const now = new Date();
    const idsToUpdate = candidates.map((row) => row.id);
    const updatedRows = await tx
      .update(reviewQueue)
      .set({
        status: decision.status,
        reviewer: decision.reviewer ?? null,
        updatedAt: now,
      })
      .where(
        and(
          eq(reviewQueue.status, "pending"),
          inArray(reviewQueue.id, idsToUpdate),
        ),
      )
      .returning();

    for (const row of updatedRows) {
      await applyDecision(tx, row, decision.status, now);
    }

    let skipped = 0;
    if (ids.length > 0) {
      skipped = Math.max(0, ids.length - updatedRows.length);
    } else {
      skipped = Math.max(
        0,
        (selectedTotalRow?.value ?? 0) - updatedRows.length,
      );
    }

    return {
      updated: updatedRows.length,
      skipped,
      items: updatedRows.map(toReviewItem),
    };
  });
}

async function applyDecision(
  tx: ReviewTx,
  row: ReviewRow,
  status: "accepted" | "rejected",
  now: Date,
): Promise<void> {
  const payload = asRecord(row.payload);
  const evidence = asRecord(row.evidence);

  if (row.kind === "relation") {
    const linked = await tx
      .select({ id: relations.id })
      .from(relations)
      .where(eq(relations.reviewId, row.id));
    if (linked.length > 0) {
      const relationStatus = status === "accepted" ? "verified" : "rejected";
      await tx
        .update(relations)
        .set({ status: relationStatus })
        .where(
          inArray(
            relations.id,
            linked.map((relation) => relation.id),
          ),
        );
      return;
    }

    if (status !== "accepted") return;
    const srcCompanyId = stringField(payload, "srcCompanyId");
    const dstCompanyId = stringField(payload, "dstCompanyId");
    const type = stringField(payload, "type");
    if (!srcCompanyId || !dstCompanyId || !type) return;

    const relationId = `rel_proposal_${row.id}`;
    await tx
      .insert(relations)
      .values({
        id: relationId,
        srcCompanyId,
        dstCompanyId,
        type,
        status: "verified",
        confidence: numberField(evidence, "confidence"),
        extractorVersion: "review-v1",
        reviewId: row.id,
      })
      .onConflictDoNothing({ target: relations.id });

    const quote = stringField(evidence, "quote") ?? null;
    const sourceUrl = stringField(evidence, "sourceUrl");
    const sourceId = sourceUrl
      ? await ensureProposalSource(tx, sourceUrl, now)
      : null;
    if (quote || sourceId) {
      await tx
        .insert(relationEvidence)
        .values({
          relationId,
          sourceId,
          quote,
          publishedAt: now,
        })
        .onConflictDoNothing();
    }
    return;
  }

  if (row.kind !== "fact" || status !== "accepted") return;

  const companyId = stringField(payload, "companyId");
  const predicate = stringField(payload, "predicate");
  if (
    !companyId ||
    !predicate ||
    payload.value === undefined ||
    payload.value === null
  ) {
    return;
  }

  const sourceUrl = stringField(evidence, "sourceUrl");
  const sourceId = sourceUrl
    ? await ensureProposalSource(tx, sourceUrl, now)
    : null;
  await tx
    .insert(facts)
    .values({
      id: `fact_proposal_${row.id}`,
      companyId,
      predicate,
      value: payload.value,
      sourceId,
      quote: stringField(evidence, "quote") ?? null,
      method: "agent_proposal",
      confidence: numberField(evidence, "confidence"),
      extractorVersion: "review-v1",
      sourceRefs: [],
      observedAt: now,
    })
    .onConflictDoNothing({ target: facts.id });
}

async function ensureProposalSource(
  tx: ReviewTx,
  url: string,
  now: Date,
): Promise<string> {
  const id = `src_proposal_${sha1(url).slice(0, 20)}`;
  let domain: string | null = null;
  try {
    domain = new URL(url).hostname;
  } catch {
    // Keep the raw URL and a null domain for non-http evidence.
  }
  await tx
    .insert(sources)
    .values({
      id,
      url,
      canonicalUrl: url,
      domain,
      title: "Agent proposal evidence",
      fetchedAt: now,
      trustTier: "proposal",
      license: "agent-proposal",
      robotsOk: true,
    })
    .onConflictDoNothing({ target: sources.id });
  return id;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

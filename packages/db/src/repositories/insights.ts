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
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";

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
    "competes_with",
    "partners_with",
    "joint_venture_with",
    "licenses_to",
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
    .orderBy(desc(relations.confidence), relations.id)
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
      .where(inArray(relationEvidence.relationId, ids)),
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

  const [financialCount, factCount, outgoing, incoming, eventCount] =
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
    ]);

  return {
    financials: financialCount,
    facts: factCount,
    relationsOutgoing: outgoing,
    relationsIncoming: incoming,
    events: eventCount,
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

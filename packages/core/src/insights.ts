import { z } from "zod";

/**
 * Company-intelligence contracts shared by the API, CLI and MCP server.
 *
 * Relations are stored once as a directed edge with a canonical `type`. The
 * inverse labels (`owned_by`, `buys_from`, ...) are derived when reading, so
 * the same relationship is never stored twice.
 */
export const RelationTypeSchema = z.enum([
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
]);
export type RelationType = z.infer<typeof RelationTypeSchema>;

/** Canonical types plus the labels derived for incoming edges. */
export const RelationLabelSchema = z.enum([
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
  "owned_by",
  "subsidiary_of",
  "invested_by",
]);
export type RelationLabel = z.infer<typeof RelationLabelSchema>;

export const RelationStatusSchema = z.enum([
  "reported",
  "inferred",
  "verified",
  "rejected",
]);
export type RelationStatus = z.infer<typeof RelationStatusSchema>;

export const RelationDirectionSchema = z.enum(["outgoing", "incoming", "both"]);
export type RelationDirection = z.infer<typeof RelationDirectionSchema>;

export const PeriodKindSchema = z.enum(["annual", "quarter", "half", "ttm"]);
export type PeriodKind = z.infer<typeof PeriodKindSchema>;

export const ReviewKindSchema = z.enum(["fact", "relation"]);
export type ReviewKind = z.infer<typeof ReviewKindSchema>;

export const ReviewStatusSchema = z.enum([
  "pending",
  "accepted",
  "rejected",
]);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

const INVERSE_LABEL: Partial<Record<RelationType, RelationLabel>> = {
  owns: "owned_by",
  parent_of: "subsidiary_of",
  invests_in: "invested_by",
  supplies: "buys_from",
  buys_from: "supplies",
  licenses_to: "licenses_from",
  licenses_from: "licenses_to",
};

/** Label for an edge as seen from the company the caller asked about. */
export function relationLabel(
  type: RelationType,
  direction: "outgoing" | "incoming",
): RelationLabel {
  if (direction === "outgoing") return type;
  return INVERSE_LABEL[type] ?? type;
}

export interface SourceRefView {
  id: string;
  url: string;
  title?: string;
  trustTier?: string;
}

export interface FinancialFactView {
  id: string;
  companyId: string;
  statement: string;
  item: string;
  periodKind: PeriodKind;
  periodLabel?: string;
  periodStart?: string;
  periodEnd: string;
  fiscalYear?: number;
  fiscalQuarter?: number;
  value: number;
  unit: string;
  currency?: string;
  method: string;
  confidence?: number;
  quote?: string;
  sourceRefs: number[];
  source?: SourceRefView;
}

export interface CompanyFactView {
  id: string;
  companyId: string;
  predicate: string;
  value: unknown;
  method: string;
  confidence?: number;
  observedAt?: string;
  quote?: string;
  sourceRefs: number[];
  source?: SourceRefView;
}

export interface CompanyTickerView {
  ticker: string;
  exchange: string;
  currency?: string;
}

export interface CompanySummary {
  id: string;
  slug: string;
  displayName: string;
  legalName?: string;
  tickers: CompanyTickerView[];
}

export interface RelationEvidenceView {
  sourceId?: string;
  url?: string;
  title?: string;
  trustTier?: string;
  quote?: string;
  publishedAt?: string;
}

export interface RelationView {
  id: string;
  src: CompanySummary;
  dst: CompanySummary;
  /** Canonical stored type. */
  type: RelationType;
  /** `type` or its inverse, relative to the queried company. */
  label: RelationLabel;
  direction: "outgoing" | "incoming";
  status: RelationStatus;
  confidence?: number;
  amount?: number;
  currency?: string;
  validFrom?: string;
  validTo?: string;
  evidence: RelationEvidenceView[];
}

export interface NewsEventView {
  id: string;
  companyId: string;
  kind: "news" | "profile_event";
  date?: string;
  title: string;
  summary?: string;
  quote?: string;
  source?: SourceRefView;
}

export interface CompanyProfileView {
  id: string;
  slug: string;
  legalName: string;
  displayName: string;
  country?: string;
  website?: string;
  coverageTier: string;
  description?: string;
  sector?: string;
  aliases: string[];
  tickers: CompanyTickerView[];
  indices: string[];
}

export interface CompanyCounts {
  financials: number;
  facts: number;
  relationsOutgoing: number;
  relationsIncoming: number;
  events: number;
}

export interface CompanyCard {
  company: CompanyProfileView;
  counts: CompanyCounts;
  financials?: FinancialFactView[];
  facts?: CompanyFactView[];
  relations?: {
    outgoing: RelationView[];
    incoming: RelationView[];
  };
  events?: NewsEventView[];
}

export interface ReviewItemView {
  id: string;
  kind: ReviewKind;
  payload: unknown;
  evidence?: unknown;
  status: ReviewStatus;
  reviewer?: string;
  dedupeKey?: string;
  createdAt: string;
  updatedAt?: string;
}

const includeSection = z.enum(["financials", "facts", "relations", "events"]);
export type IncludeSection = z.infer<typeof includeSection>;

const includeList = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    return value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  },
  z.array(includeSection).optional(),
);

/** Query for `GET /v1/companies/:id`. Omitted `include` returns every block. */
export const CompanyCardQuerySchema = z.object({
  include: includeList,
  financial_limit: z.coerce.number().int().min(1).max(200).default(20),
  fact_limit: z.coerce.number().int().min(1).max(200).default(30),
  relation_limit: z.coerce.number().int().min(1).max(200).default(20),
  event_limit: z.coerce.number().int().min(1).max(100).default(10),
  relation_status: RelationStatusSchema.optional(),
});
export type CompanyCardQuery = z.infer<typeof CompanyCardQuerySchema>;

export const ReviewQueueQuerySchema = z.object({
  status: ReviewStatusSchema.optional(),
  kind: ReviewKindSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ReviewQueueQuery = z.infer<typeof ReviewQueueQuerySchema>;

export const ReviewProposalSchema = z.object({
  kind: ReviewKindSchema,
  payload: z.record(z.string(), z.unknown()),
  evidence: z.record(z.string(), z.unknown()).optional(),
  idempotency_key: z.string().trim().min(1).max(200).optional(),
});
export type ReviewProposal = z.infer<typeof ReviewProposalSchema>;

/** A human decision on one queue item. Only `pending` items can transition. */
export const ReviewDecisionSchema = z.object({
  decision: z.enum(["accepted", "rejected"]),
  reviewer: z.string().trim().min(1).max(120).optional(),
});
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

/**
 * Batch decision. A filter is mandatory: either explicit ids, a kind/company
 * filter, or `all: true`. This prevents an accidental empty-filter approval.
 */
export const ReviewBatchDecisionSchema = ReviewDecisionSchema.extend({
  ids: z.array(z.string().trim().min(1)).min(1).max(500).optional(),
  kind: ReviewKindSchema.optional(),
  company: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  all: z.boolean().default(false),
});
export type ReviewBatchDecision = z.infer<typeof ReviewBatchDecisionSchema>;

export interface ReviewBatchResult {
  updated: number;
  skipped: number;
  items: ReviewItemView[];
}

export interface CompanyCardResponse {
  data: CompanyCard;
  meta: {
    request_id: string;
    as_of: string;
    took_ms: number;
    company_ref: string;
    include: IncludeSection[];
  };
}

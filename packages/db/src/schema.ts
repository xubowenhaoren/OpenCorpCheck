import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const companies = pgTable(
  "companies",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    legalName: text("legal_name").notNull(),
    displayName: text("display_name").notNull(),
    country: text("country"),
    website: text("website"),
    coverageTier: text("coverage_tier").notNull().default("stub"),
    description: text("description"),
    sector: text("sector"),
    marketCapBucket: text("market_cap_bucket"),
    /**
     * True when the company exists only in the synthetic development corpus.
     * Search excludes these rows unless `include_fixtures=true`; a real ingest
     * flips the flag off so the entity stays visible.
     */
    isFixture: boolean("is_fixture").notNull().default(false),
    profile: jsonb("profile")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("companies_slug_uq").on(table.slug),
    index("companies_display_name_trgm_idx").using(
      "gin",
      sql`${table.displayName} gin_trgm_ops`,
    ),
    index("companies_legal_name_trgm_idx").using(
      "gin",
      sql`${table.legalName} gin_trgm_ops`,
    ),
  ],
);

export const companyIds = pgTable(
  "company_ids",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    idType: text("id_type").notNull(),
    idValue: text("id_value").notNull(),
  },
  (table) => [
    uniqueIndex("company_ids_type_value_uq").on(table.idType, table.idValue),
    index("company_ids_company_idx").on(table.companyId),
    index("company_ids_value_trgm_idx").using(
      "gin",
      sql`${table.idValue} gin_trgm_ops`,
    ),
  ],
);

export const aliases = pgTable(
  "aliases",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    lang: text("lang").notNull().default("und"),
    pinyin: text("pinyin"),
    initials: text("initials"),
    kind: text("kind").notNull().default("brand"),
  },
  (table) => [
    uniqueIndex("aliases_company_alias_lang_uq").on(
      table.companyId,
      table.alias,
      table.lang,
    ),
    index("aliases_company_idx").on(table.companyId),
    index("aliases_alias_trgm_idx").using(
      "gin",
      sql`${table.alias} gin_trgm_ops`,
    ),
  ],
);

export const securities = pgTable(
  "securities",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    ticker: text("ticker").notNull(),
    exchange: text("exchange").notNull(),
    currency: text("currency"),
    status: text("status").notNull().default("listed"),
  },
  (table) => [
    uniqueIndex("securities_ticker_exchange_uq").on(
      table.ticker,
      table.exchange,
    ),
    index("securities_company_idx").on(table.companyId),
  ],
);

export const indexMemberships = pgTable(
  "index_memberships",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    indexCode: text("index_code").notNull(),
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    weight: numeric("weight", { precision: 12, scale: 8, mode: "number" }),
    asOf: date("as_of", { mode: "string" }).notNull(),
    sourceId: text("source_id"),
  },
  (table) => [
    uniqueIndex("index_memberships_uq").on(
      table.indexCode,
      table.companyId,
      table.asOf,
    ),
    index("index_memberships_company_idx").on(table.companyId),
  ],
);

export const sources = pgTable(
  "sources",
  {
    id: text("id").primaryKey(),
    url: text("url").notNull(),
    canonicalUrl: text("canonical_url"),
    domain: text("domain"),
    title: text("title"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    httpStatus: integer("http_status"),
    contentHash: text("content_hash"),
    trustTier: text("trust_tier").notNull().default("secondary"),
    license: text("license"),
    robotsOk: boolean("robots_ok"),
  },
  (table) => [
    index("sources_domain_idx").on(table.domain),
    index("sources_content_hash_idx").on(table.contentHash),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").references(() => sources.id, {
      onDelete: "set null",
    }),
    companyId: text("company_id").references(() => companies.id, {
      onDelete: "cascade",
    }),
    docType: text("doc_type").notNull().default("other"),
    mime: text("mime"),
    storageKey: text("storage_key"),
    sha256: text("sha256"),
    language: text("language"),
    pageCount: integer("page_count"),
    extractorVersion: text("extractor_version"),
    title: text("title"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /** Synthetic fixture document; hidden from default search. */
    isFixture: boolean("is_fixture").notNull().default(false),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("documents_company_idx").on(table.companyId),
    index("documents_source_idx").on(table.sourceId),
    index("documents_type_idx").on(table.docType),
  ],
);

export const chunks = pgTable(
  "chunks",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    companyId: text("company_id").references(() => companies.id, {
      onDelete: "cascade",
    }),
    ordinal: integer("ordinal").notNull().default(0),
    page: integer("page"),
    section: text("section"),
    text: text("text").notNull(),
    tokenCount: integer("token_count"),
    qdrantPointId: text("qdrant_point_id"),
    embeddingVersion: text("embedding_version"),
  },
  (table) => [
    uniqueIndex("chunks_document_ordinal_uq").on(
      table.documentId,
      table.ordinal,
    ),
    index("chunks_company_idx").on(table.companyId),
  ],
);

export const facts = pgTable(
  "facts",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    predicate: text("predicate").notNull(),
    value: jsonb("value").$type<unknown>().notNull(),
    sourceId: text("source_id").references(() => sources.id, {
      onDelete: "set null",
    }),
    quote: text("quote"),
    method: text("method").notNull().default("llm_web"),
    confidence: numeric("confidence", {
      precision: 4,
      scale: 3,
      mode: "number",
    }),
    extractorVersion: text("extractor_version"),
    /** Citation numbers from the source section, e.g. [10, 12]. */
    sourceRefs: jsonb("source_refs")
      .$type<number[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validTo: timestamp("valid_to", { withTimezone: true }),
  },
  (table) => [index("facts_company_predicate_idx").on(table.companyId, table.predicate)],
);

export const financialFacts = pgTable(
  "financial_facts",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    statement: text("statement").notNull(),
    item: text("item").notNull(),
    periodStart: date("period_start", { mode: "string" }),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    /** annual | quarter | half | ttm */
    periodKind: text("period_kind").notNull().default("annual"),
    /** Raw label from the profile table, e.g. "Q3 FY2026". */
    periodLabel: text("period_label"),
    fiscalYear: integer("fiscal_year"),
    fiscalQuarter: integer("fiscal_quarter"),
    value: numeric("value", { precision: 28, scale: 6, mode: "number" }).notNull(),
    unit: text("unit").notNull().default("currency"),
    currency: text("currency"),
    sourceId: text("source_id").references(() => sources.id, {
      onDelete: "set null",
    }),
    page: integer("page"),
    quote: text("quote"),
    method: text("method").notNull().default("llm_web"),
    confidence: numeric("confidence", {
      precision: 4,
      scale: 3,
      mode: "number",
    }),
    extractorVersion: text("extractor_version"),
    sourceRefs: jsonb("source_refs")
      .$type<number[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
  },
  (table) => [
    uniqueIndex("financial_facts_uq").on(
      table.companyId,
      table.statement,
      table.item,
      table.periodEnd,
    ),
    index("financial_facts_company_idx").on(table.companyId),
    index("financial_facts_company_kind_idx").on(
      table.companyId,
      table.periodKind,
      table.fiscalYear,
    ),
  ],
);

export const products = pgTable(
  "products",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    category: text("category"),
    description: text("description"),
    pricingModel: text("pricing_model"),
    sourceId: text("source_id").references(() => sources.id, {
      onDelete: "set null",
    }),
  },
  (table) => [index("products_company_idx").on(table.companyId)],
);

export const relations = pgTable(
  "relations",
  {
    id: text("id").primaryKey(),
    srcCompanyId: text("src_company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    dstCompanyId: text("dst_company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    status: text("status").notNull().default("reported"),
    amount: numeric("amount", { precision: 28, scale: 6, mode: "number" }),
    currency: text("currency"),
    validFrom: date("valid_from", { mode: "string" }),
    validTo: date("valid_to", { mode: "string" }),
    confidence: numeric("confidence", {
      precision: 4,
      scale: 3,
      mode: "number",
    }),
    extractorVersion: text("extractor_version"),
    reviewId: text("review_id").references(() => reviewQueue.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    index("relations_src_idx").on(table.srcCompanyId),
    index("relations_dst_idx").on(table.dstCompanyId),
    index("relations_type_idx").on(table.type),
    index("relations_status_idx").on(table.status),
  ],
);

export const relationEvidence = pgTable(
  "relation_evidence",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    relationId: text("relation_id")
      .notNull()
      .references(() => relations.id, { onDelete: "cascade" }),
    sourceId: text("source_id").references(() => sources.id, {
      onDelete: "set null",
    }),
    quote: text("quote"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => [
    index("relation_evidence_relation_idx").on(table.relationId),
    uniqueIndex("relation_evidence_uq").on(
      table.relationId,
      table.sourceId,
      sql`md5(coalesce(${table.quote}, ''))`,
    ),
  ],
);

export const reviewQueue = pgTable(
  "review_queue",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    evidence: jsonb("evidence").$type<unknown>(),
    status: text("status").notNull().default("pending"),
    reviewer: text("reviewer"),
    /** Stable key so repeated extraction does not spam the queue. */
    dedupeKey: text("dedupe_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("review_queue_status_idx").on(table.status),
    index("review_queue_kind_status_idx").on(table.kind, table.status),
    uniqueIndex("review_queue_dedupe_uq")
      .on(table.dedupeKey)
      .where(sql`${table.dedupeKey} IS NOT NULL`),
  ],
);

export const outbox = pgTable(
  "outbox",
  {
    id: text("id").primaryKey(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    op: text("op").notNull(),
    payload: jsonb("payload").$type<unknown>(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("outbox_pending_idx").on(table.processedAt)],
);

/** Per-company extraction checkpoint (deterministic stage and LLM stage). */
export const extractionCache = pgTable(
  "extraction_cache",
  {
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** deterministic | relations */
    stage: text("stage").notNull(),
    inputSha256: text("input_sha256").notNull(),
    promptHash: text("prompt_hash"),
    model: text("model"),
    /** ok | partial | failed */
    status: text("status").notNull(),
    stats: jsonb("stats")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    error: text("error"),
    tokensInput: integer("tokens_input").notNull().default(0),
    tokensOutput: integer("tokens_output").notNull().default(0),
    durationMs: integer("duration_ms"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.companyId, table.stage] })],
);

export const schema = {
  companies,
  companyIds,
  aliases,
  securities,
  indexMemberships,
  sources,
  documents,
  chunks,
  facts,
  financialFacts,
  products,
  relations,
  relationEvidence,
  reviewQueue,
  outbox,
};

-- OpenCorpCheck core data model (P2)
-- Postgres 17. pg_trgm powers fast fuzzy company-name lookup; hybrid search
-- itself lives in Qdrant.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS companies (
  id text PRIMARY KEY,
  slug text NOT NULL,
  legal_name text NOT NULL,
  display_name text NOT NULL,
  country text,
  website text,
  coverage_tier text NOT NULL DEFAULT 'stub',
  description text,
  sector text,
  market_cap_bucket text,
  profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS companies_slug_uq ON companies (slug);
CREATE INDEX IF NOT EXISTS companies_display_name_trgm_idx
  ON companies USING gin (display_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS companies_legal_name_trgm_idx
  ON companies USING gin (legal_name gin_trgm_ops);

CREATE TABLE IF NOT EXISTS company_ids (
  id bigserial PRIMARY KEY,
  company_id text NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  id_type text NOT NULL,
  id_value text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS company_ids_type_value_uq
  ON company_ids (id_type, id_value);
CREATE INDEX IF NOT EXISTS company_ids_company_idx ON company_ids (company_id);
CREATE INDEX IF NOT EXISTS company_ids_value_trgm_idx
  ON company_ids USING gin (id_value gin_trgm_ops);

CREATE TABLE IF NOT EXISTS aliases (
  id bigserial PRIMARY KEY,
  company_id text NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  alias text NOT NULL,
  lang text NOT NULL DEFAULT 'und',
  pinyin text,
  initials text,
  kind text NOT NULL DEFAULT 'brand'
);
CREATE UNIQUE INDEX IF NOT EXISTS aliases_company_alias_lang_uq
  ON aliases (company_id, alias, lang);
CREATE INDEX IF NOT EXISTS aliases_company_idx ON aliases (company_id);
CREATE INDEX IF NOT EXISTS aliases_alias_trgm_idx
  ON aliases USING gin (alias gin_trgm_ops);

CREATE TABLE IF NOT EXISTS securities (
  id bigserial PRIMARY KEY,
  company_id text NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  ticker text NOT NULL,
  exchange text NOT NULL,
  currency text,
  status text NOT NULL DEFAULT 'listed'
);
CREATE UNIQUE INDEX IF NOT EXISTS securities_ticker_exchange_uq
  ON securities (ticker, exchange);
CREATE INDEX IF NOT EXISTS securities_company_idx ON securities (company_id);

CREATE TABLE IF NOT EXISTS index_memberships (
  id bigserial PRIMARY KEY,
  index_code text NOT NULL,
  company_id text NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  weight numeric(12, 8),
  as_of date NOT NULL,
  source_id text
);
CREATE UNIQUE INDEX IF NOT EXISTS index_memberships_uq
  ON index_memberships (index_code, company_id, as_of);
CREATE INDEX IF NOT EXISTS index_memberships_company_idx
  ON index_memberships (company_id);

CREATE TABLE IF NOT EXISTS sources (
  id text PRIMARY KEY,
  url text NOT NULL,
  canonical_url text,
  domain text,
  title text,
  fetched_at timestamptz,
  http_status integer,
  content_hash text,
  trust_tier text NOT NULL DEFAULT 'secondary',
  license text,
  robots_ok boolean
);
CREATE INDEX IF NOT EXISTS sources_domain_idx ON sources (domain);
CREATE INDEX IF NOT EXISTS sources_content_hash_idx ON sources (content_hash);

CREATE TABLE IF NOT EXISTS documents (
  id text PRIMARY KEY,
  source_id text REFERENCES sources(id) ON DELETE SET NULL,
  company_id text REFERENCES companies(id) ON DELETE CASCADE,
  doc_type text NOT NULL DEFAULT 'other',
  mime text,
  storage_key text,
  sha256 text,
  language text,
  page_count integer,
  extractor_version text,
  title text,
  published_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_company_idx ON documents (company_id);
CREATE INDEX IF NOT EXISTS documents_source_idx ON documents (source_id);
CREATE INDEX IF NOT EXISTS documents_type_idx ON documents (doc_type);

CREATE TABLE IF NOT EXISTS chunks (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  company_id text REFERENCES companies(id) ON DELETE CASCADE,
  ordinal integer NOT NULL DEFAULT 0,
  page integer,
  section text,
  text text NOT NULL,
  token_count integer,
  qdrant_point_id text,
  embedding_version text
);
CREATE UNIQUE INDEX IF NOT EXISTS chunks_document_ordinal_uq
  ON chunks (document_id, ordinal);
CREATE INDEX IF NOT EXISTS chunks_company_idx ON chunks (company_id);

CREATE TABLE IF NOT EXISTS facts (
  id text PRIMARY KEY,
  company_id text NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  predicate text NOT NULL,
  value jsonb NOT NULL,
  source_id text REFERENCES sources(id) ON DELETE SET NULL,
  quote text,
  method text NOT NULL DEFAULT 'llm_web',
  confidence numeric(4, 3),
  observed_at timestamptz,
  valid_from timestamptz,
  valid_to timestamptz
);
CREATE INDEX IF NOT EXISTS facts_company_predicate_idx
  ON facts (company_id, predicate);

CREATE TABLE IF NOT EXISTS financial_facts (
  id text PRIMARY KEY,
  company_id text NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  statement text NOT NULL,
  item text NOT NULL,
  period_start date,
  period_end date NOT NULL,
  fiscal_year integer,
  fiscal_quarter integer,
  value numeric(28, 6) NOT NULL,
  unit text NOT NULL DEFAULT 'currency',
  currency text,
  source_id text REFERENCES sources(id) ON DELETE SET NULL,
  page integer,
  quote text,
  method text NOT NULL DEFAULT 'llm_web',
  confidence numeric(4, 3)
);
CREATE UNIQUE INDEX IF NOT EXISTS financial_facts_uq
  ON financial_facts (company_id, statement, item, period_end);
CREATE INDEX IF NOT EXISTS financial_facts_company_idx
  ON financial_facts (company_id);

CREATE TABLE IF NOT EXISTS products (
  id text PRIMARY KEY,
  company_id text NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text,
  description text,
  pricing_model text,
  source_id text REFERENCES sources(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS products_company_idx ON products (company_id);

CREATE TABLE IF NOT EXISTS relations (
  id text PRIMARY KEY,
  src_company_id text NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  dst_company_id text NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type text NOT NULL,
  status text NOT NULL DEFAULT 'reported',
  amount numeric(28, 6),
  currency text,
  valid_from date,
  valid_to date,
  confidence numeric(4, 3)
);
CREATE INDEX IF NOT EXISTS relations_src_idx ON relations (src_company_id);
CREATE INDEX IF NOT EXISTS relations_dst_idx ON relations (dst_company_id);
CREATE INDEX IF NOT EXISTS relations_type_idx ON relations (type);

CREATE TABLE IF NOT EXISTS relation_evidence (
  id bigserial PRIMARY KEY,
  relation_id text NOT NULL REFERENCES relations(id) ON DELETE CASCADE,
  source_id text REFERENCES sources(id) ON DELETE SET NULL,
  quote text,
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS relation_evidence_relation_idx
  ON relation_evidence (relation_id);

CREATE TABLE IF NOT EXISTS review_queue (
  id text PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  evidence jsonb,
  status text NOT NULL DEFAULT 'pending',
  reviewer text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS review_queue_status_idx ON review_queue (status);

CREATE TABLE IF NOT EXISTS outbox (
  id text PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  op text NOT NULL,
  payload jsonb,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox (processed_at);

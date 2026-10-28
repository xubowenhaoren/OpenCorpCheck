-- P3: structured company insights extracted from research sections.
-- Additive only: existing rows get safe defaults.

ALTER TABLE financial_facts
  ADD COLUMN period_kind text NOT NULL DEFAULT 'annual'
    CHECK (period_kind IN ('annual', 'quarter', 'half', 'ttm')),
  ADD COLUMN period_label text,
  ADD COLUMN extractor_version text,
  ADD COLUMN source_refs jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS financial_facts_company_kind_idx
  ON financial_facts (company_id, period_kind, fiscal_year);

ALTER TABLE facts
  ADD COLUMN extractor_version text,
  ADD COLUMN source_refs jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE review_queue
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN dedupe_key text;

CREATE UNIQUE INDEX IF NOT EXISTS review_queue_dedupe_uq
  ON review_queue (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS review_queue_kind_status_idx
  ON review_queue (kind, status);

ALTER TABLE relations
  ADD COLUMN extractor_version text,
  ADD COLUMN review_id text REFERENCES review_queue(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS relations_status_idx ON relations (status);

CREATE UNIQUE INDEX IF NOT EXISTS relation_evidence_uq
  ON relation_evidence (relation_id, source_id, md5(coalesce(quote, '')));

CREATE TABLE IF NOT EXISTS extraction_cache (
  company_id text NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN ('deterministic', 'relations')),
  input_sha256 text NOT NULL,
  prompt_hash text,
  model text,
  status text NOT NULL CHECK (status IN ('ok', 'partial', 'failed')),
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  tokens_input integer NOT NULL DEFAULT 0,
  tokens_output integer NOT NULL DEFAULT 0,
  duration_ms integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, stage)
);

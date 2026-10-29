-- Runtime job tables shared by the API and worker.
--
-- These were originally created lazily by the worker (`apps/worker/src/db.ts`).
-- The API now enqueues agent research directly, so `occ migrate` must create
-- them as well. Every statement is idempotent; the worker keeps its own copy
-- for databases that never run the migration CLI.

CREATE TABLE IF NOT EXISTS backfill_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('research', 'f10', 'news')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed')),
  total_jobs integer NOT NULL DEFAULT 0,
  completed_jobs integer NOT NULL DEFAULT 0,
  failed_jobs integer NOT NULL DEFAULT 0,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Older databases only allowed research/f10.
ALTER TABLE backfill_runs DROP CONSTRAINT IF EXISTS backfill_runs_kind_check;
ALTER TABLE backfill_runs ADD CONSTRAINT backfill_runs_kind_check
  CHECK (kind IN ('research', 'f10', 'news'));

CREATE TABLE IF NOT EXISTS backfill_jobs (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES backfill_runs(id) ON DELETE CASCADE,
  queue text NOT NULL,
  job_key text NOT NULL,
  company_id text NOT NULL,
  page text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'active', 'completed', 'failed', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  duration_ms integer,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, queue, job_key)
);

CREATE INDEX IF NOT EXISTS backfill_jobs_run_status_idx
  ON backfill_jobs (run_id, status);
CREATE INDEX IF NOT EXISTS backfill_jobs_key_idx
  ON backfill_jobs (job_key);

ALTER TABLE backfill_jobs ADD COLUMN IF NOT EXISTS duration_ms integer;

CREATE TABLE IF NOT EXISTS research_cache (
  company_id text PRIMARY KEY,
  prompt_hash text NOT NULL,
  section_sha256 text NOT NULL,
  section_path text NOT NULL,
  model text NOT NULL,
  tokens_input integer NOT NULL DEFAULT 0,
  tokens_output integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS f10_pages (
  market text NOT NULL,
  code text NOT NULL,
  page text NOT NULL,
  fetched_at timestamptz NOT NULL,
  http_status integer,
  text_chars integer NOT NULL DEFAULT 0,
  table_count integer NOT NULL DEFAULT 0,
  html_sha256 text,
  storage_key text,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (market, code, page)
);

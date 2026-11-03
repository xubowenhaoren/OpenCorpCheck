-- P1.5 daily company-data / financial-report refresh.
--
-- `company_filing_state` is the per-(company, source) cursor + lease, modelled
-- on `global_news_last_update`. It is state, not a registry: the sweep derives
-- candidate sources from securities/identifiers and rows are created lazily on
-- the first claim.
--
-- `filings` is the deterministic detection inbox. It is NOT the user-facing
-- document store: a detected filing is ingested into `documents`
-- (`doc_type='filing'`) by `ingest.filing`, exactly as P1.4 does. Keeping the
-- inbox separate lets the daily sweep diff by accession without re-reading
-- documents.
CREATE TABLE IF NOT EXISTS company_filing_state (
  company_id           text NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source               text NOT NULL,              -- edgar | cninfo | hkexnews | f10
  market               text NOT NULL,              -- A | HK | US
  code                 text,                       -- ticker/cik the adapter uses
  cursor               text,                       -- newest external id / F10 content hash
  last_checked_at      timestamptz,                -- last successful check
  last_changed_at      timestamptz,                -- last check that found a new filing
  last_run_id          text,
  last_status          text NOT NULL DEFAULT 'never'
    CHECK (last_status IN ('never', 'ok', 'changed', 'empty', 'failed', 'paused')),
  last_error           text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_enqueued_at     timestamptz,                -- lease start
  next_due_at          timestamptz,                -- lease while claimed, then schedule
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, source)
);

CREATE INDEX IF NOT EXISTS company_filing_state_due_idx
  ON company_filing_state (next_due_at);
CREATE INDEX IF NOT EXISTS company_filing_state_status_idx
  ON company_filing_state (last_status);

CREATE TABLE IF NOT EXISTS filings (
  id             text PRIMARY KEY,
  company_id     text NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source         text NOT NULL,
  accession      text NOT NULL,                    -- accession / announcement id / PDF URL
  title          text NOT NULL,
  form           text,
  category       text,
  filed_at       timestamptz,
  period_end     date,
  periodic       boolean NOT NULL DEFAULT false,
  period_kind    text CHECK (period_kind IN ('annual', 'half', 'quarter')),
  url            text NOT NULL,
  pdf_url        text,
  content_hash   text,
  status         text NOT NULL DEFAULT 'detected'
    CHECK (status IN ('detected', 'fetched', 'parsed', 'applied', 'failed')),
  error          text,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  detected_at    timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, accession)
);

CREATE INDEX IF NOT EXISTS filings_company_filed_idx
  ON filings (company_id, filed_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS filings_company_periodic_idx
  ON filings (company_id, periodic, filed_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS filings_status_idx
  ON filings (status);

-- The company page's `filingRefresh.pending` watches the check and its
-- follow-ups by company id.
CREATE INDEX IF NOT EXISTS backfill_jobs_company_status_idx
  ON backfill_jobs (company_id, status);

-- P1.5 runs are `backfill_runs.kind='data'`; the producer is advisory-locked
-- and the checks are normal pg-boss jobs.
ALTER TABLE backfill_runs DROP CONSTRAINT IF EXISTS backfill_runs_kind_check;
ALTER TABLE backfill_runs ADD CONSTRAINT backfill_runs_kind_check
  CHECK (kind IN ('research', 'f10', 'news', 'financials', 'data'));

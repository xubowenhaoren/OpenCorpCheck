-- P1.5 follow-up: financials verification / retry.
--
-- `data.source.check` used to enqueue `financials.company` exactly once; an
-- A/HK company whose F10 structured statements lagged the announcement could
-- finish "successfully" without the new period, and nothing re-triggered it.
--
-- One row per company records the period the newest periodic filing expects,
-- plus a bounded retry schedule. The daily `data.sweep` catch-up pass selects
-- due `pending` rows; the financials job verifies `max(financial_facts
-- .period_end)` and either marks the row `applied` or schedules a retry.
CREATE TABLE IF NOT EXISTS financials_refresh_state (
  company_id          text PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  expected_period_end date NOT NULL,
  market              text NOT NULL,
  ticker              text NOT NULL,
  code                text NOT NULL,
  name                text,                       -- display name for the task dock
  source              text NOT NULL,              -- cninfo | hkexnews | edgar | f10
  filing_id           text REFERENCES filings(id) ON DELETE SET NULL,
  status              text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'applied', 'failed')),
  attempts            integer NOT NULL DEFAULT 0,
  last_error          text,
  next_retry_at       timestamptz,                -- lease while a catch-up is queued
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS financials_refresh_state_due_idx
  ON financials_refresh_state (status, next_retry_at);
CREATE INDEX IF NOT EXISTS financials_refresh_state_updated_idx
  ON financials_refresh_state (updated_at DESC);

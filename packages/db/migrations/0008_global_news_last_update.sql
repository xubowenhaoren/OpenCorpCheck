-- Automatic news refresh: per-company cursor/lease plus per-job result metadata.
--
-- `global_news_last_update` is the only per-company news cursor (decision 44).
-- It is state, not a registry: rows are created lazily by the sweep, so existing
-- companies need no backfill and the sweep source is `companies LEFT JOIN`.
ALTER TABLE backfill_jobs
  ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS global_news_last_update (
  key                  text PRIMARY KEY,          -- US:AAPL | A:600519 | HK:00700 | NAME:openai
  company_id           text NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  ticker               text,
  name                 text,
  last_update_at       timestamptz,               -- last successful check (incl. empty)
  newest_published_at  timestamptz,               -- newest article date seen; window hint
  last_run_id          text,
  last_status          text NOT NULL DEFAULT 'never', -- never | ok | empty | failed | paused
  last_inserted        integer NOT NULL DEFAULT 0,
  last_skipped         integer NOT NULL DEFAULT 0,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_enqueued_at     timestamptz,
  next_due_at          timestamptz,               -- lease while claimed, then schedule
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS global_news_company_uq
  ON global_news_last_update (company_id);
CREATE INDEX IF NOT EXISTS global_news_due_idx
  ON global_news_last_update (next_due_at);

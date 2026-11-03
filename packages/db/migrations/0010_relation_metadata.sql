-- Structured provenance for reported ownership edges (P1.3).
--
-- 13F holdings and HKEX DION notices carry information that does not fit
-- `amount`/`currency` alone: the reporting quarter, shares held, percentage,
-- CUSIP, filing accession and notice serial. Keep those in `metadata` instead
-- of overloading numeric columns. Existing rows get an empty object.
ALTER TABLE relations
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS relations_extractor_idx
  ON relations (extractor_version);

-- Last ownership sync report per market. Out-of-universe counterparties are
-- counted during a run, not stored as companies; keeping the run summary makes
-- `occ ownership coverage` able to report matched vs out-of-universe without
-- re-downloading the 13F data set or re-scraping DION.
CREATE TABLE IF NOT EXISTS ownership_sync_runs (
  id         text PRIMARY KEY,
  market     text NOT NULL,
  dataset    text,
  ran_at     timestamptz NOT NULL DEFAULT now(),
  applied    boolean NOT NULL DEFAULT false,
  stats      jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS ownership_sync_runs_market_idx
  ON ownership_sync_runs (market, ran_at DESC);

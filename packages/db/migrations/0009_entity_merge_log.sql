-- Deterministic entity-resolution audit trail (P1.2).
--
-- The merged company row is deleted, so `survivor_id` and `merged_id` are plain
-- text (no FK). `snapshot` keeps the pre-merge company + security/index/alias
-- rows so a merge can be inspected or reconstructed. A merge is only written
-- after the deterministic identifier check and always leaves evidence.
CREATE TABLE IF NOT EXISTS entity_merge_log (
  id           text PRIMARY KEY,
  survivor_id  text NOT NULL,
  merged_id    text NOT NULL,
  reason       text NOT NULL,
  evidence     jsonb NOT NULL DEFAULT '{}'::jsonb,
  snapshot     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS entity_merge_survivor_idx
  ON entity_merge_log (survivor_id);
CREATE INDEX IF NOT EXISTS entity_merge_created_idx
  ON entity_merge_log (created_at);

-- F10 structured relation extraction adds a third cache stage.
ALTER TABLE extraction_cache
  DROP CONSTRAINT IF EXISTS extraction_cache_stage_check;

ALTER TABLE extraction_cache
  ADD CONSTRAINT extraction_cache_stage_check
  CHECK (stage IN ('deterministic', 'relations', 'f10_relations'));

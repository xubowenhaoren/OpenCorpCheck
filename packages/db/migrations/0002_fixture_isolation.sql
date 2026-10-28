-- Isolate the synthetic development corpus from the visible research corpus.
--
-- `is_fixture` rows stay in Postgres/Qdrant for pipeline and E2E tests but are
-- excluded from search unless the caller passes `include_fixtures=true`.
ALTER TABLE companies ADD COLUMN is_fixture boolean NOT NULL DEFAULT false;
ALTER TABLE documents ADD COLUMN is_fixture boolean NOT NULL DEFAULT false;

-- Seed rows carry profile {fixture:true}; documents come from `fixture://`
-- sources. A company that already has a real research document is NOT a
-- fixture entity, even though it was first created by `occ seed`.
UPDATE companies SET is_fixture = true WHERE profile->>'fixture' = 'true';

UPDATE companies c SET is_fixture = false
WHERE EXISTS (
  SELECT 1
  FROM documents d
  JOIN sources s ON s.id = d.source_id
  WHERE d.company_id = c.id
    AND s.trust_tier <> 'fixture'
);

UPDATE documents d SET is_fixture = true
FROM sources s
WHERE d.source_id = s.id
  AND s.trust_tier = 'fixture';

CREATE INDEX companies_is_fixture_idx ON companies (is_fixture);
CREATE INDEX documents_is_fixture_idx ON documents (is_fixture);

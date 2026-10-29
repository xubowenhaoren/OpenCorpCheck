-- A fiscal-year end can also be the Q4 end (e.g. FY2026 and Q4 FY2026 both
-- end on 2026-07-31). Include period_kind in the natural key so both rows can
-- coexist without pretending one date means one period.

DROP INDEX IF EXISTS financial_facts_uq;

CREATE UNIQUE INDEX financial_facts_uq
  ON financial_facts (company_id, statement, item, period_end, period_kind);

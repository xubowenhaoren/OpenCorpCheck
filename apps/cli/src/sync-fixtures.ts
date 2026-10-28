import { pinyinAliasForms, pinyinVariants } from "@occ/ingest";
import { createDb, migrate } from "@occ/db";
import { QdrantClient } from "@occ/retrieval";
import { sql } from "drizzle-orm";

import { config } from "./config.js";

const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/;

export interface SyncFixturesResult {
  fixtureCompanies: number;
  fixtureDocuments: number;
  realCompanies: number;
  realDocuments: number;
  pinyinAliasesUpdated: number;
  pinyinAliasesInserted: number;
  companyPointsMarked: number;
  documentPointsMarked: number;
}

/**
 * Reconcile the fixture flags in Postgres and Qdrant.
 *
 * Existing corpora were built before `is_fixture` existed, so this command:
 *   1. re-derives company/document flags from sources and profile metadata;
 *   2. backfills pinyin/initials aliases for Chinese names;
 *   3. patches the Qdrant payloads so default search hides fixture rows.
 *
 * Safe to rerun; seeding/ingesting keeps the flags correct afterwards.
 */
export async function syncFixtures(
  options: { dryRun?: boolean } = {},
): Promise<SyncFixturesResult> {
  const applied = await migrate(config.databaseUrl);
  if (applied.length > 0) {
    console.log(JSON.stringify({ level: "info", msg: "migrations applied", applied }));
  }

  const { db, pool } = createDb(config.databaseUrl);
  const qdrant = new QdrantClient({
    url: config.qdrantUrl,
    apiKey: config.qdrantApiKey,
  });

  try {
    if (!options.dryRun) await reconcileFlags(db);

    const aliasStats = options.dryRun
      ? { updated: 0, inserted: 0 }
      : await backfillPinyinAliases(db);

    const counts = await fixtureCounts(db);

    let companyPointsMarked = 0;
    let documentPointsMarked = 0;
    if (!options.dryRun) {
      const fixtureCompanyIds = await idsOf(db, "companies", true);
      const allCompanyIds = await idsOf(db, "companies", false);
      const fixtureDocumentIds = await idsOf(db, "documents", true);
      const allDocumentIds = await idsOf(db, "documents", false);

      // Clear first, then mark: a point that used to be fixture-only and later
      // gained real research must be flipped back to false.
      if (allCompanyIds.length > 0) {
        await qdrant.setPayload(
          config.collections.companies,
          { is_fixture: false },
          { must: [{ key: "company_id", match: { any: allCompanyIds } }] },
        );
      }
      if (fixtureCompanyIds.length > 0) {
        await qdrant.setPayload(
          config.collections.companies,
          { is_fixture: true },
          { must: [{ key: "company_id", match: { any: fixtureCompanyIds } }] },
        );
      }
      companyPointsMarked = fixtureCompanyIds.length;

      if (allDocumentIds.length > 0) {
        await qdrant.setPayload(
          config.collections.documents,
          { is_fixture: false },
          { must: [{ key: "document_id", match: { any: allDocumentIds } }] },
        );
      }
      if (fixtureDocumentIds.length > 0) {
        await qdrant.setPayload(
          config.collections.documents,
          { is_fixture: true },
          { must: [{ key: "document_id", match: { any: fixtureDocumentIds } }] },
        );
      }
      documentPointsMarked = fixtureDocumentIds.length;
    }

    return {
      fixtureCompanies: counts.fixtureCompanies,
      fixtureDocuments: counts.fixtureDocuments,
      realCompanies: counts.realCompanies,
      realDocuments: counts.realDocuments,
      pinyinAliasesUpdated: aliasStats.updated,
      pinyinAliasesInserted: aliasStats.inserted,
      companyPointsMarked,
      documentPointsMarked,
    };
  } finally {
    await pool.end();
  }
}

type Db = ReturnType<typeof createDb>["db"];

async function reconcileFlags(db: Db): Promise<void> {
  // Seed companies carry profile {fixture:true}; a real research document
  // always wins and clears the flag.
  await db.execute(sql`
    UPDATE companies SET is_fixture = true
    WHERE profile->>'fixture' = 'true'
  `);
  await db.execute(sql`
    UPDATE companies c SET is_fixture = false
    WHERE EXISTS (
      SELECT 1
      FROM documents d
      JOIN sources s ON s.id = d.source_id
      WHERE d.company_id = c.id
        AND s.trust_tier <> 'fixture'
    )
  `);
  await db.execute(sql`
    UPDATE documents d SET is_fixture = true
    FROM sources s
    WHERE d.source_id = s.id
      AND s.trust_tier = 'fixture'
  `);
  await db.execute(sql`
    UPDATE documents d SET is_fixture = false
    FROM sources s
    WHERE d.source_id = s.id
      AND s.trust_tier <> 'fixture'
  `);
}

async function fixtureCounts(db: Db) {
  const rows = (
    await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM companies WHERE is_fixture) AS fixture_companies,
        (SELECT count(*)::int FROM companies WHERE NOT is_fixture) AS real_companies,
        (SELECT count(*)::int FROM documents WHERE is_fixture) AS fixture_documents,
        (SELECT count(*)::int FROM documents WHERE NOT is_fixture) AS real_documents
    `)
  ).rows as Array<Record<string, number>>;
  const row = rows[0] ?? {};
  return {
    fixtureCompanies: Number(row.fixture_companies ?? 0),
    realCompanies: Number(row.real_companies ?? 0),
    fixtureDocuments: Number(row.fixture_documents ?? 0),
    realDocuments: Number(row.real_documents ?? 0),
  };
}

async function idsOf(
  db: Db,
  table: "companies" | "documents",
  onlyFixtures: boolean,
): Promise<string[]> {
  const where = onlyFixtures ? sql`WHERE is_fixture` : sql``;
  const rows = (
    await db.execute(
      table === "companies"
        ? sql`SELECT id FROM companies ${where}`
        : sql`SELECT id FROM documents ${where}`,
    )
  ).rows as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

async function backfillPinyinAliases(
  db: Db,
): Promise<{ updated: number; inserted: number }> {
  const rows = (
    await db.execute(sql`
      SELECT id, company_id, alias
      FROM aliases
      WHERE pinyin IS NULL OR initials IS NULL
    `)
  ).rows as Array<{ id: number; company_id: string; alias: string }>;

  let updated = 0;
  let inserted = 0;
  for (const row of rows) {
    if (!CJK_RE.test(row.alias)) continue;
    const variants = pinyinVariants(row.alias);
    if (!variants) continue;
    await db.execute(sql`
      UPDATE aliases
      SET pinyin = ${variants.full}, initials = ${variants.initials}
      WHERE id = ${row.id}
    `);
    updated += 1;
    for (const form of pinyinAliasForms(row.alias)) {
      const result = await db.execute(sql`
        INSERT INTO aliases (company_id, alias, lang, kind)
        VALUES (${row.company_id}, ${form}, 'zh', 'pinyin')
        ON CONFLICT (company_id, alias, lang) DO NOTHING
        RETURNING id
      `);
      if (result.rows.length > 0) inserted += 1;
    }
  }
  return { updated, inserted };
}

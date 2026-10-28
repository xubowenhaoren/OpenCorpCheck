import { eq, inArray, or, sql } from "drizzle-orm";

import type { Db } from "../client.js";
import {
  aliases,
  companies,
  companyIds,
  financialFacts,
  indexMemberships,
  securities,
} from "../schema.js";

export const companiesTable = companies;

export type CompanyRow = typeof companies.$inferSelect;
export type AliasRow = typeof aliases.$inferSelect;
export type SecurityRow = typeof securities.$inferSelect;
export type IndexRow = typeof indexMemberships.$inferSelect;

export interface CompanyBundle {
  company: CompanyRow;
  aliases: AliasRow[];
  securities: SecurityRow[];
  indices: IndexRow[];
}

export type ExactMatchType = "identifier" | "alias" | "fuzzy";

export interface ExactCompanyMatch {
  companyId: string;
  matchType: ExactMatchType;
  score: number;
  matchedOn: string;
}

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows ?? [];
}

export async function getCompanyBundle(
  db: Db,
  idOrSlug: string,
): Promise<CompanyBundle | null> {
  const [row] = await db
    .select()
    .from(companies)
    .where(or(eq(companies.id, idOrSlug), eq(companies.slug, idOrSlug)))
    .limit(1);
  if (!row) return null;
  return (await getCompanyBundles(db, [row.id])).get(row.id) ?? null;
}

export async function getCompanyBundles(
  db: Db,
  ids: string[],
): Promise<Map<string, CompanyBundle>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const [companyRows, aliasRows, securityRows, indexRows] = await Promise.all([
    db.select().from(companies).where(inArray(companies.id, unique)),
    db.select().from(aliases).where(inArray(aliases.companyId, unique)),
    db.select().from(securities).where(inArray(securities.companyId, unique)),
    db
      .select()
      .from(indexMemberships)
      .where(inArray(indexMemberships.companyId, unique)),
  ]);
  const bundles = new Map<string, CompanyBundle>();
  for (const company of companyRows) {
    bundles.set(company.id, {
      company,
      aliases: [],
      securities: [],
      indices: [],
    });
  }
  for (const alias of aliasRows) bundles.get(alias.companyId)?.aliases.push(alias);
  for (const security of securityRows) {
    bundles.get(security.companyId)?.securities.push(security);
  }
  for (const membership of indexRows) {
    bundles.get(membership.companyId)?.indices.push(membership);
  }
  return bundles;
}

/**
 * Identifier → exact alias → trigram name/alias lookup, in that order.
 * This is the "planner" path that short-circuits hybrid search for queries
 * like "600519", "NVDA", "茅台" or "gzmt".
 */
export async function findExactCompanyMatches(
  db: Db,
  query: string,
  includeFixtures = false,
): Promise<ExactCompanyMatch[]> {
  const q = query.trim();
  if (!q) return [];
  const fixtureClause = includeFixtures
    ? sql``
    : sql`AND c.is_fixture = false`;
  const matches = new Map<string, ExactCompanyMatch>();
  const put = (match: ExactCompanyMatch) => {
    const previous = matches.get(match.companyId);
    if (!previous || previous.score < match.score) {
      matches.set(match.companyId, match);
    }
  };

  const identifierRows = rowsOf<{
    company_id: string;
    id_value: string;
  }>(
    await db.execute(sql`
      SELECT ci.company_id, ci.id_value
      FROM company_ids ci
      JOIN companies c ON c.id = ci.company_id
      WHERE lower(ci.id_value) = lower(${q})
        ${fixtureClause}
      LIMIT 10
    `),
  );
  for (const row of identifierRows) {
    put({
      companyId: row.company_id,
      matchType: "identifier",
      score: 1,
      matchedOn: row.id_value,
    });
  }

  const aliasRows = rowsOf<{ company_id: string; alias: string }>(
    await db.execute(sql`
      SELECT a.company_id, a.alias
      FROM aliases a
      JOIN companies c ON c.id = a.company_id
      WHERE lower(a.alias) = lower(${q})
        ${fixtureClause}
      LIMIT 10
    `),
  );
  for (const row of aliasRows) {
    put({
      companyId: row.company_id,
      matchType: "alias",
      score: 1,
      matchedOn: row.alias,
    });
  }

  // Fuzzy lookup only when nothing matched exactly. Otherwise a ticker query
  // such as "00700.HK" drags in unrelated HK tickers via shared trigrams.
  if (identifierRows.length === 0 && aliasRows.length === 0) {
    if (CJK_RE.test(q)) {
      // pg_trgm drops CJK characters entirely (it only indexes ASCII
      // trigrams), so "智谱AI" and "AI 芯片" look identical to it. Use a
      // CJK-aware character-bigram Dice coefficient instead.
      const aliasCandidates = rowsOf<{ company_id: string; alias: string }>(
        await db.execute(sql`
          SELECT a.company_id, a.alias
          FROM aliases a
          JOIN companies c ON c.id = a.company_id
          WHERE true ${fixtureClause}
          LIMIT 5000
        `),
      );
      for (const row of aliasCandidates) {
        const sim = cjkSimilarity(q, row.alias);
        if (sim < 0.3) continue;
        put({
          companyId: row.company_id,
          matchType: "fuzzy",
          score: Math.min(0.9, 0.6 + sim * 0.3),
          matchedOn: row.alias,
        });
      }
      const nameCandidates = rowsOf<{
        id: string;
        display_name: string;
        legal_name: string;
      }>(
        await db.execute(sql`
          SELECT c.id, c.display_name, c.legal_name
          FROM companies c
          WHERE true ${fixtureClause}
          LIMIT 5000
        `),
      );
      for (const row of nameCandidates) {
        const sim = Math.max(
          cjkSimilarity(q, row.display_name),
          cjkSimilarity(q, row.legal_name),
        );
        if (sim < 0.3) continue;
        put({
          companyId: row.id,
          matchType: "fuzzy",
          score: Math.min(0.9, 0.55 + sim * 0.35),
          matchedOn: row.display_name,
        });
      }
    } else {
      const aliasFuzzyRows = rowsOf<{
        company_id: string;
        alias: string;
        sim: number;
      }>(
        await db.execute(sql`
          SELECT a.company_id, a.alias, similarity(a.alias, ${q}) AS sim
          FROM aliases a
          JOIN companies c ON c.id = a.company_id
          WHERE a.alias % ${q}
            AND similarity(a.alias, ${q}) >= 0.5
            ${fixtureClause}
          ORDER BY sim DESC
          LIMIT 10
        `),
      );
      for (const row of aliasFuzzyRows) {
        put({
          companyId: row.company_id,
          matchType: "fuzzy",
          score: Math.min(0.9, 0.6 + Number(row.sim) * 0.3),
          matchedOn: row.alias,
        });
      }

      const nameFuzzyRows = rowsOf<{
        id: string;
        display_name: string;
        sim: number;
      }>(
        await db.execute(sql`
          SELECT c.id, c.display_name,
                 GREATEST(similarity(c.display_name, ${q}), similarity(c.legal_name, ${q})) AS sim
          FROM companies c
          WHERE (c.display_name % ${q} OR c.legal_name % ${q})
            AND GREATEST(similarity(c.display_name, ${q}), similarity(c.legal_name, ${q})) >= 0.5
            ${fixtureClause}
          ORDER BY sim DESC
          LIMIT 10
        `),
      );
      for (const row of nameFuzzyRows) {
        put({
          companyId: row.id,
          matchType: "fuzzy",
          score: Math.min(0.9, 0.55 + Number(row.sim) * 0.35),
          matchedOn: row.display_name,
        });
      }
    }
  }

  return [...matches.values()].sort((a, b) => b.score - a.score);
}

const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/;
const CJK_CHAR_RE = /[㐀-䶿一-鿿豈-﫿]/;

/**
 * Character-bigram Dice similarity for CJK strings. Bigrams must contain at
 * least one CJK character, so the shared "AI" in "AI 芯片" and "智谱AI" does
 * not count as evidence.
 */
export function cjkSimilarity(left: string, right: string): number {
  const a = cjkGrams(left);
  const b = cjkGrams(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

function cjkGrams(value: string): Set<string> {
  const chars = [...value.normalize("NFKC").toLowerCase().replace(/\s+/g, "")];
  const grams = new Set<string>();
  for (let index = 0; index < chars.length - 1; index += 1) {
    if (CJK_CHAR_RE.test(chars[index]) || CJK_CHAR_RE.test(chars[index + 1])) {
      grams.add(chars[index] + chars[index + 1]);
    }
  }
  return grams;
}

export async function getFinancialFacts(db: Db, companyId: string) {
  return db
    .select()
    .from(financialFacts)
    .where(eq(financialFacts.companyId, companyId))
    .limit(80);
}

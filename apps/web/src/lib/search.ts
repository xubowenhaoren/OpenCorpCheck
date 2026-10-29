import type { CompanyHit } from "@occ/core";

/**
 * Vector search always returns its nearest neighbours, even when the query is
 * a company that is not in the visible corpus. Without a guard, a Chinese query
 * like "宁德时代" (a fixture-only company in the current corpus) would show
 * unrelated US companies as confident matches.
 *
 * For short CJK queries with no exact/alias hit, require a minimum dense score.
 * Natural-language and category queries ("白酒", "做 GPU 的公司") score well
 * above this line, while unrelated nearest neighbours sit near 0.25–0.32.
 */
export function filterRelevantCompanyHits(
  hits: CompanyHit[],
  query: string,
): CompanyHit[] {
  const text = query.trim();
  if (!text) return hits;
  if (!/[㐀-鿿]/.test(text)) return hits;
  if (text.length > 8) return hits;
  const hasExact = hits.some(
    (hit) =>
      hit.matchType === "identifier" ||
      hit.matchType === "alias" ||
      hit.matchType === "fuzzy",
  );
  if (hasExact) return hits;
  const dense = hits[0]?.explain?.denseScore;
  if (dense !== undefined && dense < 0.35) return [];
  return hits;
}

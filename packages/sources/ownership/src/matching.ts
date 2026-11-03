import { normalizeName } from "@occ/sources-entity";

/**
 * Exact-name matching for ownership counterparties.
 *
 * 13F filers and DION shareholders are frequently legal entities whose names
 * differ only by a leading article or a legal suffix (`The Bank of New York
 * Mellon Corporation` vs `Bank of New York Mellon Corp`). We collapse those two
 * cosmetic differences and require an exact normalized hit; anything else is
 * reported as unmatched, never fuzzy-merged.
 */

/** Company names used to build the index, in priority order. */
export interface NameSource {
  companyId: string;
  names: string[];
}

export interface NameMatch {
  companyId?: string;
  /** True when several universe companies share the normalized name. */
  ambiguous: boolean;
}

/**
 * Build a normalized-name → company index. A name shared by several companies
 * is marked ambiguous (null) and never resolved.
 */
export function buildNameIndex(
  companies: NameSource[],
  options: { minLength?: number } = {},
): Map<string, string | null> {
  const minLength = options.minLength ?? 2;
  const owners = new Map<string, Set<string>>();
  for (const company of companies) {
    for (const name of company.names) {
      const key = normalizeMatchName(name);
      if (key.length < minLength) continue;
      const set = owners.get(key) ?? new Set<string>();
      set.add(company.companyId);
      owners.set(key, set);
    }
  }
  const index = new Map<string, string | null>();
  for (const [key, ids] of owners) {
    index.set(key, ids.size === 1 ? [...ids][0]! : null);
  }
  return index;
}

/** Exact normalized lookup; ambiguity is reported, never guessed. */
export function matchName(
  index: Map<string, string | null>,
  rawName: string,
): NameMatch {
  const key = normalizeMatchName(rawName);
  if (!key) return { ambiguous: false };
  const hit = index.get(key);
  if (hit === undefined) return { ambiguous: false };
  if (hit === null) return { ambiguous: true };
  return { companyId: hit, ambiguous: false };
}

/**
 * Cosmetic normalization only: legal suffix stripping from the entity package
 * plus a leading English article. Do not add fuzzy rules here.
 */
export function normalizeMatchName(value: string | null | undefined): string {
  return normalizeName((value ?? "").trim().replace(/^the\s+/i, ""));
}

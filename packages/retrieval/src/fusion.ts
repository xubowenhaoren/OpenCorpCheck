export interface RankedItem {
  id: string;
  score: number;
}

export interface FusedItem {
  id: string;
  score: number;
  ranks: number[];
}

export type FusionMethod = "rrf" | "dbsf";

/**
 * Reciprocal Rank Fusion. Ranks start at 1; `k` damps the tail.
 * This mirrors Qdrant's server-side RRF so the explain view and the fused
 * response agree.
 */
export function rrfFuse(lists: RankedItem[][], k = 60): FusedItem[] {
  const byId = new Map<string, FusedItem>();
  lists.forEach((list, listIndex) => {
    const seen = new Set<string>();
    list.forEach((item, index) => {
      if (seen.has(item.id)) return;
      seen.add(item.id);
      const entry =
        byId.get(item.id) ??
        ({ id: item.id, score: 0, ranks: new Array(lists.length).fill(0) } as FusedItem);
      entry.score += 1 / (k + index + 1);
      entry.ranks[listIndex] = index + 1;
      byId.set(item.id, entry);
    });
  });
  return [...byId.values()].sort((a, b) => b.score - a.score);
}

/**
 * Distribution-Based Score Fusion: normalize each branch by mean ± 3σ, then
 * average. Used when a caller explicitly selects DBSF.
 */
export function dbsfFuse(lists: RankedItem[][]): FusedItem[] {
  const byId = new Map<string, FusedItem>();
  lists.forEach((list, listIndex) => {
    if (list.length === 0) return;
    const scores = list.map((item) => item.score);
    const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length;
    const variance =
      scores.reduce((sum, value) => sum + (value - mean) ** 2, 0) / scores.length;
    const sigma = Math.sqrt(variance);
    const low = mean - 3 * sigma;
    const high = mean + 3 * sigma;
    const span = high - low || 1;
    list.forEach((item, index) => {
      const normalized = Math.max(0, Math.min(1, (item.score - low) / span));
      const entry =
        byId.get(item.id) ??
        ({ id: item.id, score: 0, ranks: new Array(lists.length).fill(0) } as FusedItem);
      entry.score += normalized;
      entry.ranks[listIndex] = index + 1;
      byId.set(item.id, entry);
    });
  });
  return [...byId.values()]
    .map((entry) => ({ ...entry, score: entry.score / Math.max(1, lists.length) }))
    .sort((a, b) => b.score - a.score);
}

export function fuse(
  lists: RankedItem[][],
  method: FusionMethod,
  k = 60,
): FusedItem[] {
  return method === "dbsf" ? dbsfFuse(lists) : rrfFuse(lists, k);
}

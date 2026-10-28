import { tokenize, type TokenizeOptions } from "./tokenizer.js";

export interface SparseVector {
  indices: number[];
  values: number[];
}

/** FNV-1a 32-bit; stable across processes and languages. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Encode text as a Qdrant sparse vector.
 *
 * Values are sublinear term frequencies, `1 + ln(tf)`; Qdrant's `idf`
 * collection modifier multiplies them by corpus IDF server-side, which gives
 * BM25-like behaviour without shipping corpus statistics to the client.
 */
export function encodeSparse(
  text: string,
  options: TokenizeOptions = {},
): SparseVector {
  return encodeTokens(tokenize(text, options));
}

export function encodeTokens(tokens: string[]): SparseVector {
  const counts = new Map<number, number>();
  for (const token of tokens) {
    const index = fnv1a32(token);
    counts.set(index, (counts.get(index) ?? 0) + 1);
  }
  const entries = [...counts.entries()]
    .map(([index, count]) => [index, 1 + Math.log(count)] as const)
    .sort((a, b) => a[0] - b[0]);
  return {
    indices: entries.map(([index]) => index),
    values: entries.map(([, value]) => Number(value.toFixed(6))),
  };
}

export function isSparseEmpty(vector: SparseVector): boolean {
  return vector.indices.length === 0;
}

/** Display helper: token → 32-bit index. */
export function explainTerms(tokens: string[]): Array<{ token: string; index: number }> {
  return tokens.map((token) => ({ token, index: fnv1a32(token) }));
}

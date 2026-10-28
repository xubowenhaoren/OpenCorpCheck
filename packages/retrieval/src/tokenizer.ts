import * as jieba from "jieba-wasm";
import stemmers from "snowball-stemmers";

const stemmer = stemmers.newStemmer("english");

const CJK_AT_START = /^[㐀-䶿一-鿿豈-﫿]+/u;
const LATIN_AT_START = /^[a-z0-9]+(?:['’-][a-z0-9]+)*/;
const PUNCT_ONLY = /^[\p{P}\p{S}\s]+$/u;

const STOPWORDS = new Set([
  "的",
  "了",
  "和",
  "与",
  "及",
  "在",
  "是",
  "有",
  "为",
  "对",
  "等",
  "中",
  "上",
  "下",
  "个",
  "也",
  "就",
  "都",
  "而",
  "被",
  "把",
  "这",
  "那",
  "the",
  "a",
  "an",
  "of",
  "and",
  "or",
  "to",
  "in",
  "for",
  "on",
  "with",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "by",
  "as",
  "at",
  "from",
  "that",
  "this",
  "it",
  "its",
  "we",
  "you",
  "they",
]);

export interface TokenizeOptions {
  minLength?: number;
}

/** NFKC + lowercase. Kept separate so search explain can show it. */
export function normalizeText(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Deterministic bilingual tokenizer.
 *
 * CJK runs go through jieba; Latin runs are lowercased and Porter2-stemmed.
 * Punctuation-only tokens and a small stopword list are dropped. The output is
 * stable across processes, which matters because sparse indices are persisted
 * in Qdrant.
 */
export function tokenize(input: string, options: TokenizeOptions = {}): string[] {
  const minLength = options.minLength ?? 1;
  const text = normalizeText(input);
  if (!text) return [];

  const tokens: string[] = [];
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);

    const cjk = CJK_AT_START.exec(rest);
    if (cjk) {
      for (const raw of jieba.cut_for_search(cjk[0], true)) {
        addToken(tokens, raw, minLength, false);
      }
      index += cjk[0].length;
      continue;
    }

    const latin = LATIN_AT_START.exec(rest);
    if (latin) {
      for (const raw of latin) {
        addToken(tokens, stemmer.stem(raw), minLength, true);
      }
      index += latin[0].length;
      continue;
    }

    index += 1;
  }
  return tokens;
}

function addToken(
  out: string[],
  raw: string,
  minLength: number,
  alreadyStemmed: boolean,
): void {
  const token = alreadyStemmed ? raw : normalizeText(raw);
  if (!token || token.length < minLength) return;
  if (PUNCT_ONLY.test(token)) return;
  if (STOPWORDS.has(token)) return;
  out.push(token);
}

/** Unique tokens in first-seen order (useful for explain output). */
export function tokenSet(input: string): string[] {
  return [...new Set(tokenize(input))];
}

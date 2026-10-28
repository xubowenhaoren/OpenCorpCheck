declare module "jieba-wasm" {
  export function cut(text: string, hmm?: boolean): string[];
  export function cut_for_search(text: string, hmm?: boolean): string[];
  export function add_word(word: string, freq?: number, tag?: string): void;
}

declare module "snowball-stemmers" {
  export interface Stemmer {
    stem(word: string): string;
  }
  const stemmers: {
    newStemmer(language: string): Stemmer;
  };
  export default stemmers;
}

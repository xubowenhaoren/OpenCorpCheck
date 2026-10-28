import { pinyin } from "pinyin-pro";

const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/;
const CORPORATE_SUFFIX_RE =
  /(股份有限公司|有限责任公司|有限公司|控股集团|集团|控股|公司)$/;

export interface PinyinVariants {
  /** Tone-less full pinyin, e.g. 英伟达 → "yingweida". */
  full: string;
  /** First letter of each syllable, e.g. 英伟达 → "ywd". */
  initials: string;
}

/**
 * Derive tone-less pinyin for a Chinese alias. Non-Chinese characters
 * (brands such as "AI" or "Moonshot") are dropped so mixed names still work.
 */
export function pinyinVariants(value: string): PinyinVariants | null {
  const trimmed = value.trim();
  if (!CJK_RE.test(trimmed)) return null;
  const syllables = pinyin(trimmed, {
    toneType: "none",
    type: "array",
    nonZh: "removed",
  })
    .map((syllable) => syllable.toLowerCase().replace(/[^a-z]/g, ""))
    .filter(Boolean);
  if (syllables.length === 0) return null;
  return {
    full: syllables.join(""),
    initials: syllables.map((syllable) => syllable[0]).join(""),
  };
}

/**
 * User-facing alias forms for a Chinese name: full pinyin and initials, plus
 * the same for the corporate-suffix-stripped stem (英特尔公司 → yte, yingte).
 * These are inserted as aliases so the exact-match planner resolves them.
 */
export function pinyinAliasForms(value: string): string[] {
  const forms = new Set<string>();
  const add = (text: string): void => {
    const variants = pinyinVariants(text);
    if (!variants) return;
    if (variants.full) forms.add(variants.full);
    if (variants.initials) forms.add(variants.initials);
  };
  add(value);
  const stem = value.replace(CORPORATE_SUFFIX_RE, "").trim();
  if (stem && stem !== value) add(stem);
  forms.delete(value.toLowerCase());
  return [...forms];
}

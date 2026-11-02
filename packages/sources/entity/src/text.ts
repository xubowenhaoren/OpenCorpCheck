/**
 * Shared text normalization for deterministic matching.
 *
 * Entity resolution must never merge on a fuzzy guess. These helpers only
 * collapse cosmetic differences (case, punctuation, whitespace, HTML-ish
 * spacing); callers still require exact normalized equality or an explicit,
 * vendor-supplied cross-listing code.
 */

const PUNCTUATION = /[\s.,，。;；:：!！?？'"“”‘’`´·•・/\\|_\-–—()[\]{}（）【】《》〈〉<>]+/g;

const LEGAL_SUFFIX =
  /(?:\s+(?:incorporated|inc|corp|corporation|company|co|ltd|limited|plc|holdings?))\.?$/;

/** Normalize a name for candidate comparison; legal suffixes are dropped. */
export function normalizeName(value: string | null | undefined): string {
  if (!value) return "";
  let text = value.normalize("NFKC").trim().toLowerCase().replace(/&/g, " and ");
  text = text.replace(LEGAL_SUFFIX, "");
  text = text.replace(/股份有限公司|有限责任公司|有限公司/g, "");
  return text.replace(PUNCTUATION, "");
}

/** Keep the full name (including legal suffixes) but remove cosmetic noise. */
export function normalizeFullName(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(PUNCTUATION, "");
}

/** Normalize a website URL or host into a bare lowercase domain. */
export function normalizeDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  let text = value.trim();
  if (!text || text === "--") return null;
  text = text.replace(/^[a-z]+:\/\//i, "").replace(/^www\./i, "");
  text = text.split(/[/?#]/)[0] ?? "";
  text = text.replace(/\.$/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(text)) return null;
  return text;
}

/** Normalize an exchange ticker for the cross-listing comparison. */
export function normalizeTicker(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

/** Normalize an LEI (20 uppercase alphanumerics). */
export function normalizeLei(value: string | null | undefined): string | null {
  const lei = (value ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{20}$/.test(lei) ? lei : null;
}

/** Normalize an ISIN (12 characters: 2 letters + 9 alphanumerics + check digit). */
export function normalizeIsin(value: string | null | undefined): string | null {
  const isin = (value ?? "").replace(/\s+/g, "").toUpperCase();
  return /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin) ? isin : null;
}

/** Normalize a Chinese Unified Social Credit Code (18 characters). */
export function normalizeUscc(value: string | null | undefined): string | null {
  const raw = (value ?? "").replace(/\s+/g, "").toUpperCase();
  if (!/^[0-9A-HJ-NPQRTUWXY]{18}$/.test(raw)) return null;
  return raw;
}

/** Normalize a Wikidata entity id (`Q123`). */
export function normalizeQid(value: string | null | undefined): string | null {
  const qid = (value ?? "").trim().toUpperCase();
  return /^Q[1-9][0-9]*$/.test(qid) ? qid : null;
}

/**
 * Validate a USCC check digit (GB 32100-2015).
 *
 * The F10 field is usually a valid code, but a parser can pick up a branch
 * registration number. Only reject a well-formed code with a failing checksum;
 * callers decide whether to store it.
 */
export function usccChecksumMatches(value: string): boolean {
  const charset = "0123456789ABCDEFGHJKLMNPQRTUWXY";
  const weights = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
  if (!/^[0-9A-HJ-NPQRTUWXY]{18}$/.test(value)) return false;
  let sum = 0;
  for (let index = 0; index < 17; index += 1) {
    const digit = charset.indexOf(value[index]!);
    if (digit < 0) return false;
    sum += digit * weights[index]!;
  }
  const check = (31 - (sum % 31)) % 31;
  return charset[check] === value[17];
}

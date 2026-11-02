/** Markets handled by the entity spine (mirrors `@occ/core`'s Market). */
export type Market = "A" | "HK" | "US";

export type IdentifierType =
  | "ticker"
  | "cik"
  | "domain"
  | "lei"
  | "uscc"
  | "isin"
  | "wikidata"
  | "ein";

export interface IdentifierRow {
  companyId: string;
  idType: IdentifierType;
  idValue: string;
}

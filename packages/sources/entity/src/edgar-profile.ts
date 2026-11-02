import { normalizeDomain, normalizeLei } from "./text.js";

/**
 * The SEC submissions payload is much wider than the financials parser needs.
 * Keep the fields that matter for entity resolution and ignore the rest.
 */
export interface EdgarSubmissionsProfile {
  cik?: string | number;
  name?: string;
  entityType?: string;
  sic?: string | number;
  sicDescription?: string;
  lei?: string;
  ein?: string | number;
  description?: string;
  website?: string;
  category?: string;
  fiscalYearEnd?: string;
  stateOfIncorporation?: string;
  tickers?: string[];
  exchanges?: string[];
}

export interface EdgarCompanyProfile {
  cik?: string;
  name?: string;
  entityType?: string;
  sic?: string;
  sicDescription?: string;
  lei?: string;
  ein?: string;
  website?: string;
  domain?: string;
  stateOfIncorporation?: string;
  tickers: string[];
  exchanges: string[];
}

/** Parse the cached SEC `submissions.json` into entity-profile fields. */
export function parseEdgarProfile(
  submissions: EdgarSubmissionsProfile | null | undefined,
): EdgarCompanyProfile | null {
  if (!submissions) return null;
  const cik =
    submissions.cik !== undefined && submissions.cik !== null
      ? String(submissions.cik).replace(/\D/g, "").padStart(10, "0")
      : undefined;
  const sic =
    submissions.sic !== undefined && submissions.sic !== null
      ? String(submissions.sic).replace(/\D/g, "")
      : undefined;
  const ein = submissions.ein !== undefined && submissions.ein !== null
    ? String(submissions.ein).replace(/\D/g, "")
    : undefined;
  const website = submissions.website?.trim();
  const domain = normalizeDomain(website);

  return {
    ...(cik && cik !== "0000000000" ? { cik } : {}),
    ...(submissions.name?.trim() ? { name: submissions.name.trim() } : {}),
    ...(submissions.entityType?.trim()
      ? { entityType: submissions.entityType.trim() }
      : {}),
    ...(sic ? { sic } : {}),
    ...(submissions.sicDescription?.trim()
      ? { sicDescription: submissions.sicDescription.trim() }
      : {}),
    ...(normalizeLei(submissions.lei) ? { lei: normalizeLei(submissions.lei)! } : {}),
    ...(ein ? { ein } : {}),
    ...(website ? { website } : {}),
    ...(domain ? { domain } : {}),
    ...(submissions.stateOfIncorporation?.trim()
      ? { stateOfIncorporation: submissions.stateOfIncorporation.trim() }
      : {}),
    tickers: (submissions.tickers ?? []).map((ticker) => ticker.trim().toUpperCase()).filter(Boolean),
    exchanges: (submissions.exchanges ?? []).map((exchange) => exchange.trim()).filter(Boolean),
  };
}

/**
 * Filing-layer contracts (P1.4).
 *
 * An adapter only discovers and normalizes announcements. Persistence,
 * PDF following and chunking happen in `@occ/ingest`; this package stays
 * deterministic, network-politness-aware and fixture-testable.
 */

export type FilingMarket = "A" | "HK" | "US";

export type FilingSource =
  | "edgar"
  | "cninfo"
  | "hkexnews"
  | "ir-rss"
  | "gdelt";

export type FilingTrustTier = "official" | "company_ir" | "media";

export interface FilingItem {
  source: FilingSource;
  market: FilingMarket;
  /** Stable source key: accession, announcement id, PDF URL, article URL. */
  externalId: string;
  title: string;
  /** Page a reader should open; for official filings this is the PDF. */
  url: string;
  /** Direct PDF link when the source publishes one. */
  pdfUrl?: string;
  /** Form type or announcement type, e.g. `10-K`, `8-K`, `公告`. */
  form?: string;
  /** Source category, e.g. `Announcements and Notices`. */
  category?: string;
  /** ISO timestamp. Sources that only publish a date use 00:00Z. */
  publishedAt?: string;
  /** Period the filing reports on, `YYYY-MM-DD`, when known. */
  periodEnd?: string;
  language?: "zh" | "en";
  trustTier?: FilingTrustTier;
  /** Source-specific provenance kept on the document. */
  metadata?: Record<string, unknown>;
}

export interface FilingFetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
}

export const DEFAULT_FILING_USER_AGENT =
  "OpenCorpCheck/0.1 (company research; contact: xubowenhaoren@gmail.com)";

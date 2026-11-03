import { cleanText, parseFilingDate } from "./text.js";
import {
  DEFAULT_FILING_USER_AGENT,
  type FilingFetchOptions,
  type FilingItem,
  type FilingMarket,
} from "./types.js";

/**
 * GDELT 2.0 DOC API adapter (P1.4).
 *
 * GDELT is a broad news aggregator, not an official source. It is an optional
 * supplement for companies without a usable IR feed; every item is link-only
 * and tagged `media`. Query one company at a time and keep maxrecords small.
 */

export interface GdeltArticle {
  url?: string;
  title?: string;
  seendate?: string;
  domain?: string;
  language?: string;
  sourcecountry?: string;
  socialimage?: string;
}

export interface GdeltResponse {
  articles?: GdeltArticle[];
}

export interface FetchGdeltOptions extends FilingFetchOptions {
  query: string;
  market?: FilingMarket;
  /** Inclusive window. */
  from?: Date;
  to?: Date;
  maxRecords?: number;
}

const ENDPOINT = "https://api.gdeltproject.org/api/v2/doc/doc";

export function gdeltDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14);
}

export function parseGdeltResponse(
  payload: GdeltResponse,
  options: { market?: FilingMarket; maxRecords?: number; query?: string } = {},
): FilingItem[] {
  const max = options.maxRecords && options.maxRecords > 0 ? options.maxRecords : 20;
  const items: FilingItem[] = [];
  for (const article of payload.articles ?? []) {
    const url = (article.url ?? "").trim();
    const title = cleanText(article.title);
    if (!url || !title) continue;
    items.push({
      source: "gdelt",
      market: options.market ?? "US",
      externalId: url,
      title,
      url,
      form: "news",
      category: "GDELT",
      publishedAt:
        parseFilingDate(
          article.seendate
            ? `${article.seendate.slice(0, 4)}-${article.seendate.slice(4, 6)}-${article.seendate.slice(6, 8)}T${article.seendate.slice(9, 11)}:${article.seendate.slice(11, 13)}:${article.seendate.slice(13, 15)}Z`
            : undefined,
        ) ?? undefined,
      language: article.language === "Chinese" ? "zh" : "en",
      trustTier: "media",
      metadata: {
        source: "gdelt-doc-api",
        query: options.query ?? null,
        domain: article.domain ?? null,
        sourcecountry: article.sourcecountry ?? null,
        language: article.language ?? null,
      },
    });
    if (items.length >= max) break;
  }
  return items;
}

export async function fetchGdeltArticles(
  options: FetchGdeltOptions,
): Promise<FilingItem[]> {
  const to = options.to ?? new Date();
  const from = options.from ?? new Date(to.getTime() - 30 * 86_400_000);
  const params = new URLSearchParams({
    query: options.query,
    mode: "artlist",
    format: "json",
    maxrecords: String(options.maxRecords ?? 20),
    startdatetime: gdeltDate(from),
    enddatetime: gdeltDate(to),
  });
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${ENDPOINT}?${params.toString()}`;
  // GDELT asks for at most one request every 5 seconds. Automated runs are
  // serialized; a caller-supplied fetch (tests) bypasses the wait.
  await paceGdelt(fetchImpl === fetch ? 5_500 : 0);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: {
          "user-agent": options.userAgent ?? DEFAULT_FILING_USER_AGENT,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1_000
            : 5_500;
        lastError = new Error(
          `GDELT responded ${response.status}; the API allows one request every 5 seconds`,
        );
        if (attempt < 3) await sleep(waitMs);
        continue;
      }
      if (!response.ok) throw new Error(`GDELT HTTP ${response.status}`);
      const text = await response.text();
      if (!text.trim()) return [];
      const payload = JSON.parse(text) as GdeltResponse;
      return parseGdeltResponse(payload, {
        market: options.market,
        maxRecords: options.maxRecords,
        query: options.query,
      });
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(5_500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("GDELT request failed");
}

let gdeltGate: Promise<void> = Promise.resolve();
let gdeltLastRequestAt = 0;

async function paceGdelt(minIntervalMs: number): Promise<void> {
  if (minIntervalMs <= 0) return;
  const previous = gdeltGate;
  gdeltGate = previous.then(async () => {
    const wait = Math.max(0, minIntervalMs - (Date.now() - gdeltLastRequestAt));
    if (wait > 0) await sleep(wait);
    gdeltLastRequestAt = Date.now();
  });
  await gdeltGate;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

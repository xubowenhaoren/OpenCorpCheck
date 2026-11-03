import { cleanText, parseFilingDate } from "./text.js";
import type { FilingFetchOptions, FilingItem } from "./types.js";

/**
 * HKEXnews announcement adapter (P1.4).
 *
 * The public title-search page is a JavaScript form driven by the Playwright
 * sidecar (`POST /v1/hkexnews/search`). The sidecar returns the rows it read
 * from the official result table; this module maps them to filing items.
 * Only the title, category and PDF link are kept — no full-text redistribution.
 */

export interface HkexNewsRow {
  /** `dd/mm/yyyy HH:MM` exactly as published. */
  date?: string;
  stock_code?: string;
  stock_name?: string;
  category?: string;
  title?: string;
  url?: string;
  size?: string;
}

export interface HkexNewsResponse {
  code?: string;
  name?: string;
  from_date?: string;
  to_date?: string;
  total_records?: number;
  returned?: number;
  truncated?: boolean;
  items?: HkexNewsRow[];
  errors?: string[];
}

export interface FetchHkexNewsOptions extends FilingFetchOptions {
  code: string;
  /** Lookback window in days (default 365). */
  days?: number;
  maxItems?: number;
  /** Finance-analyst sidecar base URL. */
  sidecarUrl: string;
}

const DEFAULT_TIMEOUT_MS = 90_000;

export function hkexNewsForm(category: string | undefined): string {
  const value = (category ?? "").trim();
  if (!value) return "公告";
  return value.split(/\s+-\s+\[/)[0]?.trim() || value;
}

export function parseHkexNewsRows(
  rows: HkexNewsRow[],
  options: { code: string; maxItems?: number } = { code: "" },
): FilingItem[] {
  const maxItems = options.maxItems && options.maxItems > 0 ? options.maxItems : undefined;
  const items: FilingItem[] = [];
  for (const row of rows) {
    const url = (row.url ?? "").trim();
    const title = cleanText(row.title);
    if (!url || !title) continue;
    const rawCategory = cleanText(row.category);
    const category = /\[(.*)\]\s*$/.exec(rawCategory)?.[1]?.trim() || rawCategory;
    items.push({
      source: "hkexnews",
      market: "HK",
      externalId: url,
      title,
      url,
      pdfUrl: url.toLowerCase().includes(".pdf") ? url : undefined,
      form: hkexNewsForm(rawCategory),
      ...(category ? { category } : {}),
      publishedAt: parseFilingDate(row.date),
      language: "en",
      trustTier: "official",
      metadata: {
        source: "hkexnews-title-search",
        stockCode: row.stock_code ?? options.code ?? null,
        stockName: row.stock_name ?? null,
        size: row.size ?? null,
        releaseTime: row.date ?? null,
        rawCategory: rawCategory || null,
      },
    });
    if (maxItems && items.length >= maxItems) break;
  }
  return items;
}

export async function fetchHkexNewsFilings(
  options: FetchHkexNewsOptions,
): Promise<{ items: FilingItem[]; total: number; truncated: boolean; errors: string[] }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.sidecarUrl.replace(/\/+$/, "")}/v1/hkexnews/search`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.userAgent ? { "user-agent": options.userAgent } : {}),
    },
    body: JSON.stringify({
      code: options.code,
      days: options.days ?? 365,
      max_items: options.maxItems ?? 30,
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `HKEXnews sidecar HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}` +
        " (start it with `cd services/finance-analyst && uv run occ-f10 serve`)",
    );
  }
  const payload = (await response.json()) as HkexNewsResponse;
  const items = parseHkexNewsRows(payload.items ?? [], {
    code: options.code,
    maxItems: options.maxItems,
  });
  return {
    items,
    total: Number(payload.total_records ?? items.length),
    truncated: Boolean(payload.truncated),
    errors: payload.errors ?? [],
  };
}

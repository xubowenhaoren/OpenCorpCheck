import { cleanText, parseFilingDate } from "./text.js";
import {
  DEFAULT_FILING_USER_AGENT,
  type FilingFetchOptions,
  type FilingItem,
  type FilingMarket,
} from "./types.js";

/**
 * Generic company IR RSS/Atom adapter (P1.4).
 *
 * This is deliberately feed-agnostic: operators list IR/newsroom feeds in
 * `config/ir-feeds.yaml`. We store the title, summary and publication date and
 * always link to the original page. Article bodies are not fetched.
 */

export interface ParseIrFeedOptions {
  market: FilingMarket;
  sourceName?: string;
  language?: "zh" | "en";
  limit?: number;
  sinceDays?: number;
  now?: Date;
  /** Feed URL, used to resolve relative Atom/RSS links. */
  baseUrl?: string;
}

export function parseIrFeed(
  xml: string,
  options: ParseIrFeedOptions,
): FilingItem[] {
  const limit = options.limit && options.limit > 0 ? options.limit : 30;
  const now = options.now ?? new Date();
  const cutoff =
    options.sinceDays && options.sinceDays > 0
      ? now.getTime() - options.sinceDays * 86_400_000
      : null;
  const isAtom = /<feed\b/i.test(xml);
  const blocks = isAtom
    ? [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((m) => m[1]!)
    : [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => m[1]!);
  const items: FilingItem[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    const title = cleanText(tag(block, "title"));
    const rawLink = atomLink(block) || cleanText(tag(block, "link"));
    const link = resolveLink(rawLink, options.baseUrl);
    if (!title || !link || !/^https?:\/\//i.test(link)) continue;
    if (seen.has(link)) continue;
    const date =
      parseFilingDate(tag(block, "pubDate")) ??
      parseFilingDate(tag(block, "published")) ??
      parseFilingDate(tag(block, "updated")) ??
      parseFilingDate(tag(block, "dc:date"));
    if (cutoff !== null && date && new Date(date).getTime() < cutoff) continue;
    const summary = cleanText(
      tag(block, "description") || tag(block, "summary") || tag(block, "content"),
    );
    seen.add(link);
    items.push({
      source: "ir-rss",
      market: options.market,
      externalId: link,
      title,
      url: link,
      ...(link.toLowerCase().endsWith(".pdf") ? { pdfUrl: link } : {}),
      form: "press release",
      category: options.sourceName ?? "IR feed",
      ...(date ? { publishedAt: date } : {}),
      language: options.language ?? (options.market === "US" ? "en" : "zh"),
      trustTier: "company_ir",
      metadata: {
        source: "company-ir-rss",
        feed: options.sourceName ?? null,
        summary: summary ? summary.slice(0, 2_000) : null,
      },
    });
    if (items.length >= limit) break;
  }
  return items;
}

export async function fetchIrFeed(
  url: string,
  options: ParseIrFeedOptions & FilingFetchOptions,
): Promise<FilingItem[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    headers: {
      "user-agent": options.userAgent ?? DEFAULT_FILING_USER_AGENT,
      accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
  });
  if (!response.ok) throw new Error(`IR feed HTTP ${response.status}: ${url}`);
  return parseIrFeed(await response.text(), { ...options, baseUrl: url });
}

function tag(block: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)</${escaped}>`, "i").exec(
    block,
  );
  if (!match) return "";
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(match[1]!);
  return cdata ? cdata[1]! : match[1]!;
}

function atomLink(block: string): string {
  const links = [
    ...block.matchAll(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/gi),
  ];
  const alternate = links.find((match) =>
    /rel\s*=\s*["']alternate["']/i.test(match[0]),
  );
  return alternate?.[1] ?? links[0]?.[1] ?? "";
}

function resolveLink(value: string, baseUrl?: string): string {
  if (!value) return "";
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

/**
 * Google News RSS adapter.
 *
 * Google News exposes a stable, public RSS search feed. We use it as a cheap,
 * link-only news layer: we store the headline, publisher, date and the short
 * snippet from the feed, always linking back to the original article. We do not
 * scrape article bodies or bypass paywalls.
 *
 * The feed terms limit use to a personal feed reader for non-commercial use;
 * keep volume low (one request per company, a handful of items) and attribute
 * the original publisher.
 */

export interface NewsArticle {
  title: string;
  url: string;
  publisher?: string;
  /** ISO timestamp when the feed provides one. */
  publishedAt?: string;
  /** Plain-text snippet from the feed description (HTML stripped). */
  summary?: string;
}

export interface FetchNewsOptions {
  limit?: number;
  sinceDays?: number;
  locale?: "zh-CN" | "en-US";
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ParseNewsOptions {
  limit?: number;
  sinceDays?: number;
  now?: Date;
}

const DEFAULT_LIMIT = 10;
const DEFAULT_TIMEOUT_MS = 15_000;
const USER_AGENT =
  "OpenCorpCheck/0.1 (company research; one request per company; contact: local)";

export function googleNewsUrl(
  query: string,
  locale: "zh-CN" | "en-US" = "en-US",
): string {
  const params = new URLSearchParams({
    q: query,
    hl: locale,
    gl: locale === "zh-CN" ? "CN" : "US",
    ceid: locale === "zh-CN" ? "CN:zh-Hans" : "US:en",
  });
  return `https://news.google.com/rss/search?${params.toString()}`;
}

export async function fetchGoogleNews(
  query: string,
  options: FetchNewsOptions = {},
): Promise<NewsArticle[]> {
  const locale = options.locale ?? "en-US";
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(googleNewsUrl(query, locale), {
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Google News RSS HTTP ${response.status}`);
  }
  const xml = await response.text();
  return parseGoogleNewsRss(xml, {
    limit: options.limit,
    sinceDays: options.sinceDays,
  });
}

export function parseGoogleNewsRss(
  xml: string,
  options: ParseNewsOptions = {},
): NewsArticle[] {
  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
  const now = options.now ?? new Date();
  const cutoff =
    options.sinceDays && options.sinceDays > 0
      ? now.getTime() - options.sinceDays * 86_400_000
      : null;

  const articles: NewsArticle[] = [];
  const seen = new Set<string>();

  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = match[1]!;
    const title = cleanText(extractTag(block, "title"));
    const url = cleanText(extractTag(block, "link"));
    if (!title || !url || !/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;

    const publisher =
      cleanText(extractTag(block, "source")) || publisherFromTitle(title);
    const headline = stripPublisherSuffix(title, publisher);

    const rawDescription = extractTag(block, "description");
    const summary = snippet(rawDescription);

    const pubDate = parseDate(extractTag(block, "pubDate"));
    if (cutoff !== null && pubDate && pubDate.getTime() < cutoff) continue;

    seen.add(url);
    articles.push({
      title: headline || title,
      url,
      ...(publisher ? { publisher } : {}),
      ...(pubDate ? { publishedAt: pubDate.toISOString() } : {}),
      ...(summary ? { summary } : {}),
    });
    if (articles.length >= limit) break;
  }

  articles.sort((a, b) =>
    (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
  );
  return articles;
}

function extractTag(block: string, tag: string): string | null {
  const match = new RegExp(
    `<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`,
    "i",
  ).exec(block);
  if (!match) return null;
  return match[1] ?? null;
}

function cleanText(value: string | null): string {
  if (!value) return "";
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(value);
  const text = cdata ? cdata[1]! : value;
  return collapseWhitespace(decodeXml(text));
}

function snippet(value: string | null): string | undefined {
  if (!value) return undefined;
  const decoded = decodeXml(value);
  const text = decodeXml(decoded.replace(/<[^>]+>/g, " "));
  const cleaned = collapseWhitespace(text);
  if (!cleaned) return undefined;
  return cleaned.length > 600 ? `${cleaned.slice(0, 597)}...` : cleaned;
}

function publisherFromTitle(title: string): string | undefined {
  const match = /\s-\s([^-]{2,80})$/.exec(title);
  return match?.[1]?.trim() || undefined;
}

function stripPublisherSuffix(title: string, publisher?: string): string {
  if (!publisher) return title;
  const suffix = ` - ${publisher}`;
  return title.endsWith(suffix)
    ? title.slice(0, -suffix.length).trim()
    : title;
}

function parseDate(value: string | null): Date | undefined {
  if (!value) return undefined;
  const date = new Date(cleanText(value));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    )
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'");
}

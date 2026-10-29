export interface CitationRef {
  ref: number;
  url: string;
  title?: string;
  publisher?: string;
  publishedAt?: string;
  fetchedAt?: string;
}

const DATE = /\d{4}-\d{2}-\d{2}/;
const ISO_DATE = /\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/;

function cleanUrl(raw: string): string {
  return raw
    .replace(/[)\]）。，；;、]+$/g, "")
    .replace(/^[（(]+/, "")
    .trim();
}

/**
 * Parse the `来源` chapter. Two shapes appear in real profiles:
 *
 *   [1] [Apple Inc. Form 10-K](https://sec.gov/...) — SEC, 2025-10-31
 *   [1] 东方财富 F10 财务分析，https://...，抓取于 2026-10-28T20:21:37Z
 */
export function parseSourceChapter(text: string): CitationRef[] {
  const citations: CitationRef[] = [];
  const seen = new Set<number>();

  for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim();
    const match = /^\[(\d+)\]\s+(.+)$/.exec(line);
    if (!match) continue;
    const ref = Number.parseInt(match[1]!, 10);
    if (seen.has(ref)) continue;
    const body = match[2]!.trim();

    const markdownLink = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/.exec(body);
    const bareUrl = /(https?:\/\/[^\s，,）)]+)/.exec(body);
    const url = cleanUrl(markdownLink?.[2] ?? bareUrl?.[1] ?? "");
    if (!url) continue;

    const title = markdownLink?.[1]?.trim();
    const afterUrl = body.slice(body.indexOf(url) + url.length);
    const beforeUrl = body.slice(0, body.indexOf(url)).replace(/[，,]\s*$/, "").trim();
    const publishedAt = DATE.exec(afterUrl)?.[0];
    const fetchedAt = ISO_DATE.exec(afterUrl)?.[0];
    const publisher = /[—–]\s*([^，,]+?)(?:[，,]\s*|$)/.exec(afterUrl)?.[1]?.trim();

    citations.push({
      ref,
      url,
      ...(title ? { title } : {}),
      ...(publisher ? { publisher } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(fetchedAt ? { fetchedAt } : {}),
      ...(!title && beforeUrl ? { title: beforeUrl } : {}),
    });
    seen.add(ref);
  }

  return citations;
}

/** `> 数据截止：2026-10-28` near the top of every profile. */
export function parseDataCutoff(markdown: string): string | undefined {
  return /数据截止[：:]\s*(\d{4}-\d{2}-\d{2})/.exec(markdown)?.[1];
}

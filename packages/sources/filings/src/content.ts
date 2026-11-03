import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { DEFAULT_FILING_USER_AGENT, type FilingItem } from "./types.js";
import {
  extractPdfPages,
  fetchPdfBytes,
  type PdfTable,
} from "./pdf.js";
import { sha256Text } from "./text.js";

/**
 * Reusable filing content loader (P1.5).
 *
 * The P1.4 CLI and the daily `ingest.filing` worker must follow PDFs/HTML the
 * same way and share the same on-disk cache. This module is the single
 * deterministic implementation: raw PDFs and extraction JSON live under
 * `dir/<source>/<key>`, and a rerun reuses them unless `refresh` is set.
 *
 * The return type is structurally identical to `@occ/ingest`'s
 * `FilingContent`, so `ingestFilings` accepts it without a dependency cycle.
 */

export interface FilingContentPage {
  page: number;
  text: string;
  tables?: PdfTable[];
}

export interface FilingContent {
  pages: FilingContentPage[];
  mime?: string;
  rawSha256?: string;
  warnings?: string[];
  truncated?: boolean;
}

export type LoadFilingContentFn = (
  item: FilingItem,
) => Promise<FilingContent | null>;

export interface FilingContentLoaderOptions {
  /** Cache root, normally `OCC_FILINGS_DIR` (`.occ/filings`). */
  dir: string;
  /** Finance-analyst sidecar base URL for `POST /v1/pdf/extract`. */
  sidecarUrl: string;
  userAgent?: string;
  /** PDF page cap (default 80). */
  maxPages?: number;
  /** Ignore cached PDFs/extraction JSON. */
  refresh?: boolean;
  /** Store link-only documents (no PDF fetch). */
  skipPdf?: boolean;
  /** Also follow EDGAR HTML primary documents. */
  fullText?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function createFilingContentLoader(
  options: FilingContentLoaderOptions,
): LoadFilingContentFn {
  return async (item: FilingItem): Promise<FilingContent | null> => {
    if (options.skipPdf) return null;
    const key = sha256Text(
      `${item.source}|${item.externalId}|${item.url}`,
    ).slice(0, 32);
    const dir = path.join(options.dir, item.source);
    const pdfPath = path.join(dir, `${key}.pdf`);
    const extractionPath = path.join(dir, `${key}.json`);
    try {
      if (item.pdfUrl) {
        if (!options.refresh && fs.existsSync(extractionPath)) {
          try {
            const cached = JSON.parse(
              fs.readFileSync(extractionPath, "utf8"),
            ) as FilingContent & { rawSha256?: string };
            if (cached.pages?.length) return cached;
          } catch {
            // A corrupt extraction cache is ignored and rebuilt below.
          }
        }
        let bytes: Buffer;
        if (!options.refresh && fs.existsSync(pdfPath)) {
          bytes = fs.readFileSync(pdfPath);
        } else {
          const fetched = await fetchPdfBytes(item.pdfUrl, {
            userAgent: options.userAgent ?? DEFAULT_FILING_USER_AGENT,
            ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          });
          bytes = fetched.bytes;
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(pdfPath, bytes);
        }
        const extracted = await extractPdfPages(bytes, {
          sidecarUrl: options.sidecarUrl,
          maxPages: options.maxPages ?? 80,
        });
        const content: FilingContent = {
          pages: extracted.pages,
          mime: "application/pdf",
          rawSha256: sha256Buffer(bytes),
          warnings: extracted.warnings,
          truncated: extracted.truncated,
        };
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          extractionPath,
          `${JSON.stringify({ ...content, pageCount: extracted.pageCount })}\n`,
          "utf8",
        );
        return content;
      }
      if (options.fullText && item.source === "edgar") {
        const fetchImpl = options.fetchImpl ?? fetch;
        const response = await fetchImpl(item.url, {
          headers: {
            "user-agent": options.userAgent ?? DEFAULT_FILING_USER_AGENT,
          },
          signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
        });
        if (!response.ok) return null;
        const html = await response.text();
        const text = htmlToText(html).slice(0, 300_000);
        if (!text.trim()) return null;
        return {
          pages: [{ page: 1, text }],
          mime: "text/html",
          rawSha256: sha256Text(html),
          warnings:
            text.length >= 300_000
              ? ["HTML text truncated to 300k chars"]
              : [],
        };
      }
      return null;
    } catch (error) {
      // Let ingest keep the announcement as link-only; surface why.
      throw new Error(`${item.source} content: ${messageOf(error)}`);
    }
  };
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function sha256Buffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

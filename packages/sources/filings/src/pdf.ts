import {
  DEFAULT_FILING_USER_AGENT,
  type FilingFetchOptions,
} from "./types.js";

/**
 * PDF following + text/table extraction (P1.4).
 *
 * Fetching stays in TypeScript (so the adapter owns cookies/robots/pacing and
 * can cache the raw bytes). Parsing is delegated to the Python sidecar, which
 * already ships Playwright and uses `pdfplumber` for CJK text and tables.
 * Text and tables keep their page number; the LLM is never involved.
 */

export interface PdfTable {
  headers: string[];
  rows: string[][];
}

export interface PdfPage {
  page: number;
  text: string;
  tables: PdfTable[];
}

export interface PdfExtraction {
  pages: PdfPage[];
  pageCount: number;
  /** True when the sidecar stopped at its page cap. */
  truncated: boolean;
  warnings: string[];
}

export interface FetchPdfOptions extends FilingFetchOptions {
  /** Hard cap before extraction (default 30 MB). */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 30 * 1024 * 1024;

export async function fetchPdfBytes(
  url: string,
  options: FetchPdfOptions = {},
): Promise<{ bytes: Buffer; contentType: string | null; finalUrl: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    headers: {
      "user-agent": options.userAgent ?? DEFAULT_FILING_USER_AGENT,
      accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.5",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
  });
  if (!response.ok) {
    throw new Error(`PDF fetch HTTP ${response.status}: ${url}`);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (declared > maxBytes) {
    throw new Error(`PDF is ${declared} bytes, over the ${maxBytes}-byte cap`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new Error(`PDF is ${bytes.byteLength} bytes, over the ${maxBytes}-byte cap`);
  }
  const contentType = response.headers.get("content-type");
  const magic = bytes.subarray(0, 5).toString("latin1");
  if (magic !== "%PDF-") {
    throw new Error(
      `URL did not return a PDF (content-type ${contentType ?? "unknown"}, magic ${JSON.stringify(magic)})`,
    );
  }
  return { bytes, contentType, finalUrl: response.url || url };
}

export async function extractPdfPages(
  bytes: Buffer,
  options: { sidecarUrl: string; timeoutMs?: number; maxPages?: number },
): Promise<PdfExtraction> {
  const url = `${options.sidecarUrl.replace(/\/+$/, "")}/v1/pdf/extract`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      base64: bytes.toString("base64"),
      max_pages: options.maxPages ?? 80,
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `PDF sidecar HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}` +
        " (start it with `cd services/finance-analyst && uv run occ-f10 serve`)",
    );
  }
  const payload = (await response.json()) as Partial<PdfExtraction> & {
    page_count?: number;
    pages?: Array<{
      page?: number;
      text?: string;
      tables?: Array<{ headers?: string[]; rows?: string[][] }>;
    }>;
  };
  const pages = (payload.pages ?? []).map((page, index) => ({
    page: page.page ?? index + 1,
    text: page.text ?? "",
    tables: (page.tables ?? []).map((table) => ({
      headers: table.headers ?? [],
      rows: table.rows ?? [],
    })),
  }));
  return {
    pages,
    pageCount: payload.pageCount ?? payload.page_count ?? pages.length,
    truncated: Boolean(payload.truncated),
    warnings: payload.warnings ?? [],
  };
}

/** Plain-text representation with page provenance for chunking/embedding. */
export function pdfPageText(page: PdfPage): string {
  const parts: string[] = [];
  if (page.text.trim()) parts.push(page.text.trim());
  for (const table of page.tables) {
    if (table.rows.length === 0) continue;
    if (table.headers.length > 0) parts.push(table.headers.join(" | "));
    for (const row of table.rows) parts.push(row.join(" | "));
  }
  return parts.join("\n").trim();
}

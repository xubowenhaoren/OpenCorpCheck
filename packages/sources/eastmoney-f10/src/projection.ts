import type {
  PageResult,
  PageTable,
  ScrapeResponse,
  XhrCapture,
} from "./types.js";

export type ProjectionDetail = "summary" | "full";

export interface ProjectionOptions {
  /** `summary` (default) trims for an agent context; `full` returns everything. */
  detail?: ProjectionDetail;
  /** Per-page text cap in summary mode. Default 20,000 characters. */
  maxTextChars?: number;
  /** Table cap per page in summary mode. Default 25. */
  maxTables?: number;
  /** Row cap per table in summary mode. Default 60. */
  maxTableRows?: number;
  /** Include raw XHR bodies in summary mode. Default false (metadata only). */
  includeXhrBodies?: boolean;
}

export interface XhrSummary {
  url: string;
  status: number | null;
  report_name: string | null;
}

export interface ProjectedPage {
  label: string;
  page: string;
  url: string;
  final_url: string | null;
  http_status: number | null;
  text: string;
  text_chars: number;
  text_truncated: boolean;
  tables: PageTable[];
  table_count: number;
  tables_truncated: boolean;
  xhr_count: number;
  xhr?: XhrSummary[] | XhrCapture[];
  warnings: string[];
  error: string | null;
  storage_key: string | null;
  html_sha256: string | null;
  attempts: number;
  elapsed_ms: number;
}

export interface ProjectedScrapeResult {
  detail: ProjectionDetail;
  meta: ScrapeResponse["meta"];
  pages: ProjectedPage[];
  errors: string[];
}

const DEFAULT_MAX_TEXT_CHARS = 20_000;
const DEFAULT_MAX_TABLES = 25;
const DEFAULT_MAX_TABLE_ROWS = 60;

/**
 * Shape a sidecar response for an agent context.
 *
 * A full F10 response can be hundreds of kilobytes (56 quarterly columns of a
 * balance sheet, plus XHR bodies). The summary keeps the text an agent needs
 * and the table structure, drops XHR bodies to metadata, and records every
 * truncation so the model can ask for `detail: "full"` when it matters.
 */
export function projectScrapeResult(
  result: ScrapeResponse,
  options: ProjectionOptions = {},
): ProjectedScrapeResult {
  const detail = options.detail ?? "summary";
  const maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const maxTables = options.maxTables ?? DEFAULT_MAX_TABLES;
  const maxTableRows = options.maxTableRows ?? DEFAULT_MAX_TABLE_ROWS;
  const includeXhrBodies = options.includeXhrBodies ?? false;

  return {
    detail,
    meta: result.meta,
    errors: result.errors,
    pages: result.pages.map((page) =>
      detail === "full"
        ? fullPage(page)
        : summaryPage(page, {
            maxTextChars,
            maxTables,
            maxTableRows,
            includeXhrBodies,
          }),
    ),
  };
}

function fullPage(page: PageResult): ProjectedPage {
  return {
    label: page.label,
    page: page.page,
    url: page.url,
    final_url: page.final_url ?? null,
    http_status: page.http_status ?? null,
    text: page.text,
    text_chars: page.text_chars,
    text_truncated: false,
    tables: page.tables,
    table_count: page.table_count,
    tables_truncated: false,
    xhr_count: page.xhr?.length ?? 0,
    xhr: page.xhr ?? [],
    warnings: page.warnings,
    error: page.error ?? null,
    storage_key: page.storage_key ?? null,
    html_sha256: page.html_sha256 ?? null,
    attempts: page.attempts,
    elapsed_ms: page.elapsed_ms,
  };
}

function summaryPage(
  page: PageResult,
  limits: {
    maxTextChars: number;
    maxTables: number;
    maxTableRows: number;
    includeXhrBodies: boolean;
  },
): ProjectedPage {
  const textTruncated = page.text.length > limits.maxTextChars;
  const keptTables = page.tables.slice(0, limits.maxTables);
  const tablesTruncated = keptTables.length < page.tables.length;
  const tables = keptTables.map((table) => ({
    ...table,
    rows: table.rows.slice(0, limits.maxTableRows),
  }));

  return {
    label: page.label,
    page: page.page,
    url: page.url,
    final_url: page.final_url ?? null,
    http_status: page.http_status ?? null,
    text: textTruncated ? page.text.slice(0, limits.maxTextChars) : page.text,
    text_chars: page.text_chars,
    text_truncated: textTruncated,
    tables,
    table_count: page.table_count,
    tables_truncated:
      tablesTruncated ||
      keptTables.some((table) => table.rows.length > limits.maxTableRows),
    xhr_count: page.xhr?.length ?? 0,
    xhr: limits.includeXhrBodies
      ? page.xhr ?? []
      : (page.xhr ?? []).map(toXhrSummary),
    warnings: page.warnings,
    error: page.error ?? null,
    storage_key: page.storage_key ?? null,
    html_sha256: page.html_sha256 ?? null,
    attempts: page.attempts,
    elapsed_ms: page.elapsed_ms,
  };
}

function toXhrSummary(capture: XhrCapture): XhrSummary {
  return {
    url: capture.url,
    status: capture.status ?? null,
    report_name: reportName(capture.url),
  };
}

function reportName(url: string): string | null {
  try {
    return new URL(url).searchParams.get("reportName");
  } catch {
    return null;
  }
}

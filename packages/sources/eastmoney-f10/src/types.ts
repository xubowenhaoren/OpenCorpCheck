import { z } from "zod";

export const marketSchema = z.enum(["A", "HK", "US"]);
export type Market = z.infer<typeof marketSchema>;

export const pageTableSchema = z.object({
  caption: z.string(),
  headers: z.array(z.string()),
  rows: z.array(z.array(z.string())),
});
export type PageTable = z.infer<typeof pageTableSchema>;

export const xhrCaptureSchema = z.object({
  url: z.string(),
  status: z.number().nullable().optional(),
  content_type: z.string().optional(),
  json: z.unknown().optional(),
  text: z.string().nullable().optional(),
  truncated: z.boolean().optional(),
});
export type XhrCapture = z.infer<typeof xhrCaptureSchema>;

export const pageResultSchema = z.object({
  label: z.string(),
  page: z.string(),
  url: z.string(),
  final_url: z.string().nullable().optional(),
  http_status: z.number().nullable().optional(),
  text: z.string(),
  text_chars: z.number(),
  truncated: z.boolean(),
  tables: z.array(pageTableSchema),
  table_count: z.number(),
  html_sha256: z.string().nullable().optional(),
  storage_key: z.string().nullable().optional(),
  xhr: z.array(xhrCaptureSchema).nullable().optional(),
  warnings: z.array(z.string()),
  attempts: z.number(),
  elapsed_ms: z.number(),
  error: z.string().nullable().optional(),
});
export type PageResult = z.infer<typeof pageResultSchema>;

export const scrapeMetaSchema = z.object({
  market: marketSchema,
  code: z.string(),
  normalized_code: z.string(),
  fetched_at: z.string(),
  elapsed_ms: z.number(),
  pages_requested: z.number(),
  pages_ok: z.number(),
  concurrency: z.number(),
  rate_per_sec: z.number(),
});
export type ScrapeMeta = z.infer<typeof scrapeMetaSchema>;

export const scrapeResponseSchema = z.object({
  meta: scrapeMetaSchema,
  pages: z.array(pageResultSchema),
  errors: z.array(z.string()),
});
export type ScrapeResponse = z.infer<typeof scrapeResponseSchema>;

export const scrapeRequestSchema = z.object({
  market: marketSchema,
  code: z
    .string()
    .min(1)
    .max(20)
    .regex(/^[A-Za-z0-9.-]+$/, "code may only contain letters, digits, dots and dashes"),
  pages: z.array(z.string().min(1)).optional(),
  preset: z.string().optional(),
  force: z.boolean().optional(),
  capture_xhr: z.boolean().optional(),
  timeout_ms: z.number().int().min(5_000).max(120_000).optional(),
});
export type ScrapeRequest = z.infer<typeof scrapeRequestSchema>;

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  browser: z.enum(["starting", "ready", "closed"]),
  version: z.string(),
  settings: z.record(z.string(), z.unknown()),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const pagesResponseSchema = z.object({
  market: marketSchema,
  pages: z.record(z.string(), z.string()),
  presets: z.record(z.string(), z.array(z.string())),
});
export type PagesResponse = z.infer<typeof pagesResponseSchema>;

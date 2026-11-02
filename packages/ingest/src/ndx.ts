import fs from "node:fs";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

const IndexSourceSchema = z.object({
  name: z.string(),
  url: z.string(),
  license: z.string(),
});

const IndexMetaSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  market: z.enum(["A", "HK", "US"]),
  as_of: z.string().min(1),
  weights_as_of: z.string().optional(),
  fetched_at: z.string().optional(),
  securities: z.number().int().positive().optional(),
  companies: z.number().int().positive().optional(),
  source: IndexSourceSchema,
});

const ConstituentSchema = z.object({
  ticker: z.string().min(1),
  name: z.string().min(1),
  name_en: z.string().min(1).optional(),
  name_zh: z.string().min(1).optional(),
  exchange: z.string().min(1),
  primary: z.boolean().default(true),
  weight: z.number().nonnegative().optional(),
  cik: z.string().regex(/^\d{10}$/).optional(),
});

const IndexSnapshotSchema = z.object({
  index: IndexMetaSchema,
  constituents: z.array(ConstituentSchema).nonempty(),
});

export type IndexMeta = z.infer<typeof IndexMetaSchema>;
export type IndexConstituent = z.infer<typeof ConstituentSchema>;
export type IndexSnapshot = z.infer<typeof IndexSnapshotSchema>;

/** Load and validate an index constituent snapshot (`config/indices/*.yaml`). */
export function loadIndexSnapshot(filePath: string): IndexSnapshot {
  const raw = parseYaml(fs.readFileSync(filePath, "utf8"));
  return IndexSnapshotSchema.parse(raw);
}

/** Companies to backfill: one primary listing per company (drops GOOG vs GOOGL). */
export function primaryConstituents(
  snapshot: IndexSnapshot,
): IndexConstituent[] {
  return snapshot.constituents.filter((entry) => entry.primary);
}

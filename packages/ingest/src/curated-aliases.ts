import fs from "node:fs";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

export interface CuratedAliasFile {
  version?: number;
  as_of?: string;
  aliases: Record<string, string[]>;
}

interface AliasCacheEntry {
  path: string;
  mtimeMs: number;
  map: Map<string, string[]>;
  asOf?: string;
}

let cache: AliasCacheEntry | null = null;
let warnedMissing = false;

/**
 * Curated Chinese names live at `config/aliases/zh.yaml` in this monorepo.
 * Both `src/` and `dist/` sit at the same depth, so the URL resolves in dev and
 * after build. `OCC_ALIASES_FILE` overrides it (absolute or relative to cwd).
 */
export function defaultCuratedAliasPath(): string {
  const override = process.env.OCC_ALIASES_FILE?.trim();
  if (override) return override;
  return fileURLToPath(
    new URL("../../../config/aliases/zh.yaml", import.meta.url),
  );
}

/** Parse and normalize the curated alias file. Throws on malformed input. */
export function readCuratedAliasFile(filePath: string): CuratedAliasFile {
  const raw = YAML.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!raw || typeof raw !== "object") {
    throw new Error(`curated alias file is not an object: ${filePath}`);
  }
  const record = raw as Record<string, unknown>;
  const aliases = record.aliases;
  if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) {
    throw new Error(`curated alias file has no aliases map: ${filePath}`);
  }
  const normalized: Record<string, string[]> = {};
  for (const [rawTicker, rawAliases] of Object.entries(
    aliases as Record<string, unknown>,
  )) {
    const ticker = rawTicker.trim().toUpperCase();
    const values = Array.isArray(rawAliases) ? rawAliases : [rawAliases];
    const cleaned = values
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean);
    if (!ticker || cleaned.length === 0) continue;
    normalized[ticker] = [...new Set([...(normalized[ticker] ?? []), ...cleaned])];
  }
  return {
    version: typeof record.version === "number" ? record.version : undefined,
    as_of: typeof record.as_of === "string" ? record.as_of : undefined,
    aliases: normalized,
  };
}

/**
 * Load (and cache by mtime) the curated alias map. Returns a map keyed by
 * uppercase ticker. Throws when the file is missing or malformed; callers that
 * must never fail ingestion should use {@link curatedAliasesForTicker}.
 */
export function loadCuratedAliases(
  filePath: string = defaultCuratedAliasPath(),
): Map<string, string[]> {
  const stat = fs.statSync(filePath);
  if (
    cache &&
    cache.path === filePath &&
    cache.mtimeMs === stat.mtimeMs
  ) {
    return cache.map;
  }
  const parsed = readCuratedAliasFile(filePath);
  const map = new Map(
    Object.entries(parsed.aliases).map(([ticker, aliases]) => [
      ticker.toUpperCase(),
      aliases,
    ]),
  );
  cache = { path: filePath, mtimeMs: stat.mtimeMs, map, asOf: parsed.as_of };
  return map;
}

/**
 * Best-effort lookup used by ingestion. A missing/invalid config must not fail
 * a research ingest, so this logs once and returns an empty list.
 */
export function curatedAliasesForTicker(
  ticker: string,
  filePath: string = defaultCuratedAliasPath(),
): string[] {
  try {
    return loadCuratedAliases(filePath).get(ticker.trim().toUpperCase()) ?? [];
  } catch (error) {
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "curated alias file unavailable; continuing without it",
          file: filePath,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return [];
  }
}

/** Test helper: drop the mtime cache. */
export function clearCuratedAliasCache(): void {
  cache = null;
  warnedMissing = false;
}

import { normalizeFullName, normalizeLei } from "./text.js";

/**
 * Minimal GLEIF API v1 client for LEI lookup and parent relationships.
 *
 * GLEIF is CC0. The public API asks for polite use; requests are serialized
 * with a small gap. Nothing here guesses: `resolveLei` accepts a candidate only
 * when its legal name (or a registered other name) is an exact normalized match.
 */

export const DEFAULT_GLEIF_BASE_URL = "https://api.gleif.org/api/v1";

export interface GleifRecord {
  lei: string;
  legalName: string;
  language?: string;
  otherNames: string[];
  status?: string;
  country?: string;
  jurisdiction?: string;
  category?: string;
}

export type GleifParentRelation = "direct" | "ultimate";

export interface GleifParent {
  childLei: string;
  parentLei: string;
  parentName: string;
  relation: GleifParentRelation;
  sourceUrl: string;
  validFrom?: string;
}

export interface GleifLeiResolution {
  lei: string;
  record: GleifRecord;
  matchedName: string;
  rule: "exact-legal-name" | "exact-other-name";
  candidates: number;
}

export interface GleifLeiAmbiguity {
  names: string[];
  candidates: Array<{ lei: string; legalName: string; country?: string }>;
}

export interface GleifClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Minimum gap between requests (default 150 ms). */
  minIntervalMs?: number;
}

interface ApiName {
  name?: string;
  language?: string;
}

interface ApiRecord {
  attributes?: {
    lei?: string;
    entity?: {
      legalName?: ApiName;
      otherNames?: Array<ApiName & { type?: string }>;
      status?: string;
      category?: string;
      jurisdiction?: string;
      legalAddress?: { country?: string };
    };
    registration?: { status?: string };
  };
}

interface ApiResponse {
  data?: ApiRecord | ApiRecord[];
}

export class GleifClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  private gate: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(options: GleifClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_GLEIF_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.minIntervalMs = options.minIntervalMs ?? 150;
  }

  /** Search the public LEI index by legal name. Results are not matched. */
  async searchLegalName(name: string, pageSize = 50): Promise<GleifRecord[]> {
    const url = new URL(`${this.baseUrl}/lei-records`);
    url.searchParams.set("filter[entity.legalName]", name);
    url.searchParams.set("page[size]", String(pageSize));
    const body = await this.request<ApiResponse>(url);
    return recordsOf(body);
  }

  async getRecord(lei: string): Promise<GleifRecord | null> {
    const normalized = normalizeLei(lei);
    if (!normalized) return null;
    const url = new URL(`${this.baseUrl}/lei-records/${normalized}`);
    const body = await this.request<ApiResponse>(url, true);
    const records = recordsOf(body);
    return records[0] ?? null;
  }

  /**
   * Parent lookup via the `/direct-parent` and `/ultimate-parent` helpers.
   * Returns null when GLEIF has no reported parent (HTTP 404).
   */
  async getParent(
    lei: string,
    relation: GleifParentRelation,
  ): Promise<GleifParent | null> {
    const normalized = normalizeLei(lei);
    if (!normalized) return null;
    const path = relation === "direct" ? "direct-parent" : "ultimate-parent";
    const url = new URL(`${this.baseUrl}/lei-records/${normalized}/${path}`);
    const body = await this.request<ApiResponse>(url, true);
    const parent = recordsOf(body)[0];
    if (!parent) return null;
    return {
      childLei: normalized,
      parentLei: parent.lei,
      parentName: parent.legalName,
      relation,
      sourceUrl: url.toString(),
    };
  }

  private request<T>(url: URL, allowNotFound = false): Promise<T> {
    const result = this.gate.then(async () => {
      const wait = Math.max(
        0,
        this.minIntervalMs - (Date.now() - this.lastRequestAt),
      );
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();
      const response = await this.fetchImpl(url.toString(), {
        headers: { Accept: "application/vnd.api+json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status === 404 && allowNotFound) {
        return { data: [] } as T;
      }
      if (!response.ok) {
        throw new Error(`GLEIF responded ${response.status} for ${url.pathname}`);
      }
      return (await response.json()) as T;
    });
    this.gate = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function recordsOf(body: ApiResponse): GleifRecord[] {
  const data = body?.data;
  if (!data) return [];
  const list = Array.isArray(data) ? data : [data];
  const output: GleifRecord[] = [];
  for (const item of list) {
    const attributes = item.attributes;
    const lei = normalizeLei(attributes?.lei);
    const legalName = attributes?.entity?.legalName?.name?.trim();
    if (!lei || !legalName) continue;
    output.push({
      lei,
      legalName,
      ...(attributes?.entity?.legalName?.language
        ? { language: attributes.entity.legalName.language }
        : {}),
      otherNames: (attributes?.entity?.otherNames ?? [])
        .map((entry) => entry.name?.trim())
        .filter((value): value is string => Boolean(value)),
      ...(attributes?.entity?.status
        ? { status: attributes.entity.status }
        : {}),
      ...(attributes?.entity?.legalAddress?.country
        ? { country: attributes.entity.legalAddress.country }
        : {}),
      ...(attributes?.entity?.jurisdiction
        ? { jurisdiction: attributes.entity.jurisdiction }
        : {}),
      ...(attributes?.entity?.category
        ? { category: attributes.entity.category }
        : {}),
    });
  }
  return output;
}

/**
 * Pick a unique LEI from a name search.
 *
 * A candidate is eligible only when its legal name or a registered other name
 * equals one of our names after cosmetic normalization. Inactive/annual-report
 * only records are ignored. When more than one eligible candidate remains, the
 * result is an ambiguity, not a guess.
 */
export function matchGleifLei(
  records: GleifRecord[],
  names: string[],
  allowedCountries: string[] = [],
): GleifLeiResolution | GleifLeiAmbiguity | null {
  const wanted = new Map<string, string>();
  for (const name of names) {
    const normalized = normalizeFullName(name);
    if (normalized) wanted.set(normalized, name);
  }
  if (wanted.size === 0) return null;

  const eligible: Array<{ record: GleifRecord; name: string; rule: GleifLeiResolution["rule"] }> = [];
  for (const record of records) {
    if (record.status && record.status !== "ACTIVE") continue;
    if (record.category && record.category !== "GENERAL") continue;
    const legal = normalizeFullName(record.legalName);
    if (wanted.has(legal)) {
      eligible.push({ record, name: wanted.get(legal)!, rule: "exact-legal-name" });
      continue;
    }
    for (const other of record.otherNames) {
      const normalized = normalizeFullName(other);
      if (wanted.has(normalized)) {
        eligible.push({ record, name: wanted.get(normalized)!, rule: "exact-other-name" });
        break;
      }
    }
  }

  const preferred =
    allowedCountries.length > 0
      ? eligible.filter(
          (entry) =>
            entry.record.country !== undefined &&
            allowedCountries.includes(entry.record.country),
        )
      : eligible;
  const pool = preferred.length > 0 ? preferred : eligible;
  const unique = [...new Map(pool.map((entry) => [entry.record.lei, entry])).values()];

  if (unique.length === 1) {
    const [match] = unique;
    return {
      lei: match!.record.lei,
      record: match!.record,
      matchedName: match!.name,
      rule: match!.rule,
      candidates: records.length,
    };
  }
  if (unique.length > 1) {
    return {
      names: [...wanted.values()],
      candidates: unique.map((entry) => ({
        lei: entry.record.lei,
        legalName: entry.record.legalName,
        ...(entry.record.country ? { country: entry.record.country } : {}),
      })),
    };
  }
  return null;
}

export function isGleifResolution(
  value: GleifLeiResolution | GleifLeiAmbiguity | null,
): value is GleifLeiResolution {
  return Boolean(value && "lei" in value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

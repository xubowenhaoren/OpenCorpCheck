import { normalizeName, normalizeQid } from "./text.js";

/**
 * Conservative Wikidata QID resolution.
 *
 * The API's search is fuzzy, so a candidate is accepted only when its label is
 * an exact normalized match and its description looks like a company. More
 * than one eligible item is an ambiguity and is reported, never merged.
 */

export const DEFAULT_WIKIDATA_BASE_URL = "https://www.wikidata.org/w/api.php";
const USER_AGENT = "OpenCorpCheck/0.1 (entity-resolution; +https://github.com/xubowenhaoren)";

const COMPANY_DESCRIPTION =
  /company|corporation|enterprise|business|bank|insurer|insurance|airline|retailer|manufacturer|conglomerate|technology|software|semiconductor|automaker|holding|group|公司|企业|集团|银行|保险|制造|科技|控股|股份|证券|能源|汽车|医药/i;

export interface WikidataCandidate {
  qid: string;
  label: string;
  description?: string;
}

export interface WikidataResolution {
  qid: string;
  label: string;
  description?: string;
  rule: "exact-label";
}

export interface WikidataAmbiguity {
  names: string[];
  candidates: WikidataCandidate[];
}

export interface WikidataClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  minIntervalMs?: number;
}

interface SearchResponse {
  search?: Array<{
    id?: string;
    label?: string;
    description?: string;
    match?: { type?: string; language?: string; text?: string };
  }>;
}

export class WikidataClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  private gate: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(options: WikidataClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_WIKIDATA_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    // Wikidata's public endpoint rate-limits aggressive clients; 500 ms keeps
    // a full 236-company sweep politely below its threshold.
    this.minIntervalMs = options.minIntervalMs ?? 500;
  }

  async search(name: string, language: "en" | "zh" = "en"): Promise<WikidataCandidate[]> {
    const url = new URL(this.baseUrl);
    url.searchParams.set("action", "wbsearchentities");
    url.searchParams.set("search", name);
    url.searchParams.set("language", language);
    url.searchParams.set("uselang", language);
    url.searchParams.set("type", "item");
    url.searchParams.set("limit", "10");
    url.searchParams.set("format", "json");
    const body = await this.request(url);
    return (body.search ?? [])
      .map((entry) => ({
        qid: normalizeQid(entry.id) ?? "",
        label: entry.label?.trim() ?? "",
        ...(entry.description?.trim() ? { description: entry.description.trim() } : {}),
      }))
      .filter((entry) => entry.qid && entry.label);
  }

  private request(url: URL): Promise<SearchResponse> {
    const result = this.gate.then(async () => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const wait = Math.max(
          0,
          this.minIntervalMs - (Date.now() - this.lastRequestAt),
        );
        if (wait > 0) await sleep(wait);
        this.lastRequestAt = Date.now();
        const response = await this.fetchImpl(url.toString(), {
          headers: { Accept: "application/json", "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.status === 429 || response.status >= 500) {
          const retryAfter = Number(response.headers.get("retry-after"));
          const waitMs =
            Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1_000
              : 1_000 * 2 ** attempt;
          lastError = new Error(`Wikidata responded ${response.status}`);
          await sleep(waitMs);
          continue;
        }
        if (!response.ok) {
          throw new Error(`Wikidata responded ${response.status}`);
        }
        return (await response.json()) as SearchResponse;
      }
      throw lastError instanceof Error
        ? lastError
        : new Error("Wikidata request failed");
    });
    this.gate = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * Accept a QID only for an exact label whose description is company-like.
 *
 * "Exact" is after cosmetic normalization plus a trailing legal suffix
 * (`Inc.`, `Ltd`, `Holdings`, `Group`, …). This catches the common Wikidata
 * case where the label drops the corporate suffix ("Adobe" for "Adobe Inc.")
 * without allowing substring matching. The description filter rejects
 * non-company meanings of the same word (e.g. the fruit "Apple").
 */
export function matchWikidataQid(
  candidates: WikidataCandidate[],
  names: string[],
): WikidataResolution | WikidataAmbiguity | null {
  const wanted = new Set(
    names
      .flatMap((name) => [name, name.replace(/\.com\b/gi, "")])
      .flatMap(wikidataKeys),
  );
  if (wanted.size === 0) return null;
  const eligible = candidates.filter(
    (candidate) =>
      wikidataKeys(candidate.label).some((key) => wanted.has(key)) &&
      Boolean(candidate.description && COMPANY_DESCRIPTION.test(candidate.description)),
  );
  const unique = [...new Map(eligible.map((entry) => [entry.qid, entry])).values()];
  if (unique.length === 1) {
    const [match] = unique;
    return {
      qid: match!.qid,
      label: match!.label,
      ...(match!.description ? { description: match!.description } : {}),
      rule: "exact-label",
    };
  }
  if (unique.length > 1) {
    return { names: [...wanted], candidates: unique };
  }
  return null;
}

function wikidataKeys(value: string): string[] {
  const normalized = normalizeName(value);
  if (!normalized) return [];
  const keys = new Set([normalized]);
  const withoutCorporateSuffix = normalized.replace(/(holdings?|group)$/, "");
  if (withoutCorporateSuffix) keys.add(withoutCorporateSuffix);
  return [...keys];
}

export function isWikidataResolution(
  value: WikidataResolution | WikidataAmbiguity | null,
): value is WikidataResolution {
  return Boolean(value && "qid" in value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

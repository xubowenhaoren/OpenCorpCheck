import { matchName } from "./matching.js";
import type { OwnershipEdgeDraft } from "./types.js";

/**
 * HKEX Disclosure of Interests (DION) ownership planner.
 *
 * The browser sidecar returns substantial-shareholder notices as raw strings.
 * This module only interprets the long-position (`(L)`) line, matches the
 * holder by exact normalized name, and emits `invests_in` edges. A substantial
 * shareholder notice is a reporting threshold, not a control statement, so we
 * never turn it into `owns` from the percentage alone.
 */

export const HKEX_DION_VERSION = "hkex-dion-v1";

export interface DionNotice {
  serial: string;
  shareholder: string;
  reason_code?: string | null;
  reason?: string | null;
  shares?: string | null;
  avg_price?: string | null;
  holdings?: string | null;
  percent?: string | null;
  event_date?: string | null;
  url?: string | null;
}

export interface DionResponse {
  code: string;
  name?: string | null;
  from_date?: string | null;
  to_date?: string | null;
  total_records?: number;
  pages?: number;
  truncated?: boolean;
  notices: DionNotice[];
  errors?: string[];
}

export interface DionPlanOptions {
  issuerCompanyId: string;
  issuerCode: string;
  issuerName: string;
  notices: DionNotice[];
  holderByName: Map<string, string | null>;
}

export interface DionStats {
  notices: number;
  noticesWithLongPosition: number;
  holdersMatched: number;
  holdersUnmatched: number;
  ambiguousHolders: number;
  selfNotices: number;
  edges: number;
  latestEventDate: string | null;
  /** Distinct out-of-universe holder names, for the coverage report. */
  unmatchedHolderNames: string[];
  ambiguousHolderNames: string[];
}

export interface DionPlan {
  edges: OwnershipEdgeDraft[];
  stats: DionStats;
}

interface AggregatedNotice {
  holderCompanyId: string;
  holderName: string;
  serial: string;
  eventDate: string;
  percent: number;
  shares: number | null;
  holdingsRaw: string;
  reasonCode: string | null;
  reason: string | null;
  url: string | null;
}

export function planDionOwnership(options: DionPlanOptions): DionPlan {
  const matched = new Map<string, AggregatedNotice>();
  const matchedHolders = new Set<string>();
  const unmatchedHolders = new Set<string>();
  const ambiguousHolders = new Set<string>();
  let noticesWithLongPosition = 0;
  let selfNotices = 0;
  let latestEventDate: string | null = null;

  for (const notice of options.notices) {
    const serial = (notice.serial ?? "").trim();
    const holderName = (notice.shareholder ?? "").trim();
    if (!serial || !holderName) continue;
    const percent = parseDionLongPercent(notice.percent);
    const eventDate = parseDionEventDate(notice.event_date);
    if (percent === null || !eventDate) continue;
    noticesWithLongPosition += 1;
    if (latestEventDate === null || eventDate > latestEventDate) {
      latestEventDate = eventDate;
    }
    const match = matchName(options.holderByName, holderName);
    if (match.ambiguous) {
      ambiguousHolders.add(holderName);
      continue;
    }
    if (!match.companyId) {
      unmatchedHolders.add(holderName);
      continue;
    }
    if (match.companyId === options.issuerCompanyId) {
      selfNotices += 1;
      continue;
    }
    matchedHolders.add(match.companyId);
    // `notice.shares` is the transaction size, not the position; only the
    // holdings-after-event cell is an ownership quantity.
    const shares = parseDionLongShares(notice.holdings ?? null);
    const existing = matched.get(match.companyId);
    if (!existing) {
      matched.set(match.companyId, {
        holderCompanyId: match.companyId,
        holderName,
        serial,
        eventDate,
        percent,
        shares,
        holdingsRaw: notice.holdings ?? "",
        reasonCode: notice.reason_code ?? null,
        reason: notice.reason ?? null,
        url: notice.url ?? null,
      });
      continue;
    }
    if (
      eventDate > existing.eventDate ||
      (eventDate === existing.eventDate && serial > existing.serial)
    ) {
      existing.holderName = holderName;
      existing.serial = serial;
      existing.eventDate = eventDate;
      existing.percent = percent;
      existing.shares = shares;
      existing.holdingsRaw = notice.holdings ?? "";
      existing.reasonCode = notice.reason_code ?? null;
      existing.reason = notice.reason ?? null;
      existing.url = notice.url ?? null;
    }
  }

  const edges: OwnershipEdgeDraft[] = [...matched.values()]
    .sort((left, right) =>
      left.eventDate === right.eventDate
        ? left.serial.localeCompare(right.serial)
        : right.eventDate.localeCompare(left.eventDate),
    )
    .map((edge) => {
      const shares =
        edge.shares === null
          ? "shares not stated"
          : `${formatInteger(edge.shares)} shares`;
      const quote = [
        `HKEX DI notice ${edge.serial}`,
        edge.eventDate,
        `${edge.percent}% long position`,
        shares,
      ].join(" · ");
      const sourceUrl =
        edge.url ??
        "https://www2.hkexnews.hk/Shareholding-Disclosures/Disclosure-of-Interests/Search-facilities---DI-from-3-July-2017?sc_lang=en";
      return {
        srcCompanyId: edge.holderCompanyId,
        dstCompanyId: options.issuerCompanyId,
        type: "invests_in" as const,
        quote,
        sourceUrl,
        sourceTitle: `HKEX Disclosure of Interests — ${edge.holderName} — ${options.issuerName}`,
        confidence: 0.9,
        validFrom: edge.eventDate,
        publishedAt: dateOrUndefined(edge.eventDate),
        metadata: {
          source: "hkex-dion",
          serial: edge.serial,
          eventDate: edge.eventDate,
          percent: edge.percent,
          shares: edge.shares,
          holdingsRaw: edge.holdingsRaw,
          reasonCode: edge.reasonCode,
          reason: edge.reason,
          code: options.issuerCode,
          issuerName: options.issuerName,
        },
        extractorVersion: HKEX_DION_VERSION,
        origin: "hkex-dion",
      };
    });

  return {
    edges,
    stats: {
      notices: options.notices.length,
      noticesWithLongPosition,
      holdersMatched: matchedHolders.size,
      holdersUnmatched: unmatchedHolders.size,
      ambiguousHolders: ambiguousHolders.size,
      selfNotices,
      edges: edges.length,
      latestEventDate,
      unmatchedHolderNames: [...unmatchedHolders].sort(),
      ambiguousHolderNames: [...ambiguousHolders].sort(),
    },
  };
}

/** `6.37(L)` or `6.37(L)\n3.36(S)` → 6.37; null when there is no long line. */
export function parseDionLongPercent(raw: string | null | undefined): number | null {
  const line = findLongLine(raw);
  if (!line) return null;
  // DION prints `6.37(L)` (no percent sign); accept one if present.
  const match = line.replace(/%/g, "").match(/(-?\d+(?:\.\d+)?)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** `1,093,870,212(L)\n575,953,952(S)` → 1093870212. */
export function parseDionLongShares(raw: string | null | undefined): number | null {
  const line = findLongLine(raw);
  if (!line) return null;
  const match = line.replace(/,/g, "").match(/(-?\d+(?:\.\d+)?)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** `25/07/2025` → `2025-07-25`; ISO passes through. */
export function parseDionEventDate(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (!match) return null;
  const day = match[1]!.padStart(2, "0");
  const month = match[2]!.padStart(2, "0");
  return `${match[3]}-${month}-${day}`;
}

function findLongLine(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const long = lines.find((line) => /\(\s*L\s*\)/i.test(line));
  if (long) return long;
  // A single number with no position marker is still a long position.
  if (lines.length === 1 && !/\(\s*[SP]\s*\)/i.test(lines[0]!)) {
    return lines[0]!;
  }
  return null;
}

function formatInteger(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function dateOrUndefined(value: string): Date | undefined {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export class DionClient {
  constructor(private readonly baseUrl: string) {}

  async notices(
    code: string,
    options: { days?: number; maxPages?: number } = {},
  ): Promise<DionResponse> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/v1/dion/notices`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code,
          days: options.days ?? 365,
          max_pages: options.maxPages ?? 10,
        }),
      });
    } catch (error) {
      throw new Error(
        `HKEX DION sidecar is unavailable at ${url} (${messageOf(error)}); ` +
          "start it with `cd services/finance-analyst && uv run occ-f10 serve --port 8090`",
      );
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `HKEX DION sidecar HTTP ${response.status}: ${detail.slice(0, 300)}`,
      );
    }
    return (await response.json()) as DionResponse;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

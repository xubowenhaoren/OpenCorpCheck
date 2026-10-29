import type { RelationType } from "@occ/core";

import { RELATION_TYPES, type UniverseCompany } from "./prompt.js";

export interface RawRelation {
  dst_ticker?: string;
  dst_name?: string;
  type?: string;
  quote?: string;
  refs?: unknown;
  confidence?: unknown;
}

export interface ValidatedRelation {
  dstCompanyId: string;
  dstTicker: string;
  type: RelationType;
  quote: string;
  refs: number[];
  confidence: number;
}

export interface ValidationResult {
  accepted: ValidatedRelation[];
  dropped: Array<{ reason: string; raw: RawRelation }>;
}

function normalize(value: string): string {
  return value
    .replace(/\[\d+\]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

/** JSON-mode models still wrap output in fences or prose sometimes. */
export function parseRelationsJson(text: string): RawRelation[] {
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1)) as {
      relations?: unknown;
    };
    return Array.isArray(parsed.relations)
      ? (parsed.relations as RawRelation[])
      : [];
  } catch {
    return [];
  }
}

function resolveCandidate(
  raw: RawRelation,
  candidates: UniverseCompany[],
): UniverseCompany | undefined {
  const ticker = raw.dst_ticker?.trim().toUpperCase();
  if (ticker) {
    const byTicker = candidates.find(
      (candidate) => candidate.ticker.toUpperCase() === ticker,
    );
    if (byTicker) return byTicker;
  }
  const name = raw.dst_name?.trim().toLowerCase();
  if (!name) return undefined;
  return candidates.find((candidate) =>
    candidate.names.some((value) => value.toLowerCase() === name),
  );
}

export function validateRelations(input: {
  raw: RawRelation[];
  candidates: UniverseCompany[];
  chapterText: string;
  citationRefs: number[];
  selfCompanyId: string;
}): ValidationResult {
  const accepted: ValidatedRelation[] = [];
  const dropped: Array<{ reason: string; raw: RawRelation }> = [];
  const seen = new Set<string>();
  const normalizedChapter = normalize(input.chapterText);
  const citationSet = new Set(input.citationRefs);
  const requireRef = input.citationRefs.length > 0;

  for (const relation of input.raw.slice(0, 40)) {
    const candidate = resolveCandidate(relation, input.candidates);
    if (!candidate || candidate.id === input.selfCompanyId) {
      dropped.push({ reason: "unknown_or_self_destination", raw: relation });
      continue;
    }
    if (!RELATION_TYPES.includes(relation.type as RelationType)) {
      dropped.push({ reason: "invalid_type", raw: relation });
      continue;
    }
    const quote = typeof relation.quote === "string" ? relation.quote.trim() : "";
    if (!quote || !normalizedChapter.includes(normalize(quote))) {
      dropped.push({ reason: "quote_not_in_source", raw: relation });
      continue;
    }
    const refs = Array.isArray(relation.refs)
      ? relation.refs
          .map((value) => Number(value))
          .filter(
            (value): value is number =>
              Number.isInteger(value) && citationSet.has(value),
          )
      : [];
    if (requireRef && refs.length === 0) {
      dropped.push({ reason: "missing_valid_citation", raw: relation });
      continue;
    }

    const confidence = Math.max(
      0,
      Math.min(1, Number(relation.confidence) || (refs.length > 0 ? 0.65 : 0.5)),
    );
    const key = `${candidate.id}|${relation.type}|${normalize(quote)}`;
    if (seen.has(key)) {
      dropped.push({ reason: "duplicate", raw: relation });
      continue;
    }
    seen.add(key);
    accepted.push({
      dstCompanyId: candidate.id,
      dstTicker: candidate.ticker,
      type: relation.type as RelationType,
      quote,
      refs,
      confidence,
    });
  }

  // A sentence often yields both a specific type and a redundant `other`.
  // Keep the specific one; distinct specific types are allowed.
  const specific = new Set(
    accepted
      .filter((relation) => relation.type !== "other")
      .map((relation) => `${relation.dstCompanyId}|${normalize(relation.quote)}`),
  );

  return {
    accepted: accepted.filter(
      (relation) =>
        relation.type !== "other" ||
        !specific.has(`${relation.dstCompanyId}|${normalize(relation.quote)}`),
    ),
    dropped,
  };
}

import { sql } from "drizzle-orm";

import type { Market } from "@occ/core";
import {
  getExtractionCache,
  upsertCitationSources,
  upsertExtractionCache,
  upsertFacts,
  upsertFinancialFacts,
  type Db,
  type NewFact,
  type NewFinancialFact,
} from "@occ/db";
import {
  sha256Text,
  type ParsedSection,
  type SectionChapter,
} from "@occ/ingest";

import { parseDataCutoff, parseSourceChapter } from "./citations.js";
import { extractFinancials } from "./financials.js";
import { parseFiscalYearEnd } from "./periods.js";
import { extractSegmentFacts } from "./segments.js";
import { extractSnapshotFacts, type FactDraft } from "./snapshot.js";
import { extractTimelineFacts } from "./timeline.js";

export const DETERMINISTIC_EXTRACTOR_VERSION = "deterministic-v1";

export interface ExtractError {
  stage: string;
  message: string;
}

export interface ExtractInput {
  db: Db;
  companyId: string;
  markdown: string;
  parsed: ParsedSection;
  market: Market;
  /** Source row for the research profile, used when a row has no citation. */
  profileSourceId?: string;
  force?: boolean;
  now?: Date;
}

export interface ExtractResult {
  companyId: string;
  skipped: boolean;
  financialFacts: number;
  facts: number;
  errors: ExtractError[];
}

function chapter(
  parsed: ParsedSection,
  name: string,
): SectionChapter | undefined {
  const normalized = name.replace(/\s+/g, "");
  return parsed.chapters.find(
    (entry) => entry.section.replace(/\s+/g, "") === normalized,
  );
}

function chapterStartsWith(
  parsed: ParsedSection,
  prefix: string,
): SectionChapter | undefined {
  return parsed.chapters.find((entry) => entry.section.startsWith(prefix));
}

function withSource<T extends { sourceRef?: number }>(
  draft: T,
  sourceByRef: Map<number, string>,
  fallback?: string,
): T & { sourceId?: string } {
  const mapped = draft.sourceRef
    ? (sourceByRef.get(draft.sourceRef) ?? fallback)
    : fallback;
  return { ...draft, sourceId: mapped };
}

/**
 * Extract financials, snapshot facts, segment revenue and timeline events from
 * one research section. Deterministic only: no network calls.
 */
export async function extractCompany(input: ExtractInput): Promise<ExtractResult> {
  const { db, companyId } = input;
  const started = Date.now();
  const inputSha256 = sha256Text(input.markdown);
  const errors: ExtractError[] = [];

  if (!input.force) {
    const cached = await getExtractionCache(db, companyId, "deterministic");
    if (
      cached &&
      cached.status === "ok" &&
      cached.inputSha256 === inputSha256
    ) {
      const stats = cached.stats as
        | { financialFacts?: number; facts?: number }
        | undefined;
      return {
        companyId,
        skipped: true,
        financialFacts: stats?.financialFacts ?? 0,
        facts: stats?.facts ?? 0,
        errors: [],
      };
    }
  }

  const citations = parseSourceChapter(
    chapter(input.parsed, "来源")?.text ?? "",
  );
  const dataCutoff = parseDataCutoff(input.markdown);
  const snapshotChapter = chapter(input.parsed, "公司快照");
  const fye = parseFiscalYearEnd(snapshotChapter?.text ?? "");
  const financeChapter = chapterStartsWith(input.parsed, "财务表现");

  let financials: ReturnType<typeof extractFinancials> = [];
  let facts: FactDraft[] = [];

  try {
    if (financeChapter) {
      financials = extractFinancials({
        companyId,
        chapter: financeChapter,
        market: input.market,
        fye,
        dataCutoff,
      });
    }
  } catch (error) {
    errors.push({ stage: "financials", message: messageOf(error) });
  }

  const addFacts = (stage: string, fn: () => FactDraft[]) => {
    try {
      facts.push(...fn());
    } catch (error) {
      errors.push({ stage, message: messageOf(error) });
    }
  };

  if (snapshotChapter) {
    addFacts("snapshot", () =>
      extractSnapshotFacts({ companyId, chapter: snapshotChapter, dataCutoff }),
    );
  }
  const segmentChapter = chapterStartsWith(input.parsed, "业务与收入结构");
  if (segmentChapter) {
    addFacts("segments", () =>
      extractSegmentFacts({
        companyId,
        chapter: segmentChapter,
        market: input.market,
        dataCutoff,
      }),
    );
  }
  const timelineChapter =
    chapter(input.parsed, "近12个月大事") ??
    chapter(input.parsed, "近 12 个月大事");
  if (timelineChapter) {
    addFacts("timeline", () =>
      extractTimelineFacts({ companyId, chapter: timelineChapter, dataCutoff }),
    );
  }

  const now = input.now ?? new Date();
  const sourceByRef = await upsertCitationSources(db, citations, now);

  const financialRows: NewFinancialFact[] = financials.map((draft) => {
    const sourced = withSource(draft, sourceByRef, input.profileSourceId);
    return {
      id: draft.id,
      companyId: draft.companyId,
      statement: draft.statement,
      item: draft.item,
      periodKind: draft.periodKind,
      periodLabel: draft.periodLabel,
      periodStart: draft.periodStart,
      periodEnd: draft.periodEnd,
      fiscalYear: draft.fiscalYear,
      fiscalQuarter: draft.fiscalQuarter,
      value: draft.value,
      unit: draft.unit,
      currency: draft.currency,
      sourceId: sourced.sourceId,
      quote: draft.quote,
      method: draft.method,
      confidence: draft.confidence,
      extractorVersion: DETERMINISTIC_EXTRACTOR_VERSION,
      sourceRefs: draft.sourceRefs,
    };
  });

  const factRows: NewFact[] = facts.map((draft) => {
    const sourced = withSource(draft, sourceByRef, input.profileSourceId);
    return {
      id: draft.id,
      companyId: draft.companyId,
      predicate: draft.predicate,
      value: draft.value,
      sourceId: sourced.sourceId,
      quote: draft.quote,
      method: draft.method,
      confidence: draft.confidence,
      observedAt: draft.observedAt,
      extractorVersion: DETERMINISTIC_EXTRACTOR_VERSION,
      sourceRefs: draft.sourceRefs,
    };
  });

  const status = errors.length === 0 ? "ok" : "partial";
  await db.transaction(async (tx) => {
    const executor = tx as unknown as Db;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`occ:extract:${companyId}`}))`,
    );
    await upsertFinancialFacts(executor, financialRows);
    await upsertFacts(executor, factRows);
    await upsertExtractionCache(executor, {
      companyId,
      stage: "deterministic",
      inputSha256,
      status,
      stats: {
        financialFacts: financialRows.length,
        facts: factRows.length,
        citations: citations.length,
        extractorVersion: DETERMINISTIC_EXTRACTOR_VERSION,
      },
      error: errors.length > 0 ? errors.map((entry) => entry.message).join("; ") : undefined,
      durationMs: Date.now() - started,
    });
  });

  return {
    companyId,
    skipped: false,
    financialFacts: financialRows.length,
    facts: factRows.length,
    errors,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

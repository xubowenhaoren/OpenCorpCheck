import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { and, eq, sql } from "drizzle-orm";

import type { Market } from "@occ/core";
import {
  financialFactId,
  financialFacts,
  getExtractionCache,
  upsertExtractionCache,
  upsertFinancialFacts,
  upsertSourceRecord,
  type Db,
  type NewFinancialFact,
} from "@occ/db";
import {
  mergeFinancialSources,
  parseEdgarFinancials,
  parseF10Financials,
  type CanonicalFinancialFact,
  type SourcedFinancialFact,
} from "@occ/extract";
import { FinanceAnalystClient } from "@occ/sources-eastmoney-f10";

import { config, ensureDir } from "../config.js";
import {
  fetchEdgarCompanyFacts,
  fetchEdgarSubmissions,
  resolveEdgarCik,
} from "./edgar-client.js";

/**
 * A/HK statements come from Eastmoney F10. US is EDGAR-only (decision
 * 2026-11-01): the F10 US page is a secondary repackaging with cumulative
 * quarters, so it is neither fetched nor written.
 */
const F10_PAGE: Partial<Record<Market, string>> = {
  A: "cwfx",
  HK: "NewFinancialAnalysis",
};

const F10_EXTRACTOR = "f10-cwfx-v1";
const EDGAR_EXTRACTOR = "edgar-xbrl-v1";

export interface FinancialsRunInput {
  db: Db;
  companyId: string;
  ticker: string;
  code: string;
  market: Market;
  force?: boolean;
  signal?: AbortSignal;
  now?: Date;
}

export interface FinancialsRunOutcome {
  status: "ok" | "partial" | "skipped";
  written: number;
  f10?: {
    facts: number;
    periods: number;
    fetched: boolean;
    error?: string;
  };
  edgar?: {
    facts: number;
    periods: number;
    cik: string;
    error?: string;
  };
  comparison?: ReturnType<typeof mergeFinancialSources>["comparison"];
  warnings: string[];
  error?: string;
}

interface Snapshot {
  meta?: Record<string, unknown>;
  page: {
    page?: string;
    label?: string;
    url: string;
    text?: string;
    tables?: Array<{ caption?: string; headers: string[]; rows: string[][] }>;
    error?: string | null;
    http_status?: number | null;
  };
}

/**
 * Fetch (or reuse cached) F10 + EDGAR statements, merge by precedence and
 * write `financial_facts`. A failed parse leaves prior rows untouched.
 */
export async function runFinancials(
  input: FinancialsRunInput,
): Promise<FinancialsRunOutcome> {
  const startedAt = Date.now();
  const now = input.now ?? new Date();
  const warnings: string[] = [];
  const errors: string[] = [];
  const usesF10 = input.market !== "US";

  const f10 = usesF10
    ? await loadF10(input).catch((error: unknown) => {
        const message = messageOf(error);
        errors.push(`f10: ${message}`);
        return {
          facts: [] as CanonicalFinancialFact[],
          periods: 0,
          currency:
            input.market === "A"
              ? "CNY"
              : input.market === "HK"
                ? "HKD"
                : "USD",
          warnings: [] as string[],
          fetched: false,
          tables: 0,
          error: message,
        };
      })
    : null;
  const f10Facts = f10?.facts ?? [];

  const edgar =
    input.market === "US"
      ? await loadEdgar(input).catch((error: unknown) => {
          const message = messageOf(error);
          errors.push(`edgar: ${message}`);
          return null;
        })
      : null;

  warnings.push(...(f10?.warnings ?? []));
  if (edgar) warnings.push(...edgar.warnings);

  const sources: Array<{ method: string; facts: CanonicalFinancialFact[] }> = [];
  if (edgar && edgar.facts.length > 0) {
    sources.push({ method: "xbrl", facts: edgar.facts });
  }
  if (f10Facts.length > 0) {
    sources.push({ method: "f10", facts: f10Facts });
  }
  if (sources.length === 0) {
    const error =
      errors.length > 0
        ? errors.join("; ")
        : "no structured financial facts parsed";
    await upsertExtractionCache(input.db, {
      companyId: input.companyId,
      stage: "financials",
      inputSha256: sha256(
        JSON.stringify({ key: input.ticker, market: input.market, at: now.toISOString() }),
      ),
      status: "failed",
      stats: {
        f10: f10Facts.length,
        edgar: edgar?.facts.length ?? 0,
        warnings,
      },
      error,
      durationMs: Date.now() - startedAt,
    });
    return {
      status: "partial",
      written: 0,
      ...(f10
        ? {
            f10: {
              facts: f10.facts.length,
              periods: f10.periods,
              fetched: f10.fetched,
              ...(f10.error ? { error: f10.error } : {}),
            },
          }
        : {}),
      ...(edgar
        ? {
            edgar: {
              facts: edgar.facts.length,
              periods: edgar.periods,
              cik: edgar.cik,
            },
          }
        : {}),
      warnings,
      error,
    };
  }

  const merged = mergeFinancialSources(sources, ["xbrl", "f10"]);
  const inputSha256 = sha256(
    JSON.stringify({
      market: input.market,
      f10: f10Facts,
      edgar: edgar?.facts ?? null,
    }),
  );

  if (!input.force) {
    const cached = await getExtractionCache(
      input.db,
      input.companyId,
      "financials",
    );
    if (
      cached?.status === "ok" &&
      cached.inputSha256 === inputSha256
    ) {
      return {
        status: "skipped",
        written: 0,
        ...(f10
          ? {
              f10: {
                facts: f10.facts.length,
                periods: f10.periods,
                fetched: f10.fetched,
              },
            }
          : {}),
        ...(edgar
          ? {
              edgar: {
                facts: edgar.facts.length,
                periods: edgar.periods,
                cik: edgar.cik,
              },
            }
          : {}),
        comparison: merged.comparison,
        warnings: [...(f10?.warnings ?? []), ...(edgar?.warnings ?? [])],
      };
    }
  }

  const rows = await buildRows(input, merged.facts, now, edgar?.cik);
  const written = await writeFacts(input, rows, merged.facts, {
    f10: f10Facts.length > 0,
    edgar: Boolean(edgar && edgar.facts.length > 0),
  });

  const status = errors.length > 0 ? "partial" : "ok";
  await upsertExtractionCache(input.db, {
    companyId: input.companyId,
    stage: "financials",
    inputSha256,
    status,
    stats: {
      f10: f10
        ? {
            facts: f10.facts.length,
            periods: f10.periods,
            fetched: f10.fetched,
            ...(f10.error ? { error: f10.error } : {}),
          }
        : null,
      edgar: edgar
        ? {
            facts: edgar.facts.length,
            periods: edgar.periods,
            cik: edgar.cik,
            ...(edgar.error ? { error: edgar.error } : {}),
          }
        : null,
      written,
      comparison: merged.comparison,
      warnings,
    },
    error: errors.length > 0 ? errors.join("; ") : undefined,
    durationMs: Date.now() - startedAt,
  });

  return {
    status,
    written,
    ...(f10
      ? {
          f10: {
            facts: f10.facts.length,
            periods: f10.periods,
            fetched: f10.fetched,
            ...(f10.error ? { error: f10.error } : {}),
          },
        }
      : {}),
    ...(edgar
      ? {
          edgar: {
            facts: edgar.facts.length,
            periods: edgar.periods,
            cik: edgar.cik,
            ...(edgar.error ? { error: edgar.error } : {}),
          },
        }
      : {}),
    comparison: merged.comparison,
    warnings,
    ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
  };
}

async function loadF10(input: FinancialsRunInput): Promise<{
  facts: CanonicalFinancialFact[];
  periods: number;
  currency: string;
  warnings: string[];
  fetched: boolean;
  tables: number;
  error?: string;
}> {
  const page = F10_PAGE[input.market];
  if (!page) {
    throw new Error(`F10 statements are not used for market ${input.market}`);
  }
  const file = path.join(config.f10Dir, input.market, input.code, `${page}.json`);
  let snapshot = readSnapshot(file);
  let fetched = false;
  if (input.force || !snapshot) {
    const client = new FinanceAnalystClient({
      baseUrl: config.financeAnalystUrl,
    });
    const response = await client.scrape(
      {
        market: input.market,
        code: input.code,
        pages: [page],
        capture_xhr: false,
      },
      {
        timeoutMs: 180_000,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    const result = response.pages[0];
    if (!result || result.error) {
      throw new Error(result?.error ?? "F10 sidecar returned no page");
    }
    snapshot = {
      meta: response.meta as unknown as Record<string, unknown>,
      page: result,
    };
    saveSnapshot(file, snapshot);
    fetched = true;
  }

  const parsed = parseF10Financials({
    page: {
      ...(snapshot.page.page ? { page: snapshot.page.page } : {}),
      ...(snapshot.page.label ? { label: snapshot.page.label } : {}),
      url: snapshot.page.url,
      tables: snapshot.page.tables ?? [],
      ...(snapshot.meta?.fetched_at &&
      typeof snapshot.meta.fetched_at === "string"
        ? { meta: { fetched_at: snapshot.meta.fetched_at } }
        : {}),
    },
    market: input.market,
  });
  return { ...parsed, fetched };
}

async function loadEdgar(input: FinancialsRunInput): Promise<{
  facts: CanonicalFinancialFact[];
  periods: number;
  cik: string;
  error?: string;
  warnings: string[];
}> {
  const resolved = await resolveEdgarCik(input.ticker, input.force);
  if (!resolved) {
    throw new Error(
      `ticker ${input.ticker} is not in SEC company_tickers.json`,
    );
  }
  const [companyFacts, submissions] = await Promise.all([
    fetchEdgarCompanyFacts(resolved.cik, input.force),
    fetchEdgarSubmissions(resolved.cik, input.force).catch((error: unknown) => {
      // Filing URLs are attribution only; facts still parse without them.
      console.error(
        JSON.stringify({
          event: "edgar_submissions_failed",
          cik: resolved.cik,
          error: messageOf(error),
        }),
      );
      return undefined;
    }),
  ]);
  const parsed = parseEdgarFinancials({
    companyFacts,
    ...(submissions ? { submissions } : {}),
  });
  return {
    facts: parsed.facts,
    periods: parsed.periods,
    cik: parsed.cik,
    warnings: parsed.warnings,
  };
}

async function buildRows(
  input: FinancialsRunInput,
  facts: SourcedFinancialFact[],
  now: Date,
  cik?: string,
): Promise<NewFinancialFact[]> {
  const sourceIds = new Map<string, string>();
  const rows: NewFinancialFact[] = [];
  for (const fact of facts) {
    const url = fact.sourceUrl ?? fallbackUrl(input, cik);
    let sourceId = sourceIds.get(url);
    if (!sourceId) {
      sourceId = await upsertSourceRecord(input.db, {
        url,
        title: fact.sourceTitle ?? fact.item,
        trustTier: fact.method === "xbrl" ? "filing" : "secondary",
        fetchedAt: now,
        license:
          fact.method === "xbrl"
            ? "Public domain (SEC EDGAR)"
            : "Eastmoney F10; internal research with attribution",
      });
      sourceIds.set(url, sourceId);
    }
    rows.push({
      id: financialFactId({
        companyId: input.companyId,
        statement: fact.statement,
        item: fact.item,
        periodEnd: fact.periodEnd,
        periodKind: fact.periodKind,
      }),
      companyId: input.companyId,
      statement: fact.statement,
      item: fact.item,
      periodKind: fact.periodKind,
      periodLabel: fact.periodLabel,
      periodStart: fact.periodStart,
      periodEnd: fact.periodEnd,
      fiscalYear: fact.fiscalYear,
      fiscalQuarter: fact.fiscalQuarter,
      value: roundValue(fact.value, fact.unit),
      unit: fact.unit,
      currency: fact.currency,
      sourceId,
      quote: fact.quote,
      method: fact.method,
      confidence: fact.confidence,
      extractorVersion:
        fact.method === "xbrl" ? EDGAR_EXTRACTOR : F10_EXTRACTOR,
      sourceRefs: [],
    });
  }
  return rows;
}

async function writeFacts(
  input: FinancialsRunInput,
  rows: NewFinancialFact[],
  facts: SourcedFinancialFact[],
  parsed: { f10: boolean; edgar: boolean },
): Promise<number> {
  return input.db.transaction(async (tx) => {
    const executor = tx as unknown as Db;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`occ:financials:${input.companyId}`}))`,
    );
    if (parsed.edgar) {
      await executor
        .delete(financialFacts)
        .where(
          and(
            eq(financialFacts.companyId, input.companyId),
            eq(financialFacts.extractorVersion, EDGAR_EXTRACTOR),
          ),
        );
    }
    if (parsed.f10) {
      await executor
        .delete(financialFacts)
        .where(
          and(
            eq(financialFacts.companyId, input.companyId),
            eq(financialFacts.extractorVersion, F10_EXTRACTOR),
          ),
        );
    }
    await deleteSupersededProfileFacts(executor, input.companyId, facts);
    // The incoming rank is the method's own tier, so a lower-precedence run
    // cannot clobber filing data written by another market (dual-listed names).
    const filingRows = rows.filter((row) => row.method === "xbrl");
    const secondaryRows = rows.filter((row) => row.method !== "xbrl");
    await upsertFinancialFacts(executor, filingRows, { rank: 30 });
    await upsertFinancialFacts(executor, secondaryRows, { rank: 20 });
    return rows.length;
  });
}

/**
 * Profile extraction writes calendar period ends (`2026-06-30`) while filings
 * use 52/53-week ends (`2026-06-27`). Remove those profile rows once a
 * structured fact covers the same item/kind within a week, so the Financials
 * tab does not show two columns for one period.
 */
async function deleteSupersededProfileFacts(
  tx: Db,
  companyId: string,
  facts: SourcedFinancialFact[],
): Promise<void> {
  const seen = new Set<string>();
  const values: Array<{
    statement: string;
    item: string;
    period_end: string;
    period_kind: string;
  }> = [];
  for (const fact of facts) {
    const key = `${fact.statement}|${fact.item}|${fact.periodEnd}|${fact.periodKind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    values.push({
      statement: fact.statement,
      item: fact.item,
      period_end: fact.periodEnd,
      period_kind: fact.periodKind,
    });
  }
  if (values.length === 0) return;
  await tx.execute(sql`
    WITH superseded AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(values)}::jsonb)
        AS x(statement text, item text, period_end date, period_kind text)
    )
    DELETE FROM financial_facts pf
    USING superseded s
    WHERE pf.company_id = ${companyId}
      AND pf.extractor_version = 'deterministic-v1'
      AND pf.period_kind = s.period_kind
      AND abs(pf.period_end - s.period_end) <= 7
      AND (
        (pf.statement = s.statement AND pf.item = s.item)
        OR (pf.statement = 'per_share' AND pf.item = 'eps'
            AND s.statement = 'income' AND s.item = 'eps_diluted')
      )
  `);
}

function fallbackUrl(input: FinancialsRunInput, cik?: string): string {
  return input.market === "US"
    ? `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik ?? input.ticker}.json`
    : `https://emweb.eastmoney.com/${input.market}/${input.code}`;
}

function roundValue(value: number, unit: string): number {
  if (unit === "percent" || unit === "currency_per_share") {
    return Math.round(value * 1e6) / 1e6;
  }
  return Math.round(value * 100) / 100;
}

function readSnapshot(file: string): Snapshot | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Snapshot;
  } catch {
    return null;
  }
}

function saveSnapshot(file: string, snapshot: Snapshot): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

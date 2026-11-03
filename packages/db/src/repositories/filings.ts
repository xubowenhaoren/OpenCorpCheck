/**
 * P1.5 daily filing refresh state + detected-filing inbox.
 *
 * `company_filing_state` is the per-(company, source) cursor/lease and
 * `filings` is the detection inbox. Both are separate from the user-facing
 * `documents` rows written by `ingestFilings` (P1.4); a detected filing only
 * becomes a document when the `ingest.filing` job succeeds.
 */
import { createHash } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import type {
  FilingRefreshView,
  FilingSourceStateView,
  LatestFilingView,
} from "@occ/core";
import type { Db } from "../client.js";
import { companyFilingState, filings, financialsRefreshState } from "../schema.js";

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows ?? [];
}

export type FilingRefreshStatus =
  | "never"
  | "ok"
  | "changed"
  | "empty"
  | "failed"
  | "paused";

export type FilingPeriodKind = "annual" | "half" | "quarter";

export interface FilingStateSnapshot {
  companyId: string;
  source: string;
  market: string;
  code: string | null;
  cursor: string | null;
  lastCheckedAt: Date | null;
  lastChangedAt: Date | null;
  lastStatus: FilingRefreshStatus;
  nextDueAt: Date | null;
  consecutiveFailures: number;
}

export interface NewFilingRow {
  id: string;
  companyId: string;
  source: string;
  accession: string;
  title: string;
  form?: string | null;
  category?: string | null;
  filedAt?: Date | null;
  /** `YYYY-MM-DD`. */
  periodEnd?: string | null;
  periodic?: boolean;
  periodKind?: FilingPeriodKind | null;
  url: string;
  pdfUrl?: string | null;
  status?: "detected" | "applied";
  metadata?: Record<string, unknown>;
}

export interface FilingRow {
  id: string;
  companyId: string;
  source: string;
  accession: string;
  title: string;
  form: string | null;
  category: string | null;
  filedAt: Date | null;
  periodEnd: string | null;
  periodic: boolean;
  periodKind: FilingPeriodKind | null;
  url: string;
  pdfUrl: string | null;
  contentHash: string | null;
  status: string;
  error: string | null;
  metadata: Record<string, unknown>;
}

/** Stable row id for a detected filing. */
export function filingRowId(source: string, accession: string): string {
  return `fil_${createHash("sha256")
    .update(`${source}|${accession}`)
    .digest("hex")
    .slice(0, 24)}`;
}

interface RawStateRow {
  company_id: string;
  source: string;
  market: string;
  code: string | null;
  cursor: string | null;
  last_checked_at: Date | null;
  last_changed_at: Date | null;
  last_status: FilingRefreshStatus;
  next_due_at: Date | null;
  consecutive_failures: number;
}

function toSnapshot(row: RawStateRow): FilingStateSnapshot {
  return {
    companyId: row.company_id,
    source: row.source,
    market: row.market,
    code: row.code,
    cursor: row.cursor,
    lastCheckedAt: row.last_checked_at,
    lastChangedAt: row.last_changed_at,
    lastStatus: row.last_status,
    nextDueAt: row.next_due_at,
    consecutiveFailures: Number(row.consecutive_failures),
  };
}

type StateSelectRow = typeof companyFilingState.$inferSelect;

function toSnapshotFromSelect(row: StateSelectRow): FilingStateSnapshot {
  return {
    companyId: row.companyId,
    source: row.source,
    market: row.market,
    code: row.code,
    cursor: row.cursor,
    lastCheckedAt: row.lastCheckedAt,
    lastChangedAt: row.lastChangedAt,
    lastStatus: row.lastStatus as FilingRefreshStatus,
    nextDueAt: row.nextDueAt,
    consecutiveFailures: Number(row.consecutiveFailures),
  };
}

const STATE_COLUMNS = sql`
  company_id, source, market, code, cursor, last_checked_at, last_changed_at,
  last_status, next_due_at, consecutive_failures
`;

/** State rows for a set of companies, keyed `${companyId}:${source}`. */
export async function listFilingStates(
  db: Db,
  companyIds: string[],
): Promise<Map<string, FilingStateSnapshot>> {
  const out = new Map<string, FilingStateSnapshot>();
  if (companyIds.length === 0) return out;
  const rows = await db
    .select()
    .from(companyFilingState)
    .where(inArray(companyFilingState.companyId, companyIds));
  for (const row of rows) {
    out.set(`${row.companyId}:${row.source}`, toSnapshotFromSelect(row));
  }
  return out;
}

export async function getFilingState(
  db: Db,
  companyId: string,
  source: string,
): Promise<FilingStateSnapshot | null> {
  const rows = await db
    .select()
    .from(companyFilingState)
    .where(
      and(
        eq(companyFilingState.companyId, companyId),
        eq(companyFilingState.source, source),
      ),
    )
    .limit(1);
  return rows[0] ? toSnapshotFromSelect(rows[0]) : null;
}

/**
 * Claim one company+source before enqueuing its check. Returns the leased
 * state (with the pre-check cursor and last successful check) or null when
 * another producer holds a live lease.
 */
export async function leaseFilingSource(
  db: Db,
  input: {
    companyId: string;
    source: string;
    market: string;
    code: string;
    claimTimeoutMs: number;
    runId: string;
  },
): Promise<FilingStateSnapshot | null> {
  const rows = rowsOf<RawStateRow>(
    await db.execute(sql`
      INSERT INTO company_filing_state (
        company_id, source, market, code, last_status, last_run_id,
        last_enqueued_at, next_due_at, updated_at
      ) VALUES (
        ${input.companyId}, ${input.source}, ${input.market}, ${input.code},
        'never', ${input.runId}, now(),
        now() + (${input.claimTimeoutMs}::int * interval '1 millisecond'),
        now()
      )
      ON CONFLICT (company_id, source) DO UPDATE SET
        market = EXCLUDED.market,
        code = EXCLUDED.code,
        last_run_id = EXCLUDED.last_run_id,
        last_enqueued_at = now(),
        next_due_at = now() + (${input.claimTimeoutMs}::int * interval '1 millisecond'),
        updated_at = now()
      WHERE company_filing_state.next_due_at IS NULL
         OR company_filing_state.next_due_at <= now()
      RETURNING ${STATE_COLUMNS}
    `),
  );
  return rows[0] ? toSnapshot(rows[0]) : null;
}

/** Successful check, including a valid empty window. */
export async function markFilingSourceSuccess(
  db: Db,
  input: {
    companyId: string;
    source: string;
    market: string;
    code: string;
    runId: string;
    status: "ok" | "changed" | "empty";
    cursor: string | null;
    changed: boolean;
    ttlMs: number;
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO company_filing_state (
      company_id, source, market, code, cursor, last_checked_at,
      last_changed_at, last_run_id, last_status, last_error,
      consecutive_failures, last_enqueued_at, next_due_at, updated_at
    ) VALUES (
      ${input.companyId}, ${input.source}, ${input.market}, ${input.code},
      ${input.cursor}, now(),
      ${input.changed ? new Date() : null}::timestamptz,
      ${input.runId}, ${input.status}, NULL,
      0, now(),
      now() + (${input.ttlMs}::int * interval '1 millisecond'), now()
    )
    ON CONFLICT (company_id, source) DO UPDATE SET
      market = EXCLUDED.market,
      code = EXCLUDED.code,
      cursor = EXCLUDED.cursor,
      last_checked_at = now(),
      last_changed_at = COALESCE(
        EXCLUDED.last_changed_at,
        company_filing_state.last_changed_at
      ),
      last_run_id = EXCLUDED.last_run_id,
      last_status = EXCLUDED.last_status,
      last_error = NULL,
      consecutive_failures = 0,
      next_due_at = now() + (${input.ttlMs}::int * interval '1 millisecond'),
      updated_at = now()
  `);
}

/**
 * Failed check: never advances `last_checked_at`; back off and pause after
 * `pauseAfterFailures` so a broken source cannot be hammered.
 */
export async function markFilingSourceFailure(
  db: Db,
  input: {
    companyId: string;
    source: string;
    market: string;
    code: string;
    runId: string;
    error: string;
    ttlMs: number;
    pauseAfterFailures?: number;
  },
): Promise<void> {
  const pauseAfter = input.pauseAfterFailures ?? 5;
  await db.execute(sql`
    INSERT INTO company_filing_state (
      company_id, source, market, code, last_run_id, last_status,
      last_error, consecutive_failures, last_enqueued_at, next_due_at, updated_at
    ) VALUES (
      ${input.companyId}, ${input.source}, ${input.market}, ${input.code},
      ${input.runId}, 'failed', ${input.error.slice(0, 4_000)}, 1, now(),
      now() + LEAST(
        interval '15 minutes',
        (${input.ttlMs}::int * interval '1 millisecond')
      ),
      now()
    )
    ON CONFLICT (company_id, source) DO UPDATE SET
      market = EXCLUDED.market,
      code = EXCLUDED.code,
      last_run_id = EXCLUDED.last_run_id,
      last_status = CASE
        WHEN company_filing_state.consecutive_failures + 1 >= ${pauseAfter}
          THEN 'paused'
        ELSE 'failed'
      END,
      last_error = EXCLUDED.last_error,
      consecutive_failures = company_filing_state.consecutive_failures + 1,
      next_due_at = CASE
        WHEN company_filing_state.consecutive_failures + 1 >= ${pauseAfter}
          THEN now() + (${input.ttlMs}::int * interval '1 millisecond')
        ELSE now() + LEAST(
          make_interval(
            secs => 900 * power(2, company_filing_state.consecutive_failures)
          ),
          (${input.ttlMs}::int * interval '1 millisecond')
        )
      END,
      updated_at = now()
  `);
}

/**
 * Insert only filings this source has not seen before. The global
 * `(source, accession)` key is the detection identity; a rerun returns [].
 */
export async function insertDetectedFilings(
  db: Db,
  rows: NewFilingRow[],
): Promise<FilingRow[]> {
  if (rows.length === 0) return [];
  const inserted = await db
    .insert(filings)
    .values(
      rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        source: row.source,
        accession: row.accession,
        title: row.title,
        form: row.form ?? null,
        category: row.category ?? null,
        filedAt: row.filedAt ?? null,
        periodEnd: row.periodEnd ?? null,
        periodic: Boolean(row.periodic),
        periodKind: row.periodKind ?? null,
        url: row.url,
        pdfUrl: row.pdfUrl ?? null,
        contentHash: null,
        status: row.status ?? "detected",
        error: null,
        metadata: row.metadata ?? {},
        detectedAt: new Date(),
        firstSeenAt: new Date(),
        updatedAt: new Date(),
      })),
    )
    .onConflictDoNothing({ target: [filings.source, filings.accession] })
    .returning();
  return inserted.map(toFilingRow);
}

export async function listFilingsByIds(
  db: Db,
  ids: string[],
): Promise<FilingRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(filings)
    .where(inArray(filings.id, ids));
  return rows.map(toFilingRow);
}

/**
 * Rows still waiting for `ingest.filing`. A check that inserted rows and then
 * failed before enqueuing its follow-ups must recover them on retry; otherwise
 * they would stay `detected` forever because the accession is no longer new.
 */
export async function listDetectedFilings(
  db: Db,
  companyId: string,
  source: string,
): Promise<FilingRow[]> {
  const rows = await db
    .select()
    .from(filings)
    .where(
      and(
        eq(filings.companyId, companyId),
        eq(filings.source, source),
        eq(filings.status, "detected"),
      ),
    )
    .orderBy(sql`${filings.filedAt} DESC NULLS LAST`);
  return rows.map(toFilingRow);
}

export async function markFilingsApplied(
  db: Db,
  updates: Array<{
    id: string;
    status: "applied" | "failed";
    error?: string | null;
    contentHash?: string | null;
  }>,
): Promise<void> {
  for (const update of updates) {
    await db
      .update(filings)
      .set({
        status: update.status,
        error: update.error ?? null,
        ...(update.contentHash !== undefined
          ? { contentHash: update.contentHash }
          : {}),
        processedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(filings.id, update.id));
  }
}

/** Due backlog + per-status counts for `occ-refresh status`. */
export async function getFilingStateTotals(
  db: Db,
  now = new Date(),
): Promise<{
  total: number;
  byStatus: Record<string, number>;
  dueCount: number;
  nextDueAt: Date | null;
}> {
  const statusRows = rowsOf<{ last_status: string; count: number }>(
    await db.execute(sql`
      SELECT last_status, count(*)::int AS count
      FROM company_filing_state
      GROUP BY last_status
    `),
  );
  const summary = rowsOf<{
    total: number;
    due_count: number;
    next_due_at: Date | null;
  }>(
    await db.execute(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (
               WHERE coalesce(next_due_at, '-infinity'::timestamptz) <= ${now}
             )::int AS due_count,
             min(next_due_at) AS next_due_at
      FROM company_filing_state
    `),
  );
  const byStatus: Record<string, number> = {};
  for (const row of statusRows) byStatus[row.last_status] = Number(row.count);
  return {
    total: Number(summary[0]?.total ?? 0),
    byStatus,
    dueCount: Number(summary[0]?.due_count ?? 0),
    nextDueAt: summary[0]?.next_due_at ?? null,
  };
}

/**
 * Company-page status: newest periodic + any filing, cursor roll-up, and
 * whether a check is currently queued/active. Returns null when the company has
 * neither state nor detected filings.
 */
export async function getFilingRefreshView(
  db: Db,
  companyId: string,
): Promise<FilingRefreshView | null> {
  const [stateRows, latestPeriodic, latestAny, pendingRows, financialsRows] =
    await Promise.all([
      db
        .select()
        .from(companyFilingState)
        .where(eq(companyFilingState.companyId, companyId))
        .orderBy(companyFilingState.source),
      db
        .select()
        .from(filings)
        .where(and(eq(filings.companyId, companyId), eq(filings.periodic, true)))
        .orderBy(sql`${filings.filedAt} DESC NULLS LAST`)
        .limit(1),
      db
        .select()
        .from(filings)
        .where(eq(filings.companyId, companyId))
        .orderBy(sql`${filings.filedAt} DESC NULLS LAST`)
        .limit(1),
      rowsOf<{ count: number }>(
        await db.execute(sql`
          SELECT count(*)::int AS count
          FROM backfill_jobs
          WHERE company_id = ${companyId}
            AND queue IN (
              'data.source.check', 'ingest.filing', 'financials.company'
            )
            AND status IN ('queued', 'active', 'failed')
        `),
      ),
      db
        .select()
        .from(financialsRefreshState)
        .where(eq(financialsRefreshState.companyId, companyId))
        .limit(1),
    ]);

  if (stateRows.length === 0 && latestAny.length === 0) return null;

  const statuses = stateRows.map((row) => row.lastStatus);
  const lastStatus = statuses.includes("failed")
    ? "failed"
    : statuses.includes("paused")
      ? "paused"
      : statuses.includes("changed")
        ? "changed"
        : statuses.includes("ok")
          ? "ok"
          : statuses.includes("empty")
            ? "empty"
            : "never";
  const checkedAt = stateRows
    .map((row) => row.lastCheckedAt)
    .filter((value): value is Date => Boolean(value))
    .sort((left, right) => right.getTime() - left.getTime())[0];
  const sources: FilingSourceStateView[] = stateRows.map((row) => ({
    source: row.source,
    market: row.market,
    ...(row.lastCheckedAt
      ? { lastCheckedAt: row.lastCheckedAt.toISOString() }
      : {}),
    ...(row.lastChangedAt
      ? { lastChangedAt: row.lastChangedAt.toISOString() }
      : {}),
    lastStatus: row.lastStatus,
    ...(row.nextDueAt ? { nextDueAt: row.nextDueAt.toISOString() } : {}),
    consecutiveFailures: Number(row.consecutiveFailures),
    ...(row.lastError ? { lastError: row.lastError } : {}),
  }));

  return {
    ...(latestPeriodic[0]
      ? { latest: toLatestFilingView(latestPeriodic[0]) }
      : {}),
    ...(latestAny[0] ? { latestAny: toLatestFilingView(latestAny[0]) } : {}),
    ...(checkedAt ? { lastCheckedAt: checkedAt.toISOString() } : {}),
    lastStatus,
    pending: Number(pendingRows[0]?.count ?? 0) > 0,
    consecutiveFailures: Math.max(
      0,
      ...stateRows.map((row) => Number(row.consecutiveFailures)),
    ),
    sources,
    ...(financialsRows[0]
      ? {
          financials: {
            expectedPeriodEnd: String(
              financialsRows[0].expectedPeriodEnd,
            ).slice(0, 10),
            status: financialsRows[0].status as
              | "pending"
              | "applied"
              | "failed",
            attempts: Number(financialsRows[0].attempts),
            source: financialsRows[0].source,
            ...(financialsRows[0].nextRetryAt
              ? { nextRetryAt: financialsRows[0].nextRetryAt.toISOString() }
              : {}),
            ...(financialsRows[0].lastError
              ? { lastError: financialsRows[0].lastError }
              : {}),
          },
        }
      : {}),
  };
}

type FilingSelectRow = typeof filings.$inferSelect;

export type FinancialsRefreshStatus = "pending" | "applied" | "failed";

export interface FinancialsRefreshRow {
  companyId: string;
  /** `YYYY-MM-DD`. */
  expectedPeriodEnd: string;
  market: string;
  ticker: string;
  code: string;
  name: string | null;
  source: string;
  filingId: string | null;
  status: FinancialsRefreshStatus;
  attempts: number;
  lastError: string | null;
  nextRetryAt: Date | null;
  firstSeenAt: Date;
  updatedAt: Date;
}

interface RawFinancialsRefreshRow {
  company_id: string;
  expected_period_end: string;
  market: string;
  ticker: string;
  code: string;
  name: string | null;
  source: string;
  filing_id: string | null;
  status: FinancialsRefreshStatus;
  attempts: number;
  last_error: string | null;
  next_retry_at: Date | null;
  first_seen_at: Date;
  updated_at: Date;
}

const FINANCIALS_REFRESH_COLUMNS = sql`
  company_id, expected_period_end, market, ticker, code, name, source,
  filing_id, status, attempts, last_error, next_retry_at, first_seen_at,
  updated_at
`;

function toDate(value: Date | string | null): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toFinancialsRefreshRow(
  row: RawFinancialsRefreshRow,
): FinancialsRefreshRow {
  return {
    companyId: row.company_id,
    expectedPeriodEnd: String(row.expected_period_end).slice(0, 10),
    market: row.market,
    ticker: row.ticker,
    code: row.code,
    name: row.name,
    source: row.source,
    filingId: row.filing_id,
    status: row.status,
    attempts: Number(row.attempts),
    lastError: row.last_error,
    nextRetryAt: toDate(row.next_retry_at),
    firstSeenAt: toDate(row.first_seen_at) ?? new Date(0),
    updatedAt: toDate(row.updated_at) ?? new Date(0),
  };
}

/**
 * Record the period a newly detected periodic report expects. A newer period
 * (or a previously failed row) resets the retry schedule; another source
 * reporting the same period keeps the current attempt state.
 */
export async function upsertExpectedFinancialsPeriod(
  db: Db,
  input: {
    companyId: string;
    expectedPeriodEnd: string;
    market: string;
    ticker: string;
    code: string;
    name?: string | null;
    source: string;
    filingId?: string | null;
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO financials_refresh_state (
      company_id, expected_period_end, market, ticker, code, name, source,
      filing_id, status, attempts, next_retry_at, first_seen_at, updated_at
    ) VALUES (
      ${input.companyId}, ${input.expectedPeriodEnd}::date, ${input.market},
      ${input.ticker}, ${input.code}, ${input.name ?? null}, ${input.source},
      ${input.filingId ?? null}, 'pending', 0, now(), now(), now()
    )
    ON CONFLICT (company_id) DO UPDATE SET
      expected_period_end = GREATEST(
        financials_refresh_state.expected_period_end,
        EXCLUDED.expected_period_end
      ),
      market = CASE
        WHEN EXCLUDED.expected_period_end > financials_refresh_state.expected_period_end
          OR financials_refresh_state.status = 'failed'
          THEN EXCLUDED.market ELSE financials_refresh_state.market
      END,
      ticker = CASE
        WHEN EXCLUDED.expected_period_end > financials_refresh_state.expected_period_end
          OR financials_refresh_state.status = 'failed'
          THEN EXCLUDED.ticker ELSE financials_refresh_state.ticker
      END,
      code = CASE
        WHEN EXCLUDED.expected_period_end > financials_refresh_state.expected_period_end
          OR financials_refresh_state.status = 'failed'
          THEN EXCLUDED.code ELSE financials_refresh_state.code
      END,
      name = CASE
        WHEN EXCLUDED.expected_period_end > financials_refresh_state.expected_period_end
          OR financials_refresh_state.status = 'failed'
          THEN EXCLUDED.name ELSE financials_refresh_state.name
      END,
      source = CASE
        WHEN EXCLUDED.expected_period_end > financials_refresh_state.expected_period_end
          OR financials_refresh_state.status = 'failed'
          THEN EXCLUDED.source ELSE financials_refresh_state.source
      END,
      filing_id = CASE
        WHEN EXCLUDED.expected_period_end > financials_refresh_state.expected_period_end
          OR financials_refresh_state.status = 'failed'
          THEN EXCLUDED.filing_id ELSE financials_refresh_state.filing_id
      END,
      status = CASE
        WHEN EXCLUDED.expected_period_end > financials_refresh_state.expected_period_end
          OR financials_refresh_state.status = 'failed'
          THEN 'pending' ELSE financials_refresh_state.status
      END,
      attempts = CASE
        WHEN EXCLUDED.expected_period_end > financials_refresh_state.expected_period_end
          OR financials_refresh_state.status = 'failed'
          THEN 0 ELSE financials_refresh_state.attempts
      END,
      last_error = CASE
        WHEN EXCLUDED.expected_period_end > financials_refresh_state.expected_period_end
          OR financials_refresh_state.status = 'failed'
          THEN NULL ELSE financials_refresh_state.last_error
      END,
      next_retry_at = CASE
        WHEN EXCLUDED.expected_period_end > financials_refresh_state.expected_period_end
          OR financials_refresh_state.status = 'failed'
          THEN now() ELSE financials_refresh_state.next_retry_at
      END,
      first_seen_at = CASE
        WHEN EXCLUDED.expected_period_end > financials_refresh_state.expected_period_end
          OR financials_refresh_state.status = 'failed'
          THEN now() ELSE financials_refresh_state.first_seen_at
      END,
      updated_at = now()
  `);
}

export async function getFinancialsRefreshState(
  db: Db,
  companyId: string,
): Promise<FinancialsRefreshRow | null> {
  const rows = rowsOf<RawFinancialsRefreshRow>(
    await db.execute(sql`
      SELECT ${FINANCIALS_REFRESH_COLUMNS}
      FROM financials_refresh_state
      WHERE company_id = ${companyId}
      LIMIT 1
    `),
  );
  return rows[0] ? toFinancialsRefreshRow(rows[0]) : null;
}

/** Pending rows whose retry time has arrived, oldest first. */
export async function listDueFinancialsRefreshes(
  db: Db,
  now = new Date(),
  limit = 200,
): Promise<FinancialsRefreshRow[]> {
  const rows = rowsOf<RawFinancialsRefreshRow>(
    await db.execute(sql`
      SELECT ${FINANCIALS_REFRESH_COLUMNS}
      FROM financials_refresh_state
      WHERE status = 'pending'
        AND (next_retry_at IS NULL OR next_retry_at <= ${now})
      ORDER BY next_retry_at NULLS FIRST, first_seen_at
      LIMIT ${limit}
    `),
  );
  return rows.map(toFinancialsRefreshRow);
}

/**
 * Lease one due row before enqueuing its catch-up financials job. Returns null
 * when another sweep already holds the lease.
 */
export async function leaseFinancialsRefresh(
  db: Db,
  input: { companyId: string; claimTimeoutMs: number },
): Promise<FinancialsRefreshRow | null> {
  const rows = rowsOf<RawFinancialsRefreshRow>(
    await db.execute(sql`
      UPDATE financials_refresh_state
      SET next_retry_at = now()
            + (${input.claimTimeoutMs}::int * interval '1 millisecond'),
          updated_at = now()
      WHERE company_id = ${input.companyId}
        AND status = 'pending'
        AND (next_retry_at IS NULL OR next_retry_at <= now())
      RETURNING ${FINANCIALS_REFRESH_COLUMNS}
    `),
  );
  return rows[0] ? toFinancialsRefreshRow(rows[0]) : null;
}

/** Latest structured statement date, or null when nothing is stored. */
export async function maxFinancialFactPeriodEnd(
  db: Db,
  companyId: string,
): Promise<string | null> {
  const rows = rowsOf<{ period_end: string | null }>(
    await db.execute(sql`
      SELECT max(period_end)::text AS period_end
      FROM financial_facts
      WHERE company_id = ${companyId}
        AND method IN ('xbrl', 'f10')
    `),
  );
  return rows[0]?.period_end ?? null;
}

export async function markFinancialsRefreshApplied(
  db: Db,
  companyId: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE financials_refresh_state
    SET status = 'applied', last_error = NULL, next_retry_at = NULL,
        updated_at = now()
    WHERE company_id = ${companyId}
  `);
}

export async function markFinancialsRefreshRetry(
  db: Db,
  input: {
    companyId: string;
    attempts: number;
    nextRetryAt: Date;
    error?: string | null;
  },
): Promise<void> {
  await db.execute(sql`
    UPDATE financials_refresh_state
    SET status = 'pending', attempts = ${input.attempts},
        next_retry_at = ${input.nextRetryAt},
        last_error = ${input.error?.slice(0, 4_000) ?? null},
        updated_at = now()
    WHERE company_id = ${input.companyId}
  `);
}

export async function markFinancialsRefreshFailed(
  db: Db,
  input: { companyId: string; attempts: number; error?: string | null },
): Promise<void> {
  await db.execute(sql`
    UPDATE financials_refresh_state
    SET status = 'failed', attempts = ${input.attempts},
        next_retry_at = NULL,
        last_error = ${input.error?.slice(0, 4_000) ?? null},
        updated_at = now()
    WHERE company_id = ${input.companyId}
  `);
}

/** Pending/applied/failed counts for the operator status and the dock. */
export async function getFinancialsRefreshTotals(
  db: Db,
  now = new Date(),
): Promise<{
  total: number;
  pending: number;
  due: number;
  applied: number;
  failed: number;
  nextRetryAt: Date | null;
}> {
  const rows = rowsOf<{
    total: number;
    pending: number;
    due: number;
    applied: number;
    failed: number;
    next_retry_at: Date | null;
  }>(
    await db.execute(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE status = 'pending')::int AS pending,
             count(*) FILTER (
               WHERE status = 'pending'
                 AND (next_retry_at IS NULL OR next_retry_at <= ${now})
             )::int AS due,
             count(*) FILTER (WHERE status = 'applied')::int AS applied,
             count(*) FILTER (WHERE status = 'failed')::int AS failed,
             min(next_retry_at) FILTER (WHERE status = 'pending') AS next_retry_at
      FROM financials_refresh_state
    `),
  );
  const row = rows[0];
  return {
    total: Number(row?.total ?? 0),
    pending: Number(row?.pending ?? 0),
    due: Number(row?.due ?? 0),
    applied: Number(row?.applied ?? 0),
    failed: Number(row?.failed ?? 0),
    nextRetryAt: row?.next_retry_at ?? null,
  };
}

function toFilingRow(row: FilingSelectRow): FilingRow {
  return {
    id: row.id,
    companyId: row.companyId,
    source: row.source,
    accession: row.accession,
    title: row.title,
    form: row.form,
    category: row.category,
    filedAt: row.filedAt,
    periodEnd: row.periodEnd,
    periodic: row.periodic,
    periodKind: row.periodKind as FilingPeriodKind | null,
    url: row.url,
    pdfUrl: row.pdfUrl,
    contentHash: row.contentHash,
    status: row.status,
    error: row.error,
    metadata: row.metadata,
  };
}

type FilingLatestRow = {
  id: string;
  source: string;
  form: string | null;
  title: string;
  filedAt: Date | null;
  periodEnd: string | null;
  url: string;
  status: string;
};

function toLatestFilingView(row: FilingLatestRow): LatestFilingView {
  return {
    id: row.id,
    source: row.source,
    title: row.title,
    url: row.url,
    status: row.status,
    ...(row.form ? { form: row.form } : {}),
    ...(row.filedAt ? { filedAt: row.filedAt.toISOString() } : {}),
    ...(row.periodEnd ? { periodEnd: row.periodEnd } : {}),
  };
}

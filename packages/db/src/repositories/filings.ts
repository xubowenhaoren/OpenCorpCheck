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
import { companyFilingState, filings } from "../schema.js";

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
  const [stateRows, latestPeriodic, latestAny, pendingRows] = await Promise.all([
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
  };
}

type FilingSelectRow = typeof filings.$inferSelect;

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

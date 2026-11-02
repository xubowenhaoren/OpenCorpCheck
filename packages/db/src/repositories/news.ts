/**
 * Automatic news refresh state (`global_news_last_update`).
 *
 * The table is the per-company cursor + lease (decision 44). It is state, not
 * a registry: the sweep selects from `companies` LEFT JOIN this table, so a
 * company with no row is simply due, and rows are created on the first claim.
 */
import { sql } from "drizzle-orm";

import type { Db } from "../client.js";

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows ?? [];
}

export type NewsRefreshStatus =
  | "never"
  | "ok"
  | "empty"
  | "failed"
  | "paused";

export interface NewsRefreshStateRow {
  key: string;
  companyId: string;
  ticker: string | null;
  name: string | null;
  lastUpdateAt: Date | null;
  newestPublishedAt: Date | null;
  lastRunId: string | null;
  lastStatus: NewsRefreshStatus;
  lastInserted: number;
  lastSkipped: number;
  consecutiveFailures: number;
  lastEnqueuedAt: Date | null;
  nextDueAt: Date | null;
  updatedAt: Date;
}

export interface DueNewsCompany {
  companyId: string;
  slug: string;
  key: string;
  ticker: string;
  name: string;
  market: "A" | "HK" | "US";
  lastUpdateAt: Date | null;
  newestPublishedAt: Date | null;
  nextDueAt: Date | null;
}

interface DueNewsRow {
  company_id: string;
  slug: string;
  display_name: string;
  coverage_tier: string;
  ticker: string | null;
  exchange: string | null;
  last_update_at: Date | null;
  newest_published_at: Date | null;
  next_due_at: Date | null;
}

const MARKET_BY_EXCHANGE: Record<string, "A" | "HK" | "US"> = {
  SSE: "A",
  SZSE: "A",
  BSE: "A",
  HKEX: "HK",
  NASDAQ: "US",
  NYSE: "US",
  AMEX: "US",
  CBOE: "US",
};

/** The primary listing: A > HK > US, preferring the ticker in `company_ids`. */
export function newsCompanyKey(row: {
  companyId: string;
  slug: string;
  ticker: string | null;
  exchange: string | null;
}): { key: string; ticker: string; market: "A" | "HK" | "US" } {
  const market =
    (row.exchange && MARKET_BY_EXCHANGE[row.exchange.toUpperCase()]) || "US";
  if (!row.ticker) {
    // AI watchlist / private companies: the worker key is NAME:<slug>.
    return { key: `NAME:${row.slug}`, ticker: row.slug, market };
  }
  return { key: `${market}:${row.ticker}`, ticker: row.ticker, market };
}

/**
 * Companies whose `next_due_at` has passed (or that have no row yet).
 * Fixtures and placeholders never participate. Ordered oldest-due first.
 */
export async function listDueNewsCompanies(
  db: Db,
  options: { now?: Date; limit?: number } = {},
): Promise<DueNewsCompany[]> {
  const now = options.now ?? new Date();
  const limit = Math.max(1, options.limit ?? 250);
  const rows = rowsOf<DueNewsRow>(
    await db.execute(sql`
      SELECT c.id AS company_id,
             c.slug,
             c.display_name,
             c.coverage_tier,
             ps.ticker,
             ps.exchange,
             n.last_update_at,
             n.newest_published_at,
             n.next_due_at
      FROM companies c
      LEFT JOIN LATERAL (
        SELECT s.ticker, s.exchange
        FROM securities s
        WHERE s.company_id = c.id
        ORDER BY
          (EXISTS (
            SELECT 1
            FROM company_ids ci
            WHERE ci.company_id = c.id
              AND ci.id_type = 'ticker'
              AND upper(replace(replace(ci.id_value, '.HK', ''), '.SZ', '')) =
                  upper(s.ticker)
          )) DESC,
          CASE upper(s.exchange)
            WHEN 'SZSE' THEN 0
            WHEN 'SSE' THEN 0
            WHEN 'BSE' THEN 0
            WHEN 'HKEX' THEN 1
            ELSE 2
          END,
          s.id
        LIMIT 1
      ) ps ON true
      LEFT JOIN global_news_last_update n ON n.company_id = c.id
      WHERE c.is_fixture = false
        AND coalesce(c.coverage_tier, '') <> 'stub'
        AND coalesce(n.next_due_at, '-infinity'::timestamptz) <= ${now}
      ORDER BY coalesce(n.next_due_at, c.created_at) ASC, c.id
      LIMIT ${limit}
    `),
  );
  return rows.map((row) => {
    const primary = newsCompanyKey({
      companyId: row.company_id,
      slug: row.slug,
      ticker: row.ticker,
      exchange: row.exchange,
    });
    return {
      companyId: row.company_id,
      slug: row.slug,
      key: primary.key,
      ticker: primary.ticker,
      name: row.display_name,
      market: primary.market,
      lastUpdateAt: row.last_update_at,
      newestPublishedAt: row.newest_published_at,
      nextDueAt: row.next_due_at,
    };
  });
}

/**
 * Resolve the same primary listing/key the sweep would use for a company.
 * Kept in SQL so the status endpoint and the producer cannot disagree.
 */
export async function getNewsCompanyKey(
  db: Db,
  companyId: string,
): Promise<{ key: string; ticker: string; market: "A" | "HK" | "US" } | null> {
  const rows = rowsOf<{
    slug: string;
    ticker: string | null;
    exchange: string | null;
  }>(
    await db.execute(sql`
      SELECT c.slug, ps.ticker, ps.exchange
      FROM companies c
      LEFT JOIN LATERAL (
        SELECT s.ticker, s.exchange
        FROM securities s
        WHERE s.company_id = c.id
        ORDER BY
          (EXISTS (
            SELECT 1
            FROM company_ids ci
            WHERE ci.company_id = c.id
              AND ci.id_type = 'ticker'
              AND upper(replace(replace(ci.id_value, '.HK', ''), '.SZ', '')) =
                  upper(s.ticker)
          )) DESC,
          CASE upper(s.exchange)
            WHEN 'SZSE' THEN 0
            WHEN 'SSE' THEN 0
            WHEN 'BSE' THEN 0
            WHEN 'HKEX' THEN 1
            ELSE 2
          END,
          s.id
        LIMIT 1
      ) ps ON true
      WHERE c.id = ${companyId}
      LIMIT 1
    `),
  );
  const row = rows[0];
  if (!row) return null;
  return newsCompanyKey({
    companyId,
    slug: row.slug,
    ticker: row.ticker,
    exchange: row.exchange,
  });
}

/** Due backlog plus the next scheduled time, for the status endpoint/CLI. */
export async function getNewsDueSummary(
  db: Db,
  now = new Date(),
): Promise<{ dueCount: number; nextDueAt: Date | null; total: number }> {
  const rows = rowsOf<{
    due_count: number;
    next_due_at: Date | null;
    total: number;
  }>(
    await db.execute(sql`
      SELECT count(*) FILTER (
               WHERE coalesce(n.next_due_at, '-infinity'::timestamptz) <= ${now}
             )::int AS due_count,
             min(coalesce(n.next_due_at, c.created_at)) AS next_due_at,
             count(*)::int AS total
      FROM companies c
      LEFT JOIN global_news_last_update n ON n.company_id = c.id
      WHERE c.is_fixture = false
        AND coalesce(c.coverage_tier, '') <> 'stub'
    `),
  );
  const row = rows[0];
  return {
    dueCount: Number(row?.due_count ?? 0),
    nextDueAt: row?.next_due_at ?? null,
    total: Number(row?.total ?? 0),
  };
}

/**
 * Claim a company before enqueuing its job. Returns false when another producer
 * already holds a live lease, which makes overlapping sweeps harmless.
 */
export async function leaseNewsCompany(
  db: Db,
  input: {
    companyId: string;
    key: string;
    ticker: string;
    name: string;
    claimTimeoutMs: number;
  },
): Promise<boolean> {
  const rows = rowsOf<{ key: string }>(
    await db.execute(sql`
      INSERT INTO global_news_last_update (
        key, company_id, ticker, name, last_status, last_enqueued_at,
        next_due_at, updated_at
      ) VALUES (
        ${input.key}, ${input.companyId}, ${input.ticker}, ${input.name},
        'never', now(),
        now() + (${input.claimTimeoutMs}::int * interval '1 millisecond'),
        now()
      )
      ON CONFLICT (company_id) DO UPDATE SET
        key = EXCLUDED.key,
        ticker = EXCLUDED.ticker,
        name = EXCLUDED.name,
        last_enqueued_at = now(),
        next_due_at = now() + (${input.claimTimeoutMs}::int * interval '1 millisecond'),
        updated_at = now()
      WHERE global_news_last_update.next_due_at IS NULL
         OR global_news_last_update.next_due_at <= now()
      RETURNING key
    `),
  );
  return rows.length > 0;
}

/** Successful check (including a valid empty feed): advance the cursor. */
export async function markNewsSuccess(
  db: Db,
  input: {
    companyId: string;
    key: string;
    ticker: string;
    name: string;
    runId: string;
    status: "ok" | "empty";
    inserted: number;
    skipped: number;
    newestPublishedAt?: Date | null;
    ttlMs: number;
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO global_news_last_update (
      key, company_id, ticker, name, last_update_at, newest_published_at,
      last_run_id, last_status, last_inserted, last_skipped,
      consecutive_failures, last_enqueued_at, next_due_at, updated_at
    ) VALUES (
      ${input.key}, ${input.companyId}, ${input.ticker}, ${input.name},
      now(), ${input.newestPublishedAt ?? null}::timestamptz,
      ${input.runId}, ${input.status}, ${input.inserted}, ${input.skipped},
      0, now(),
      now() + (${input.ttlMs}::int * interval '1 millisecond'), now()
    )
    ON CONFLICT (company_id) DO UPDATE SET
      key = EXCLUDED.key,
      ticker = EXCLUDED.ticker,
      name = EXCLUDED.name,
      last_update_at = now(),
      newest_published_at = GREATEST(
        global_news_last_update.newest_published_at,
        ${input.newestPublishedAt ?? null}::timestamptz
      ),
      last_run_id = EXCLUDED.last_run_id,
      last_status = EXCLUDED.last_status,
      last_inserted = EXCLUDED.last_inserted,
      last_skipped = EXCLUDED.last_skipped,
      consecutive_failures = 0,
      next_due_at = now() + (${input.ttlMs}::int * interval '1 millisecond'),
      updated_at = now()
  `);
}

/**
 * Failed check: never advance `last_update_at`; back off and pause after
 * `pauseAfterFailures` so a broken feed cannot be hammered.
 */
export async function markNewsFailure(
  db: Db,
  input: {
    companyId: string;
    key: string;
    ticker: string;
    name: string;
    runId: string;
    ttlMs: number;
    pauseAfterFailures?: number;
  },
): Promise<void> {
  const pauseAfter = input.pauseAfterFailures ?? 5;
  await db.execute(sql`
    INSERT INTO global_news_last_update (
      key, company_id, ticker, name, last_run_id, last_status,
      consecutive_failures, last_enqueued_at, next_due_at, updated_at
    ) VALUES (
      ${input.key}, ${input.companyId}, ${input.ticker}, ${input.name},
      ${input.runId}, 'failed', 1, now(),
      now() + LEAST(
        interval '15 minutes',
        (${input.ttlMs}::int * interval '1 millisecond')
      ),
      now()
    )
    ON CONFLICT (company_id) DO UPDATE SET
      key = EXCLUDED.key,
      ticker = EXCLUDED.ticker,
      name = EXCLUDED.name,
      last_run_id = EXCLUDED.last_run_id,
      last_status = CASE
        WHEN global_news_last_update.consecutive_failures + 1 >= ${pauseAfter}
          THEN 'paused'
        ELSE 'failed'
      END,
      consecutive_failures = global_news_last_update.consecutive_failures + 1,
      next_due_at = CASE
        WHEN global_news_last_update.consecutive_failures + 1 >= ${pauseAfter}
          THEN now() + (${input.ttlMs}::int * interval '1 millisecond')
        ELSE now() + LEAST(
          make_interval(
            secs => 900 * power(2, global_news_last_update.consecutive_failures)
          ),
          (${input.ttlMs}::int * interval '1 millisecond')
        )
      END,
      updated_at = now()
  `);
}

export async function getNewsRefreshState(
  db: Db,
  companyId: string,
): Promise<NewsRefreshStateRow | null> {
  const rows = rowsOf<{
    key: string;
    company_id: string;
    ticker: string | null;
    name: string | null;
    last_update_at: Date | null;
    newest_published_at: Date | null;
    last_run_id: string | null;
    last_status: NewsRefreshStatus;
    last_inserted: number;
    last_skipped: number;
    consecutive_failures: number;
    last_enqueued_at: Date | null;
    next_due_at: Date | null;
    updated_at: Date;
  }>(
    await db.execute(sql`
      SELECT key, company_id, ticker, name, last_update_at,
             newest_published_at, last_run_id, last_status, last_inserted,
             last_skipped, consecutive_failures, last_enqueued_at,
             next_due_at, updated_at
      FROM global_news_last_update
      WHERE company_id = ${companyId}
      LIMIT 1
    `),
  );
  const row = rows[0];
  if (!row) return null;
  return {
    key: row.key,
    companyId: row.company_id,
    ticker: row.ticker,
    name: row.name,
    lastUpdateAt: row.last_update_at,
    newestPublishedAt: row.newest_published_at,
    lastRunId: row.last_run_id,
    lastStatus: row.last_status,
    lastInserted: Number(row.last_inserted),
    lastSkipped: Number(row.last_skipped),
    consecutiveFailures: Number(row.consecutive_failures),
    lastEnqueuedAt: row.last_enqueued_at,
    nextDueAt: row.next_due_at,
    updatedAt: row.updated_at,
  };
}

/** Per-status counts for the operator CLI. */
export async function getNewsStateTotals(
  db: Db,
): Promise<{ total: number; byStatus: Record<string, number> }> {
  const rows = rowsOf<{ last_status: string; count: number }>(
    await db.execute(sql`
      SELECT last_status, count(*)::int AS count
      FROM global_news_last_update
      GROUP BY last_status
    `),
  );
  const byStatus: Record<string, number> = {};
  for (const row of rows) byStatus[row.last_status] = Number(row.count);
  return {
    total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
    byStatus,
  };
}

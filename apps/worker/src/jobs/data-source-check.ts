import { createHash } from "node:crypto";

import type { Job } from "pg-boss";

import {
  filingRowId,
  getFilingState,
  insertDetectedFilings,
  leaseFinancialsRefresh,
  listDetectedFilings,
  markFilingSourceFailure,
  markFilingSourceSuccess,
  upsertExpectedFinancialsPeriod,
  type FilingStateSnapshot,
  type NewFilingRow,
} from "@occ/db";
import { FinanceAnalystClient } from "@occ/sources-eastmoney-f10";
import {
  expectedPeriodEnd,
  fetchCninfoFilings,
  fetchEdgarFilings,
  fetchHkexNewsFilings,
  filingPeriodicKind,
  type FilingItem,
} from "@occ/sources-filings";

import { config } from "../config.js";
import { getJobRow, markJobActive, markJobCompleted, markJobFailed } from "../db.js";
import { dataCheckWindow } from "../data/plan.js";
import type {
  DataSourceCheckJobData,
  FilingIngestJobData,
} from "../data/types.js";
import type { FinancialsJobData } from "./financials.js";
import { getIngestContext } from "../ingest-runtime.js";
import { QUEUES } from "../queues.js";

/**
 * `data.source.check` (P1.5).
 *
 * One deterministic index check for one (company, source):
 * discover → diff by `(source, accession)` → insert detected rows → enqueue
 * `ingest.filing` for announcements and `financials.company` for a new
 * periodic report. The first successful check is a baseline: it records what
 * already exists without ingesting a historical backlog or re-running
 * financials for the whole universe.
 */
export interface DataSourceCheckDeps {
  enqueueFinancials: (data: FinancialsJobData) => Promise<void>;
  enqueueFilingIngest: (data: FilingIngestJobData) => Promise<void>;
}

export async function handleDataSourceCheckJobs(
  jobs: Job<DataSourceCheckJobData>[],
  deps: DataSourceCheckDeps,
): Promise<void> {
  for (const job of jobs) {
    await processDataSourceCheck(job, deps);
  }
}

async function processDataSourceCheck(
  job: Job<DataSourceCheckJobData>,
  deps: DataSourceCheckDeps,
): Promise<void> {
  const data = job.data;
  const queue = QUEUES.DATA_SOURCE_CHECK;
  const row = await getJobRow(data.runId, queue, data.key);
  if (!row) {
    log({ event: "data_check_missing", run: data.runId, key: data.key });
    return;
  }
  if (row.status === "completed" && !data.force) {
    log({ event: "data_check_skip_completed", run: data.runId, key: data.key });
    return;
  }

  await markJobActive(data.runId, queue, data.key);
  const startedAt = Date.now();
  const ctx = await getIngestContext();
  try {
    const state = await getFilingState(ctx.db, data.companyId, data.source);
    const now = new Date();

    if (data.source === "f10") {
      const outcome = await checkF10Fallback({ data, state });
      if (outcome.changed) {
        await deps.enqueueFinancials({
          runId: data.runId,
          key: `${data.market}:${data.ticker}`,
          companyId: data.companyId,
          ticker: data.ticker,
          code: data.code,
          market: data.market,
          ...(data.name ? { name: data.name } : {}),
          force: false,
          bypassCache: true,
          reopenCompleted: false,
        });
      }
      await markFilingSourceSuccess(ctx.db, {
        companyId: data.companyId,
        source: data.source,
        market: data.market,
        code: data.code,
        runId: data.runId,
        status: outcome.changed ? "changed" : "ok",
        cursor: outcome.cursor,
        changed: outcome.changed,
        ttlMs: data.ttlMs,
      });
      await markJobCompleted(data.runId, queue, data.key, {
        source: data.source,
        changed: outcome.changed,
        discovered: 0,
        inserted: 0,
        periodic: 0,
        enqueuedFilings: 0,
        enqueuedFinancials: outcome.changed ? 1 : 0,
      });
      log({
        event: "data_check_completed",
        run: data.runId,
        key: data.key,
        source: data.source,
        changed: outcome.changed,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    const lastCheckedAt =
      state?.lastCheckedAt ??
      (data.lastCheckedAt ? new Date(data.lastCheckedAt) : null);
    const cold = !lastCheckedAt;
    const window = dataCheckWindow(lastCheckedAt, now, {
      coldDays: data.coldDays,
      maxDays: data.maxDays,
    });
    const items = await discover({
      data,
      since: window.since,
      sinceDays: window.sinceDays,
      now,
    });
    // Cold start establishes a baseline without ingesting a historical
    // backlog. The exception is a recent periodic report: it is actionable
    // (document + financials) because the structured statements may not cover
    // it yet. Non-periodic backlog rows are recorded as `applied`.
    const coldCutoff = new Date(now.getTime() - data.coldDays * 86_400_000);
    const rows = items.map((item) => {
      const periodKind = filingPeriodicKind(item);
      const filedAt = item.publishedAt ? new Date(item.publishedAt) : null;
      const recent =
        filedAt !== null &&
        !Number.isNaN(filedAt.getTime()) &&
        filedAt.getTime() >= coldCutoff.getTime();
      const actionable = !cold || (periodKind !== null && recent);
      return toNewFilingRow(
        data.companyId,
        item,
        actionable ? "detected" : "applied",
        cold,
      );
    });
    const inserted = await insertDetectedFilings(ctx.db, rows);
    // Re-read every `detected` row, not just the rows inserted by this
    // attempt: a check that inserted and then failed before enqueuing its
    // follow-ups must recover them on retry (the accession is no longer
    // "new", so they would otherwise stay detected forever).
    const actionable = await listDetectedFilings(
      ctx.db,
      data.companyId,
      data.source,
    );
    const periodic = actionable.filter((filing) => filing.periodic);
    let enqueuedFilings = 0;
    let enqueuedFinancials = 0;
    let financialsTracked = 0;

    // P1.5 follow-up: remember the period this report should add, so a
    // financials run that finishes while F10 lags stays pending and is retried
    // by the daily sweep. The accession is already consumed at this point.
    for (const filing of periodic) {
      if (!filing.periodEnd) continue;
      await upsertExpectedFinancialsPeriod(ctx.db, {
        companyId: data.companyId,
        expectedPeriodEnd: filing.periodEnd,
        market: data.market,
        ticker: data.ticker,
        code: data.code,
        name: data.name ?? null,
        source: data.source,
        filingId: filing.id,
      });
      financialsTracked += 1;
    }

    if (actionable.length > 0) {
      await deps.enqueueFilingIngest({
        runId: data.runId,
        key: `${data.companyId}:${data.source}:filing`,
        companyId: data.companyId,
        source: data.source,
        market: data.market,
        filingIds: actionable.map((filing) => filing.id),
      });
      enqueuedFilings = actionable.length;
    }
    if (periodic.length > 0) {
      // One financials job per company per run. A catch-up may already have
      // leased the state in this sweep; without this guard the check would
      // enqueue a second pg-boss job for the same period (both can be active
      // before either marks the run row completed). No tracked period (rare)
      // falls back to the pre-follow-up behaviour.
      const leased =
        financialsTracked === 0 ||
        (await leaseFinancialsRefresh(ctx.db, {
          companyId: data.companyId,
          claimTimeoutMs: data.claimTimeoutMs,
        })) !== null;
      if (leased) {
        await deps.enqueueFinancials({
          runId: data.runId,
          key: `${data.market}:${data.ticker}`,
          companyId: data.companyId,
          ticker: data.ticker,
          code: data.code,
          market: data.market,
          ...(data.name ? { name: data.name } : {}),
          force: false,
          bypassCache: true,
          reopenCompleted: false,
        });
        enqueuedFinancials = 1;
      }
    }

    const status: "ok" | "changed" | "empty" =
      inserted.length > 0 ? "changed" : items.length > 0 ? "ok" : "empty";
    await markFilingSourceSuccess(ctx.db, {
      companyId: data.companyId,
      source: data.source,
      market: data.market,
      code: data.code,
      runId: data.runId,
      status,
      cursor: newestExternalId(items),
      changed: inserted.length > 0,
      ttlMs: data.ttlMs,
    });
    await markJobCompleted(data.runId, queue, data.key, {
      source: data.source,
      cold,
      discovered: items.length,
      inserted: inserted.length,
      periodic: periodic.length,
      enqueuedFilings,
      enqueuedFinancials,
      financialsTracked,
      sinceDays: window.sinceDays,
    });
    log({
      event: "data_check_completed",
      run: data.runId,
      key: data.key,
      source: data.source,
      cold,
      discovered: items.length,
      inserted: inserted.length,
      actionable: actionable.length,
      periodic: periodic.length,
      enqueuedFilings,
      enqueuedFinancials,
      financialsTracked,
      sinceDays: window.sinceDays,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await markFilingSourceFailure(ctx.db, {
        companyId: data.companyId,
        source: data.source,
        market: data.market,
        code: data.code,
        runId: data.runId,
        error: message,
        ttlMs: data.ttlMs,
        pauseAfterFailures: config.dataPauseAfterFailures,
      });
    } catch {
      // Stamping the cursor is best-effort; the job error is what matters.
    }
    await markJobFailed(data.runId, queue, data.key, message);
    log({
      event: "data_check_failed",
      run: data.runId,
      key: data.key,
      source: data.source,
      durationMs: Date.now() - startedAt,
      error: message,
      retryCount: job.retryCount,
    });
    throw error;
  }
}

async function discover(input: {
  data: DataSourceCheckJobData;
  since: Date;
  sinceDays: number;
  now: Date;
}): Promise<FilingItem[]> {
  const { data } = input;
  switch (data.source) {
    case "edgar": {
      if (!data.cik) throw new Error("EDGAR check requires a CIK identifier");
      const result = await fetchEdgarFilings(data.cik, {
        edgarDir: config.edgarDir,
        since: input.since,
        limit: data.maxItems,
        force: true,
        userAgent: config.edgarUserAgent,
      });
      return result.items;
    }
    case "cninfo": {
      const result = await fetchCninfoFilings({
        code: data.code,
        from: input.since,
        to: input.now,
        maxItems: data.maxItems,
        userAgent: config.edgarUserAgent,
      });
      return result.items;
    }
    case "hkexnews": {
      const result = await fetchHkexNewsFilings({
        code: data.code,
        days: input.sinceDays,
        maxItems: data.maxItems,
        sidecarUrl: config.financeAnalystUrl,
        timeoutMs: config.hkexNewsTimeoutMs,
      });
      if (result.items.length === 0 && result.errors.length > 0) {
        throw new Error(result.errors.join("; "));
      }
      return result.items;
    }
    default:
      throw new Error(`unknown data source: ${String(data.source)}`);
  }
}

/**
 * F10 `cwfx` content-hash fallback for an A/HK company with no usable
 * official feed. It never re-fetches on a cold start; a changed hash enqueues
 * one forced financials run.
 */
async function checkF10Fallback(input: {
  data: DataSourceCheckJobData;
  state: FilingStateSnapshot | null;
}): Promise<{ changed: boolean; cursor: string | null }> {
  const { data, state } = input;
  if (data.market === "US") {
    throw new Error("F10 fallback is only available for A/HK companies");
  }
  const page = data.market === "HK" ? "NewFinancialAnalysis" : "cwfx";
  const client = new FinanceAnalystClient({
    baseUrl: config.financeAnalystUrl,
  });
  const response = await client.scrape(
    {
      market: data.market,
      code: data.code,
      pages: [page],
      capture_xhr: false,
    },
    { timeoutMs: 180_000 },
  );
  const result = response.pages[0];
  if (!result || result.error) {
    throw new Error(result?.error ?? "F10 sidecar returned no page");
  }
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        text: result.text ?? "",
        tables: result.tables ?? [],
      }),
    )
    .digest("hex");
  const previous = state?.cursor ?? null;
  return {
    changed: Boolean(previous) && previous !== hash,
    cursor: hash,
  };
}

function toNewFilingRow(
  companyId: string,
  item: FilingItem,
  status: "applied" | "detected",
  baseline: boolean,
): NewFilingRow {
  const periodKind = filingPeriodicKind(item);
  const filedAt = item.publishedAt ? new Date(item.publishedAt) : null;
  // EDGAR carries `reportDate`; CNINFO/HKEXnews publish only a title. Derive
  // the period deterministically so financials can be verified later.
  const periodEnd = item.periodEnd ?? expectedPeriodEnd(item);
  return {
    id: filingRowId(item.source, item.externalId),
    companyId,
    source: item.source,
    accession: item.externalId,
    title: item.title,
    form: item.form ?? null,
    category: item.category ?? null,
    filedAt:
      filedAt && !Number.isNaN(filedAt.getTime()) ? filedAt : null,
    periodEnd: periodEnd ? periodEnd.slice(0, 10) : null,
    periodic: periodKind !== null,
    periodKind,
    url: item.url,
    pdfUrl: item.pdfUrl ?? null,
    status,
    metadata: {
      ...(item.metadata ?? {}),
      language: item.language ?? null,
      trustTier: item.trustTier ?? "official",
      periodKind,
      ...(baseline ? { baseline: true } : {}),
    },
  };
}

/** Newest item's external id; the adapter returns most-recent first. */
function newestExternalId(items: FilingItem[]): string | null {
  if (items.length === 0) return null;
  let newest = items[0]!;
  for (const item of items) {
    const current = item.publishedAt ?? "";
    if (current > (newest.publishedAt ?? "")) newest = item;
  }
  return newest.externalId;
}

function log(payload: Record<string, unknown>): void {
  console.error(JSON.stringify(payload));
}

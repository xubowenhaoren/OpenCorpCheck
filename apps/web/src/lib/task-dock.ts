import type { ResearchJobView } from "@occ/core";

import type { DataRunView } from "../api";
import type { Lang } from "../i18n";

/**
 * Pure helpers for the shared TaskDock's `财报更新` group (P1.5 follow-up).
 *
 * The data run is `backfill_runs(kind='data')`: `data.source.check` jobs are
 * the per-company rows, and their follow-ups (`ingest.filing`,
 * `financials.company`) are appended by the worker as they are queued. The
 * dock must describe what actually happened and never fake success.
 */

export type DockState = "queued" | "running" | "completed" | "partial" | "failed";

export function dataRunState(
  run: Pick<DataRunView, "status">,
): DockState {
  if (run.status === "queued") return "queued";
  if (run.status === "running") return "running";
  if (run.status === "partial") return "partial";
  if (run.status === "failed") return "failed";
  return "completed";
}

export function dataRunPercent(run: Pick<DataRunView, "done" | "total">): number {
  if (!run.total) return 0;
  return Math.max(0, Math.min(100, Math.round((run.done / run.total) * 100)));
}

/** One-line status for the collapsed data run. */
export function describeDataRun(
  run: DataRunView,
  _lang: Lang,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const state = dataRunState(run);
  if (state === "queued") return t("dock.dataQueued");
  if (state === "running") {
    return t("dock.dataRunning", {
      done: run.done,
      total: run.total,
      pct: dataRunPercent(run),
    });
  }
  if (state === "partial") {
    return t("dock.dataPartial", { failed: run.failed });
  }
  if (state === "failed") return t("dock.dataFailed");
  if (run.inserted > 0) {
    return t("dock.dataCompleted", { count: run.inserted });
  }
  if (run.financials > 0) {
    return t("dock.dataChecked");
  }
  return t("dock.dataNoChange");
}

export interface DataSubtaskGroup {
  companyId: string;
  ticker: string | null;
  name: string;
  /** One check per (company, source); dual-listed A/HK companies have two. */
  checks: ResearchJobView[];
  financials: ResearchJobView | null;
  filings: ResearchJobView[];
}

/** Fold one data run's jobs into one row per company. */
export function groupDataJobs(jobs: ResearchJobView[]): DataSubtaskGroup[] {
  const groups = new Map<string, DataSubtaskGroup>();
  const groupFor = (job: ResearchJobView): DataSubtaskGroup => {
    const existing = groups.get(job.companyId);
    if (existing) return existing;
    const payload = job.payload ?? {};
    const ticker =
      typeof payload.ticker === "string" ? payload.ticker : job.companyId;
    const name =
      typeof payload.name === "string" && payload.name.trim()
        ? payload.name
        : ticker;
    const group: DataSubtaskGroup = {
      companyId: job.companyId,
      ticker,
      name,
      checks: [],
      financials: null,
      filings: [],
    };
    groups.set(job.companyId, group);
    return group;
  };

  for (const job of jobs) {
    if (
      job.queue !== "data.source.check" &&
      job.queue !== "financials.company" &&
      job.queue !== "ingest.filing"
    ) {
      continue;
    }
    const group = groupFor(job);
    if (job.queue === "data.source.check") {
      group.checks.push(job);
    } else if (job.queue === "financials.company") {
      group.financials = job;
    } else {
      group.filings.push(job);
    }
  }
  return [...groups.values()];
}

function isActive(job: ResearchJobView | null): boolean {
  return job?.status === "active";
}

function isQueued(job: ResearchJobView | null): boolean {
  return job?.status === "queued";
}

function isFailed(job: ResearchJobView | null): boolean {
  return job?.status === "failed" || job?.status === "dead";
}

function isDone(job: ResearchJobView | null): boolean {
  return job?.status === "completed";
}

export interface DataSubtaskDescription {
  state: DataSubtaskState;
  text: string;
}

export type DataSubtaskState = "queued" | "running" | "completed" | "failed";

/**
 * Per-company detail. Follow-up jobs win while they run so a detected 10-K
 * reads `财报更新中` and a new announcement reads `公告入库中`; a failed
 * source check reads `重试中` because the daily sweep retries it.
 */
export function describeDataSubtask(
  group: DataSubtaskGroup,
  t: (key: string, vars?: Record<string, string | number>) => string,
): DataSubtaskDescription {
  const { checks, financials, filings } = group;
  const ingesting = filings.find((job) => isActive(job)) ?? null;
  const ingestQueued = filings.find((job) => isQueued(job)) ?? null;
  const checksFailed = checks.some((job) => isFailed(job));
  const checksActive = checks.some((job) => isActive(job));
  const checksQueued = checks.some((job) => isQueued(job));
  const checksDone = checks.length > 0 && checks.every((job) => isDone(job));
  const sumMeta = (key: string): number =>
    checks.reduce((sum, job) => sum + Number(job.meta?.[key] ?? 0), 0);

  if (isActive(financials)) {
    return { state: "running", text: t("dock.financialsUpdating") };
  }
  if (ingesting) {
    return { state: "running", text: t("dock.filingsIngesting") };
  }
  if (checksActive) {
    return { state: "running", text: t("dock.checking") };
  }
  if (isQueued(financials)) {
    return { state: "queued", text: t("dock.financialsQueued") };
  }
  if (ingestQueued) {
    return { state: "queued", text: t("dock.filingsQueued") };
  }
  if (checksQueued) {
    return { state: "queued", text: t("dock.queuedDetail") };
  }

  if (checksFailed) {
    // The daily sweep re-runs a failed source check after its backoff.
    return { state: "failed", text: t("dock.retrying") };
  }
  if (filings.some((job) => isFailed(job))) {
    return { state: "failed", text: t("dock.failedDetail") };
  }
  if (isFailed(financials)) {
    return { state: "failed", text: t("dock.financialsFailed") };
  }

  if (financials && isDone(financials)) {
    const verified = String(financials.meta?.financialsStatus ?? "");
    if (verified === "pending") {
      return { state: "queued", text: t("dock.financialsWaiting") };
    }
    if (verified === "failed") {
      return { state: "failed", text: t("dock.financialsFailed") };
    }
    return { state: "completed", text: t("dock.financialsDone") };
  }
  if (checksDone) {
    const periodic = sumMeta("periodic");
    const inserted = sumMeta("inserted");
    const enqueuedFinancials = sumMeta("enqueuedFinancials");
    if (periodic > 0 || enqueuedFinancials > 0) {
      // The check finished but the financials follow-up is not listed yet.
      return { state: "running", text: t("dock.financialsUpdating") };
    }
    if (inserted > 0) {
      return { state: "completed", text: t("dock.found", { count: inserted }) };
    }
    return { state: "completed", text: t("dock.noChange") };
  }
  if (filings.length > 0 && filings.every(isDone)) {
    const inserted = filings.reduce(
      (sum, job) => sum + Number(job.meta?.inserted ?? 0),
      0,
    );
    return {
      state: "completed",
      text:
        inserted > 0
          ? t("dock.found", { count: inserted })
          : t("dock.noChange"),
    };
  }
  return { state: "completed", text: t("dock.noChange") };
}

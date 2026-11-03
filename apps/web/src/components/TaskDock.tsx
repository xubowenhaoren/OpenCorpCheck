import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import {
  getNewsStatus,
  getRun,
  type DataRunView,
  type NewsSweepView,
} from "../api";
import { useLang } from "../i18n";
import {
  describeJob,
  describeSweep,
  formatElapsed,
  relativeFuture,
  relativePast,
  sweepPercent,
  sweepState,
} from "../lib/news-dock";
import {
  dataRunPercent,
  dataRunState,
  describeDataRun,
  describeDataSubtask,
  groupDataJobs,
} from "../lib/task-dock";

const ICON_NEWS = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M4 3.5h9.5A1.5 1.5 0 0 1 15 5v10.5H5.5A1.5 1.5 0 0 1 4 14V3.5Z" />
    <path d="M15 6h1.5A1.5 1.5 0 0 1 18 7.5v6A1.5 1.5 0 0 1 16.5 15H15" />
    <path d="M6.5 6.5H12M6.5 9H12M6.5 11.5h3.5" />
  </svg>
);

const ICON_FILINGS = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M5 2.8h7l3 3v11.4H5z" />
    <path d="M12 2.8v3h3" />
    <path d="M7.5 9h5M7.5 11.5h5M7.5 14h3" />
  </svg>
);

const ICON_DOWNLOAD = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M10 2.8v9.4" />
    <path d="m6.2 8.6 3.8 3.8 3.8-3.8" />
    <path d="M3.2 14.2v1.4c0 .7.6 1.3 1.3 1.3h11c.7 0 1.3-.6 1.3-1.3v-1.4" />
  </svg>
);

const ICON_CHEVRON = (
  <svg
    className="dock-chev"
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m5.5 7.5 4.5 4.5 4.5-4.5" />
  </svg>
);

type DockFilter = "all" | "news" | "data";

type DockEntry =
  | { kind: "news"; run: NewsSweepView }
  | { kind: "data"; run: DataRunView };

/**
 * Global task dock for the two automatic producers (2026-11-03 decision 33):
 *
 * - `更新新闻`: the automatic Google News RSS sweep;
 * - `财报更新`: the daily `data.sweep` → `data.source.check` →
 *   `ingest.filing` / `financials.company` pipeline (P1.5).
 *
 * There are no manual controls, and the manual refresh-news button stays
 * cancelled (decision 34). Polling `/v1/news/status` both observes the sweeps
 * and lets the API lazily start a due news sweep; the data sweep is owned by
 * the data worker's cron. Never fake success: a failed source check reads
 * `重试中`, a pending financials period reads `财报更新中`.
 */
export function TaskDock() {
  const { t, lang } = useLang();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<DockFilter>("all");
  const [expanded, setExpanded] = useState<string[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);

  const statusQuery = useQuery({
    queryKey: ["news-status"],
    queryFn: () => getNewsStatus(),
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      const data = query.state.data?.data;
      const active =
        data?.active ||
        data?.dataRefresh?.active ||
        data?.triggered ||
        data?.pendingSweep ||
        data?.dataRefresh?.pendingSweep;
      return active ? 5_000 : 60_000;
    },
  });
  const status = statusQuery.data?.data;
  const activeNews = status?.active ?? null;
  const activeData = status?.dataRefresh?.active ?? null;
  const pendingNews = status?.pendingSweep ?? false;
  const pendingData = status?.dataRefresh?.pendingSweep ?? false;
  const newsRuns = useMemo(() => status?.sweeps ?? [], [status]);
  const dataRuns = useMemo(
    () => status?.dataRefresh?.runs ?? [],
    [status],
  );

  const entries = useMemo<DockEntry[]>(() => {
    const merged: DockEntry[] = [
      ...newsRuns.map((run): DockEntry => ({ kind: "news", run })),
      ...dataRuns.map((run): DockEntry => ({ kind: "data", run })),
    ];
    return merged.sort((left, right) =>
      right.run.startedAt.localeCompare(left.run.startedAt),
    );
  }, [newsRuns, dataRuns]);

  const visible = entries.filter(
    (entry) => filter === "all" || entry.kind === filter,
  );
  const activeCount = (activeNews ? 1 : 0) + (activeData ? 1 : 0);
  const activeDone = (activeNews?.done ?? 0) + (activeData?.done ?? 0);
  const activeTotal = (activeNews?.total ?? 0) + (activeData?.total ?? 0);
  const pct = activeTotal ? Math.round((activeDone / activeTotal) * 100) : 0;

  // Expand each active producer the first time it appears.
  useEffect(() => {
    const activeIds = [activeNews?.runId, activeData?.runId].filter(
      (id): id is string => Boolean(id),
    );
    if (activeIds.length === 0) return;
    setExpanded((current) => {
      const missing = activeIds.filter((id) => !current.includes(id));
      return missing.length ? [...missing, ...current] : current;
    });
  }, [activeNews?.runId, activeData?.runId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (wrapRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const toggleExpanded = (runId: string): void => {
    setExpanded((current) =>
      current.includes(runId)
        ? current.filter((id) => id !== runId)
        : [...current, runId],
    );
  };

  const issues = entries.filter(
    (entry) => entry.run.status === "partial" || entry.run.status === "failed",
  ).length;
  const latestEntry = entries[0] ?? null;
  const nextDueAt = earliest(
    status?.nextDueAt ?? null,
    status?.dataRefresh?.nextDueAt ?? null,
    status?.dataRefresh?.nextRetryAt ?? null,
  );
  const pendingAny = pendingNews || pendingData;
  const announce =
    activeCount > 0
      ? t("dock.subActive", { count: activeCount })
      : latestEntry
        ? `${t("dock.lastSweep")}：${describeEntry(latestEntry, lang, t)}`
        : t("dock.noSweep");

  const tabCounts = {
    all: entries.length,
    news: newsRuns.length,
    data: dataRuns.length,
  };

  return (
    <div className="dock-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`dock-btn${activeCount > 0 ? " is-active" : ""}`}
        aria-expanded={open}
        aria-controls="occ-task-dock"
        aria-label={
          activeCount > 0
            ? `${t("dock.open")}，${activeDone}/${activeTotal}`
            : t("dock.open")
        }
        onClick={() => setOpen((value) => !value)}
      >
        <svg className="dock-ring" viewBox="0 0 46 46" aria-hidden="true">
          <circle className="track" cx="23" cy="23" r="20.5" />
          <circle
            className={`fill${activeCount === 0 && issues > 0 ? " warn" : ""}`}
            cx="23"
            cy="23"
            r="20.5"
            strokeDasharray="128.8"
            strokeDashoffset={128.8 * (1 - pct / 100)}
          />
        </svg>
        <span className="dock-glyph" aria-hidden="true">
          {ICON_DOWNLOAD}
        </span>
        {activeCount > 0 ? (
          <span className="dock-count">{activeCount}</span>
        ) : issues > 0 ? (
          <span className="dock-count warn">!</span>
        ) : null}
      </button>

      <section
        className="dock-card"
        id="occ-task-dock"
        role="dialog"
        aria-label={t("dock.open")}
        hidden={!open}
      >
        <div className="dock-head">
          <div className="dock-head-top">
            <div>
              <h2>{t("dock.title")}</h2>
              <div className="dock-sub">
                {activeCount > 0
                  ? t("dock.subActive", { count: activeCount })
                  : pendingAny
                    ? t("dock.queued")
                    : t("dock.subIdle")}
              </div>
            </div>
            <div className="dock-overall">
              {activeCount > 0 ? (
                <>
                  <div className="dock-pct">{pct}%</div>
                  <div className="dock-counts">
                    {activeDone}/{activeTotal}
                  </div>
                </>
              ) : (
                <div className="dock-counts">
                  {latestEntry
                    ? `${t("dock.lastSweep")} · ${relativePast(
                        latestEntry.run.finishedAt ??
                          latestEntry.run.startedAt,
                        lang,
                      )}`
                    : t("dock.noSweep")}
                </div>
              )}
            </div>
          </div>
          {activeCount > 0 ? (
            <div
              className="dock-overall-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={activeTotal || 1}
              aria-valuenow={activeDone}
            >
              <span style={{ width: `${pct}%` }} />
            </div>
          ) : null}
          {activeCount === 0 && pendingAny ? (
            <div className="dock-next">{t("dock.queuedHint")}</div>
          ) : activeCount === 0 && nextDueAt ? (
            <div className="dock-next">
              {t("dock.nextDue", {
                time: relativeFuture(nextDueAt, lang),
              })}
            </div>
          ) : null}
        </div>

        <div className="dock-tabs" role="tablist" aria-label={t("dock.title")}>
          {(["all", "news", "data"] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              className="dock-tab"
              aria-selected={filter === key}
              onClick={() => setFilter(key)}
            >
              {key === "all"
                ? t("dock.tabsAll")
                : key === "news"
                  ? t("dock.tabsNews")
                  : t("dock.tabsData")}
              <span className="dock-tab-count">{tabCounts[key]}</span>
            </button>
          ))}
        </div>

        <div className="dock-list">
          {visible.length === 0 ? (
            <div className="dock-empty">
              <div className="dock-empty-title">
                {pendingAny
                  ? t("dock.queued")
                  : filter === "data"
                    ? t("dock.noDataRun")
                    : t("dock.noSweep")}
              </div>
              <div>
                {pendingAny
                  ? t("dock.queuedHint")
                  : filter === "data"
                    ? t("dock.noDataRunHint")
                    : t("dock.noSweepHint")}
              </div>
            </div>
          ) : (
            visible.map((entry) =>
              entry.kind === "news" ? (
                <SweepRow
                  key={entry.run.runId}
                  sweep={entry.run}
                  open={expanded.includes(entry.run.runId)}
                  onToggle={() => toggleExpanded(entry.run.runId)}
                  onNavigate={() => setOpen(false)}
                />
              ) : (
                <DataRunRow
                  key={entry.run.runId}
                  run={entry.run}
                  open={expanded.includes(entry.run.runId)}
                  onToggle={() => toggleExpanded(entry.run.runId)}
                  onNavigate={() => setOpen(false)}
                />
              ),
            )
          )}
        </div>

        <div className="dock-foot">
          <span>{t("dock.history")}</span>
          <span className="dock-foot-note">{t("dock.subIdle")}</span>
        </div>
        <span className="sr-only" aria-live="polite">
          {announce}
        </span>
      </section>
    </div>
  );
}

function SweepRow({
  sweep,
  open,
  onToggle,
  onNavigate,
}: {
  sweep: NewsSweepView;
  open: boolean;
  onToggle: () => void;
  onNavigate: () => void;
}) {
  const { t, lang } = useLang();
  const state = sweepState(sweep);
  const detail = useQuery({
    queryKey: ["news-run", sweep.runId],
    queryFn: () => getRun(sweep.runId),
    enabled: open,
    staleTime: 3_000,
    refetchInterval: sweep.active ? 5_000 : false,
  });
  const jobs = detail.data?.data.jobs ?? [];
  const pct = sweepPercent(sweep);
  const elapsed =
    sweep.elapsedMs ??
    Math.max(0, Date.now() - new Date(sweep.startedAt).getTime());

  return (
    <article className="dock-task" data-state={state}>
      <button
        type="button"
        className="dock-task-head"
        aria-expanded={open}
        aria-controls={`dock-body-${sweep.runId}`}
        onClick={onToggle}
      >
        <span className="dock-task-icon news" aria-hidden="true">
          {ICON_NEWS}
        </span>
        <span className="dock-task-main">
          <span className="dock-task-title-row">
            <span className="dock-task-title">
              {t("dock.sweepTitle", { count: sweep.total })}
            </span>
            <span className="dock-badge news">{t("dock.badge")}</span>
          </span>
          <span className="dock-task-status">
            <span className={`dock-dot ${state}`} aria-hidden="true" />
            {describeSweep(sweep, lang, t)}
          </span>
          {state !== "completed" ? (
            <span
              className={`dock-task-bar ${state}`}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={sweep.total || 1}
              aria-valuenow={sweep.done}
            >
              <span style={{ width: `${pct}%` }} />
            </span>
          ) : null}
          <span className="dock-task-meta">
            <span>{relativePast(sweep.finishedAt ?? sweep.startedAt, lang)}</span>
            <span>·</span>
            <span>{formatElapsed(elapsed, lang)}</span>
          </span>
        </span>
        {ICON_CHEVRON}
      </button>
      <div id={`dock-body-${sweep.runId}`} hidden={!open}>
        {open ? (
          <div className="dock-task-body">
            {detail.isLoading ? (
              <div className="dock-subtask muted">{t("common.loading")}</div>
            ) : jobs.length === 0 ? (
              <div className="dock-subtask muted">{t("common.noData")}</div>
            ) : (
              jobs.map((job) => {
                const payload = job.payload ?? {};
                const ticker =
                  typeof payload.ticker === "string" ? payload.ticker : null;
                const name =
                  typeof payload.name === "string"
                    ? payload.name
                    : job.companyId;
                const jobState =
                  job.status === "active"
                    ? "running"
                    : job.status === "completed"
                      ? "completed"
                      : job.status === "queued"
                        ? "queued"
                        : "failed";
                return (
                  <div className="dock-subtask" key={job.jobKey}>
                    <span className={`dock-dot ${jobState}`} aria-hidden="true" />
                    <span className="dock-subtask-who">
                      <span className="dock-subtask-name">{name}</span>
                      {ticker ? (
                        <span className="dock-subtask-ticker">{ticker}</span>
                      ) : null}
                    </span>
                    <span className={`dock-subtask-detail ${jobState}`}>
                      {describeJob(
                        { status: job.status, meta: job.meta },
                        t,
                      )}
                    </span>
                    {ticker ? (
                      <Link
                        className="dock-mini-link"
                        to={`/c/${encodeURIComponent(ticker)}`}
                        onClick={onNavigate}
                      >
                        {t("dock.viewCompany")}
                      </Link>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function DataRunRow({
  run,
  open,
  onToggle,
  onNavigate,
}: {
  run: DataRunView;
  open: boolean;
  onToggle: () => void;
  onNavigate: () => void;
}) {
  const { t, lang } = useLang();
  const state = dataRunState(run);
  const detail = useQuery({
    queryKey: ["data-run", run.runId],
    queryFn: () => getRun(run.runId),
    enabled: open,
    staleTime: 3_000,
    refetchInterval: run.active ? 5_000 : false,
  });
  const groups = useMemo(
    () => groupDataJobs(detail.data?.data.jobs ?? []),
    [detail.data],
  );
  const pct = dataRunPercent(run);
  const elapsed =
    run.elapsedMs ??
    Math.max(0, Date.now() - new Date(run.startedAt).getTime());

  return (
    <article className="dock-task" data-state={state}>
      <button
        type="button"
        className="dock-task-head"
        aria-expanded={open}
        aria-controls={`dock-body-${run.runId}`}
        onClick={onToggle}
      >
        <span className="dock-task-icon data" aria-hidden="true">
          {ICON_FILINGS}
        </span>
        <span className="dock-task-main">
          <span className="dock-task-title-row">
            <span className="dock-task-title">
              {t("dock.dataTitle", { count: run.companies })}
            </span>
            <span className="dock-badge data">{t("dock.badgeData")}</span>
          </span>
          <span className="dock-task-status">
            <span className={`dock-dot ${state}`} aria-hidden="true" />
            {describeDataRun(run, lang, t)}
          </span>
          {state !== "completed" ? (
            <span
              className={`dock-task-bar ${state}`}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={run.total || 1}
              aria-valuenow={run.done}
            >
              <span style={{ width: `${pct}%` }} />
            </span>
          ) : null}
          <span className="dock-task-meta">
            <span>{relativePast(run.finishedAt ?? run.startedAt, lang)}</span>
            <span>·</span>
            <span>{formatElapsed(elapsed, lang)}</span>
          </span>
        </span>
        {ICON_CHEVRON}
      </button>
      <div id={`dock-body-${run.runId}`} hidden={!open}>
        {open ? (
          <div className="dock-task-body">
            {detail.isLoading ? (
              <div className="dock-subtask muted">{t("common.loading")}</div>
            ) : groups.length === 0 ? (
              <div className="dock-subtask muted">{t("common.noData")}</div>
            ) : (
              groups.map((group) => {
                const description = describeDataSubtask(group, t);
                return (
                  <div className="dock-subtask" key={group.companyId}>
                    <span
                      className={`dock-dot ${description.state}`}
                      aria-hidden="true"
                    />
                    <span className="dock-subtask-who">
                      <span className="dock-subtask-name">{group.name}</span>
                      {group.ticker ? (
                        <span className="dock-subtask-ticker">
                          {group.ticker}
                        </span>
                      ) : null}
                    </span>
                    <span
                      className={`dock-subtask-detail ${description.state}`}
                    >
                      {description.text}
                    </span>
                    {group.ticker ? (
                      <Link
                        className="dock-mini-link"
                        to={`/c/${encodeURIComponent(group.ticker)}`}
                        onClick={onNavigate}
                      >
                        {t("dock.viewCompany")}
                      </Link>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function earliest(...values: Array<string | null>): string | null {
  let best: string | null = null;
  let bestTime = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) continue;
    if (time < bestTime) {
      bestTime = time;
      best = value;
    }
  }
  return best;
}

function describeEntry(
  entry: DockEntry,
  lang: "zh" | "en",
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  return entry.kind === "news"
    ? describeSweep(entry.run, lang, t)
    : describeDataRun(entry.run, lang, t);
}

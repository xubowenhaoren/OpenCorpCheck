import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import {
  getNewsStatus,
  getRun,
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

/**
 * Global task dock.
 *
 * Current production: automatic news sweeps only. The 2026-11-03 decision
 * restores the original shared design (news + `财报更新` data/filing/financials
 * groups with `全部 / 更新新闻 / 财报更新` filters); that is a P1.5 follow-up,
 * not implemented here yet. See CONTEXT_TRANSFER §10 and docs/UI.md §7.9.
 *
 * There are no manual controls, and the manual refresh-news button stays
 * cancelled (decision 34). Polling `/v1/news/status` both observes the sweep and
 * lets the API lazily start one when companies are due, so opening the site is
 * enough — no refresh button, no operator backfill.
 */
export function TaskDock() {
  const { t, lang } = useLang();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);

  const statusQuery = useQuery({
    queryKey: ["news-status"],
    queryFn: () => getNewsStatus(),
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: (query) =>
      query.state.data?.data.active ||
      query.state.data?.data.triggered ||
      query.state.data?.data.pendingSweep
        ? 5_000
        : 60_000,
  });
  const status = statusQuery.data?.data;
  const active = status?.active ?? null;
  const lastSweep = status?.lastSweep ?? null;
  const pendingSweep = status?.pendingSweep ?? false;
  const sweeps = useMemo(() => status?.sweeps ?? [], [status]);
  const pct = active ? sweepPercent(active) : 0;

  // Expand the active sweep the first time it appears.
  useEffect(() => {
    if (active) {
      setExpanded((current) =>
        current.includes(active.runId) ? current : [active.runId, ...current],
      );
    }
  }, [active?.runId]);

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

  const issues =
    sweeps.filter(
      (sweep) => sweep.status === "partial" || sweep.status === "failed",
    ).length;
  const announce = lastSweep
    ? `${t("dock.lastSweep")}：${describeSweep(lastSweep, lang, t)}`
    : t("dock.noSweep");

  return (
    <div className="dock-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`dock-btn${active ? " is-active" : ""}`}
        aria-expanded={open}
        aria-controls="occ-task-dock"
        aria-label={
          active
            ? `${t("dock.open")}，${active.done}/${active.total}`
            : t("dock.open")
        }
        onClick={() => setOpen((value) => !value)}
      >
        <svg className="dock-ring" viewBox="0 0 46 46" aria-hidden="true">
          <circle className="track" cx="23" cy="23" r="20.5" />
          <circle
            className={`fill${!active && issues > 0 ? " warn" : ""}`}
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
        {active ? (
          <span className="dock-count">{1}</span>
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
                {active
                  ? t("dock.subActive", { count: 1 })
                  : pendingSweep
                    ? t("dock.queued")
                    : t("dock.subIdle")}
              </div>
            </div>
            <div className="dock-overall">
              {active ? (
                <>
                  <div className="dock-pct">{pct}%</div>
                  <div className="dock-counts">
                    {active.done}/{active.total}
                  </div>
                </>
              ) : (
                <div className="dock-counts">
                  {lastSweep
                    ? `${t("dock.lastSweep")} · ${relativePast(lastSweep.finishedAt ?? lastSweep.startedAt, lang)}`
                    : t("dock.noSweep")}
                </div>
              )}
            </div>
          </div>
          {active ? (
            <div
              className="dock-overall-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={active.total || 1}
              aria-valuenow={active.done}
            >
              <span style={{ width: `${pct}%` }} />
            </div>
          ) : null}
          {!active && pendingSweep ? (
            <div className="dock-next">{t("dock.queuedHint")}</div>
          ) : !active && status?.nextDueAt ? (
            <div className="dock-next">
              {t("dock.nextDue", {
                time: relativeFuture(status.nextDueAt, lang),
              })}
            </div>
          ) : null}
        </div>

        <div className="dock-list">
          {sweeps.length === 0 ? (
            <div className="dock-empty">
              <div className="dock-empty-title">
                {pendingSweep ? t("dock.queued") : t("dock.noSweep")}
              </div>
              <div>
                {pendingSweep ? t("dock.queuedHint") : t("dock.noSweepHint")}
              </div>
            </div>
          ) : (
            sweeps.map((sweep) => (
              <SweepRow
                key={sweep.runId}
                sweep={sweep}
                open={expanded.includes(sweep.runId)}
                onToggle={() => toggleExpanded(sweep.runId)}
                onNavigate={() => setOpen(false)}
              />
            ))
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
        <span className="dock-task-icon" aria-hidden="true">
          {ICON_NEWS}
        </span>
        <span className="dock-task-main">
          <span className="dock-task-title-row">
            <span className="dock-task-title">
              {t("dock.sweepTitle", { count: sweep.total })}
            </span>
            <span className="dock-badge">{t("dock.badge")}</span>
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

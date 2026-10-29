import { useEffect, useMemo, useState } from "react";

import {
  buildSourceLedger,
  describeTool,
  formatDuration,
  groupCountLabel,
  groupStatusLabel,
  groupToolCalls,
  isActiveStatus,
  toolErrorSummary,
  type AgentToolCall,
  type ToolGroup,
} from "../lib/agent-trace";
import { useLang } from "../i18n";

/** Old groups are rolled into a "此前 N 组" line; the panel stays short. */
const MAX_GROUPS = 4;
const MAX_CHILD_ROWS = 4;

interface AgentActivityProps {
  calls: AgentToolCall[];
  /** When the user sent the question; the live ticker counts from here. */
  startedAt?: number;
  /** Frozen duration for finished turns. */
  elapsedMs?: number;
}

function LiveGroup({ group }: { group: ToolGroup }) {
  const { lang } = useLang();
  const active = group.calls.some((call) => isActiveStatus(call.status));

  if (!active) {
    return (
      <li className={`live-step collapsed ${group.status}`}>
        <span className="live-mark" aria-hidden="true">
          {group.status === "failed"
            ? "!"
            : group.status === "cancelled"
              ? "·"
              : "✓"}
        </span>
        <span className="live-step-label">
          {groupCountLabel(group, lang)}
        </span>
        {group.status !== "completed" ? (
          <span className="live-step-status">
            {groupStatusLabel(group, lang)}
          </span>
        ) : null}
      </li>
    );
  }

  const rows = group.calls.slice(-MAX_CHILD_ROWS);
  const hidden = group.calls.length - rows.length;

  return (
    <li className="live-step active">
      <div className="live-group-head">
        <span className="live-pulse" aria-hidden="true" />
        <span className="live-step-label">{group.label}</span>
        {group.calls.length > 1 ? (
          <span className="live-count">×{group.calls.length}</span>
        ) : null}
      </div>
      <ul className="live-children">
        {hidden > 0 ? (
          <li className="live-child more">+{hidden}</li>
        ) : null}
        {rows.map((call) => {
          const descriptor = describeTool(call, lang);
          const running = isActiveStatus(call.status);
          const failed = call.status === "failed";
          const error = failed ? toolErrorSummary(call) : "";
          return (
            <li
              className={`live-child ${
                running ? "running" : failed ? "failed" : "done"
              }`}
              key={call.callId}
            >
              <span className="live-child-mark" aria-hidden="true" />
              <span className="live-child-text">
                {running ? (
                  <span className="live-dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                ) : null}
                <span className="live-child-detail">
                  {descriptor.detail || descriptor.label}
                </span>
                {failed && error ? (
                  <span className="live-child-error">{error}</span>
                ) : null}
              </span>
              {!running && call.endedAt ? (
                <span className="live-child-time">
                  {formatDuration(call.endedAt - call.startedAt, lang)}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </li>
  );
}

/**
 * Transient activity panel shown while the assistant is researching and has
 * not started writing an answer yet.
 *
 * Interaction rhythm (Grok-like, not a debug panel): the current group is
 * expanded with a running indicator, finished groups collapse to one line the
 * moment they complete, and a new call automatically folds the previous group.
 * Once answer text starts streaming the sidebar replaces this panel with the
 * single-line trace summary.
 */
export function AgentActivity({
  calls,
  startedAt,
  elapsedMs,
}: AgentActivityProps) {
  const { lang, t } = useLang();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const groups = useMemo(() => groupToolCalls(calls, lang), [calls, lang]);
  const sourceCount = useMemo(
    () => buildSourceLedger("", calls).length,
    [calls],
  );
  const firstCall = calls.reduce(
    (earliest, call) => Math.min(earliest, call.startedAt),
    Number.POSITIVE_INFINITY,
  );
  const base = startedAt ?? (Number.isFinite(firstCall) ? firstCall : now);
  const elapsed = elapsedMs ?? Math.max(now - base, 0);
  const visible = groups.slice(-MAX_GROUPS);
  const hidden = groups.length - visible.length;
  const duration = formatDuration(Math.max(elapsed, 1_000), lang);

  return (
    <div
      className="agent-live"
      role="status"
      aria-live="polite"
      aria-label={t("agent.live.title")}
    >
      <div className="agent-live-head">
        <span className="live-orb" aria-hidden="true" />
        <span className="live-title">{t("agent.live.title")}</span>
        <span className="live-elapsed" aria-hidden="true">
          {duration}
        </span>
      </div>
      <ul className="live-steps">
        {hidden > 0 ? (
          <li className="live-step collapsed earlier">
            <span className="live-mark" aria-hidden="true">
              ✓
            </span>
            <span className="live-step-label">
              {t("agent.live.earlier", { count: hidden })}
            </span>
          </li>
        ) : null}
        {visible.map((group) => (
          <LiveGroup
            group={group}
            key={`${group.key}:${group.status}`}
          />
        ))}
      </ul>
      <div className="live-foot">
        <span>{t("agent.live.steps", { steps: calls.length })}</span>
        {sourceCount > 0 ? (
          <span>{t("agent.live.sources", { sources: sourceCount })}</span>
        ) : null}
      </div>
    </div>
  );
}

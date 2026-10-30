import { useEffect, useMemo, useState } from "react";

import {
  buildSourceLedger,
  callDurationMs,
  citedUrlSet,
  describeTool,
  formatDuration,
  groupCountLabel,
  groupStatusLabel,
  groupToolCalls,
  isActiveStatus,
  isCallCited,
  planSteps,
  toolCallLinks,
  toolErrorSummary,
  toolStatusLabel,
  usageSummary,
  type AgentToolCall,
  type SourceLink,
  type ToolGroup,
  type UsageSummary,
} from "../lib/agent-trace";
import { useLang } from "../i18n";

/** Per-row link list stays short; the rest is a "+N" line. */
const MAX_ROW_LINKS = 8;

interface AgentTrajectoryProps {
  calls: AgentToolCall[];
  answer: string;
  plan: string[];
  /** When the user sent the question; the live header counts from here. */
  startedAt: number;
  /** Frozen duration for finished turns. */
  elapsedMs?: number;
  streaming: boolean;
  usage?: UsageSummary;
}

function statusClass(status: string): string {
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "completed") return "completed";
  return "running";
}

/** Tick once a second only while the turn is still running. */
function useElapsed(startedAt: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return Math.max(now - startedAt, 0);
}

/**
 * One expandable row per tool call: query/URL, status, duration, whether the
 * answer cited it, and (when expanded) result count, domains and hit links.
 * Never raw JSON/HTML.
 */
function ToolRow({
  call,
  cited,
}: {
  call: AgentToolCall;
  cited: Set<string>;
}) {
  const { lang, t } = useLang();
  const descriptor = describeTool(call, lang);
  const links = toolCallLinks(call);
  const shownLinks = links.slice(0, MAX_ROW_LINKS);
  const hiddenLinks = links.length - shownLinks.length;
  const isCited = isCallCited(call, cited);
  const duration = callDurationMs(call);
  const durationLabel =
    duration !== undefined ? formatDuration(duration, lang) : "";
  const error = toolErrorSummary(call);
  const detail = descriptor.detail || descriptor.label;
  const hasBody = links.length > 0 || Boolean(descriptor.meta) || Boolean(error);
  const statusLine = [toolStatusLabel(call.status, lang), descriptor.meta]
    .filter(Boolean)
    .join(" · ");

  const summary = (
    <>
      <span className="trace-dot" aria-hidden="true" />
      <span className="trace-tool-main">
        <span className="trace-tool-detail" title={detail}>
          {detail}
        </span>
      </span>
      {isCited ? (
        <span className="trace-cited">{t("agent.trace.citedBadge")}</span>
      ) : null}
      {durationLabel ? (
        <span className="trace-tool-status">{durationLabel}</span>
      ) : null}
    </>
  );

  if (!hasBody) {
    return (
      <div className={`trace-tool static ${statusClass(call.status)}`}>
        <div className="trace-tool-row">{summary}</div>
      </div>
    );
  }

  return (
    <details className={`trace-tool ${statusClass(call.status)}`}>
      <summary>{summary}</summary>
      <div className="trace-tool-body">
        <div className="trace-line trace-meta">{statusLine}</div>
        {error ? (
          <div className="trace-line trace-error">
            {t("agent.trace.error")}
            {lang === "zh" ? "：" : ": "}
            {error}
          </div>
        ) : null}
        {shownLinks.length > 0 ? (
          <ul className="trace-urls">
            {shownLinks.map((link) => (
              <li key={link.url}>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={link.url}
                >
                  {link.title || link.url}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        {hiddenLinks > 0 ? (
          <p className="trace-more">
            {lang === "zh" ? `+${hiddenLinks} 条` : `+${hiddenLinks} more`}
          </p>
        ) : null}
      </div>
    </details>
  );
}

/**
 * A merged group (search 3× / opened 9 pages). While the turn runs, the group
 * holding the active call opens by itself; a group that finishes folds again.
 * Once the answer arrives the state is frozen, so anything open stays open.
 */
function GroupSection({
  group,
  cited,
  live,
}: {
  group: ToolGroup;
  cited: Set<string>;
  live: boolean;
}) {
  const { lang } = useLang();
  const autoOpen = live && group.calls.some((call) => isActiveStatus(call.status));
  const [open, setOpen] = useState(autoOpen);

  useEffect(() => {
    if (autoOpen) setOpen(true);
    else if (live) setOpen(false);
  }, [autoOpen, live]);

  return (
    <details
      className={`trace-group ${statusClass(group.status)}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="trace-dot" aria-hidden="true" />
        <span className="trace-group-label">
          {groupCountLabel(group, lang)}
        </span>
        {group.status !== "completed" ? (
          <span className="trace-group-status">
            {groupStatusLabel(group, lang)}
          </span>
        ) : null}
        <span className="trace-chevron" aria-hidden="true">
          ▸
        </span>
      </summary>
      <div className="trace-group-calls">
        {group.calls.map((call) => (
          <ToolRow call={call} cited={cited} key={call.callId} />
        ))}
      </div>
    </details>
  );
}

function SourceGroup({
  title,
  items,
}: {
  title: string;
  items: SourceLink[];
}) {
  if (!items.length) return null;
  const shown = items.slice(0, 20);
  return (
    <div className="trace-source-group">
      <h5>{title}</h5>
      <ul>
        {shown.map((item) => (
          <li className="trace-source" key={item.url}>
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              title={item.url}
            >
              {item.title || item.domain}
            </a>
            {item.title ? (
              <span className="trace-domain">{item.domain}</span>
            ) : null}
          </li>
        ))}
      </ul>
      {items.length > shown.length ? (
        <p className="trace-more">+{items.length - shown.length}</p>
      ) : null}
    </div>
  );
}

/**
 * The single work-trajectory card above one assistant answer.
 *
 * It is the same element in both states: while the model researches it shows
 * an orb and an open, running group; as soon as answer text streams it turns
 * static in place (no spinner) and keeps the merged group lines for reference.
 * Groups open on demand, so a 20-call sweep never becomes 20 cards.
 */
export function AgentTrajectory({
  calls,
  answer,
  plan,
  startedAt,
  elapsedMs,
  streaming,
  usage,
}: AgentTrajectoryProps) {
  const { lang, t } = useLang();
  const live = streaming && !answer;
  const elapsed = useElapsed(
    startedAt,
    streaming && elapsedMs === undefined,
  );
  const groups = useMemo(() => groupToolCalls(calls, lang), [calls, lang]);
  const cited = useMemo(() => citedUrlSet(answer), [answer]);
  const ledger = useMemo(
    () => buildSourceLedger(answer, calls),
    [answer, calls],
  );
  const citedSources = ledger.filter((item) => item.cited);
  const consulted = ledger.filter((item) => !item.cited);
  const planLines = planSteps(plan);
  const usageLine = usageSummary(usage, lang);
  const durationMs = elapsedMs ?? (streaming ? elapsed : undefined);
  const duration =
    durationMs !== undefined
      ? formatDuration(Math.max(durationMs, 1_000), lang)
      : "";
  // While researching there are no citations yet; show everything consulted.
  const sourceCount = live ? ledger.length : citedSources.length;
  const stats = [
    t("agent.trace.steps", { steps: calls.length }),
    duration,
    sourceCount > 0
      ? t("agent.trace.sourcesCount", { count: sourceCount })
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const hasMore =
    !live && (planLines.length > 0 || ledger.length > 0 || Boolean(usageLine));

  return (
    <section
      className={`agent-trace ${live ? "live" : "static"}`}
      aria-label={t("agent.trace.title")}
    >
      <div className="trace-head">
        {live ? <span className="trace-orb" aria-hidden="true" /> : null}
        <span
          className="trace-head-title"
          role={live ? "status" : undefined}
          aria-live={live ? "polite" : undefined}
        >
          {live ? t("agent.live.title") : t("agent.trace.title")}
        </span>
        <span className="trace-head-stats" aria-hidden={live ? true : undefined}>
          {stats}
        </span>
      </div>

      <div className="trace-groups">
        {groups.map((group) => (
          <GroupSection
            group={group}
            cited={cited}
            live={live}
            key={group.key}
          />
        ))}
      </div>

      {hasMore ? (
        <details className="trace-more-block">
          <summary>
            <span className="trace-chevron" aria-hidden="true">
              ▸
            </span>
            <span>{t("agent.trace.more")}</span>
          </summary>
          <div className="trace-body">
            {planLines.length > 0 ? (
              <div className="trace-plan">
                <h4>{t("agent.trace.plan")}</h4>
                <ol>
                  {planLines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ol>
              </div>
            ) : null}

            {ledger.length > 0 ? (
              <div className="trace-ledger">
                <h4>{t("agent.trace.sources")}</h4>
                <SourceGroup title={t("agent.trace.cited")} items={citedSources} />
                <SourceGroup
                  title={t("agent.trace.consulted")}
                  items={consulted}
                />
              </div>
            ) : null}

            {usageLine ? <p className="trace-usage">{usageLine}</p> : null}
          </div>
        </details>
      ) : null}
    </section>
  );
}

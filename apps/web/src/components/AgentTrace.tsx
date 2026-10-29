import {
  buildSourceLedger,
  describeTool,
  formatDuration,
  isActiveStatus,
  planSteps,
  toolErrorSummary,
  toolStatusLabel,
  usageSummary,
  type AgentToolCall,
  type SourceLink,
  type UsageSummary,
} from "../lib/agent-trace";
import { useLang } from "../i18n";

interface AgentTraceProps {
  calls: AgentToolCall[];
  answer: string;
  plan: string[];
  /** Wall-clock duration; `undefined` while the turn is still running. */
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

function ToolCard({ call }: { call: AgentToolCall }) {
  const { lang, t } = useLang();
  const descriptor = describeTool(call, lang);
  const error = toolErrorSummary(call);
  const urls = descriptor.urls.slice(0, 6);
  const duration =
    call.endedAt !== undefined && call.endedAt - call.startedAt >= 1_000
      ? formatDuration(call.endedAt - call.startedAt, lang)
      : "";
  const statusText = [toolStatusLabel(call.status, lang), duration]
    .filter(Boolean)
    .join(" · ");

  return (
    <details className={`trace-tool ${statusClass(call.status)}`}>
      <summary>
        <span className="trace-dot" aria-hidden="true" />
        <span className="trace-tool-main">
          <span className="trace-tool-label">{descriptor.label}</span>
          {descriptor.detail ? (
            <span className="trace-tool-detail">{descriptor.detail}</span>
          ) : null}
        </span>
        <span className="trace-tool-status">{statusText}</span>
      </summary>
      <div className="trace-tool-body">
        {descriptor.meta ? (
          <div className="trace-line">{descriptor.meta}</div>
        ) : null}
        {error ? (
          <div className="trace-line trace-error">
            {t("agent.trace.error")}
            {lang === "zh" ? "：" : ": "}
            {error}
          </div>
        ) : null}
        {urls.length > 0 ? (
          <ul className="trace-urls">
            {urls.map((url) => (
              <li key={url}>
                <a href={url} target="_blank" rel="noopener noreferrer">
                  {url}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
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
 * Collapsed "execution trace" under one assistant answer.
 *
 * Default view stays answer + citations; this is progressive disclosure for
 * users who want to know what the assistant actually did. Each card carries a
 * text status so colour is never the only signal.
 */
export function AgentTrace({
  calls,
  answer,
  plan,
  elapsedMs,
  streaming,
  usage,
}: AgentTraceProps) {
  const { lang, t } = useLang();
  const steps = calls.length;
  const ledger = buildSourceLedger(answer, calls);
  const cited = ledger.filter((item) => item.cited);
  const consulted = ledger.filter((item) => !item.cited);
  const duration =
    typeof elapsedMs === "number"
      ? formatDuration(elapsedMs, lang)
      : formatDuration(0, lang);
  const summary = streaming
    ? t("agent.trace.running", { steps })
    : t("agent.trace.summary", {
        steps,
        sources: cited.length,
        duration,
      });
  const planLines = planSteps(plan);
  const usageLine = usageSummary(usage, lang);

  return (
    <details className="agent-trace">
      <summary>
        <span className="trace-chevron" aria-hidden="true">
          ▸
        </span>
        <span className="trace-summary-text">{summary}</span>
        {streaming && calls.some((call) => isActiveStatus(call.status)) ? (
          <span className="spinner" aria-hidden="true" />
        ) : null}
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

        <div className="trace-tools">
          {calls.map((call) => (
            <ToolCard key={call.callId} call={call} />
          ))}
        </div>

        {ledger.length > 0 ? (
          <div className="trace-ledger">
            <h4>{t("agent.trace.sources")}</h4>
            <SourceGroup title={t("agent.trace.cited")} items={cited} />
            <SourceGroup title={t("agent.trace.consulted")} items={consulted} />
          </div>
        ) : null}

        {usageLine ? <p className="trace-usage">{usageLine}</p> : null}
      </div>
    </details>
  );
}

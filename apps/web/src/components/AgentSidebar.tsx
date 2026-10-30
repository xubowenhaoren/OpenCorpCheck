import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import {
  ApiError,
  cancelAgentSession,
  createAgentSession,
  getAgentSessionReplay,
  listAgentSessions,
  streamAgentPrompt,
  type AgentReplayTurn,
  type AgentSessionSummary,
  type AgentStreamEvent,
} from "../api";
import { useAgent } from "../contexts/AgentContext";
import { useLang } from "../i18n";
import {
  clearStoredAgentSession,
  formatSessionAge,
  readStoredAgentSession,
  replayElapsedMs,
  replayToolCalls,
  storeAgentSession,
  stripReplayPrompt,
} from "../lib/agent-replay";
import {
  isTerminalStatus,
  uniqueUrls,
  type AgentToolCall,
  type UsageSummary,
} from "../lib/agent-trace";
import { AgentTrajectory } from "./AgentTrajectory";

// Code-split: the Markdown parser only loads once an assistant answer renders.
const MarkdownMessage = lazy(() => import("./MarkdownMessage"));

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  status: "streaming" | "done" | "error";
  startedAt: number;
  elapsedMs?: number;
  tools: AgentToolCall[];
  plan: string[];
  usage?: UsageSummary;
  /** Stable notice code; drives highlighting such as the resume fallback. */
  noticeCode?: string;
}

/** Keep the streaming UI responsive without re-parsing Markdown per token. */
const TEXT_FLUSH_MS = 90;

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function Linkified({ text }: { text: string }): ReactNode {
  const parts = text.split(/(https?:\/\/[^\s)\]}>"']+)/g);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <a
            key={`${index}-${part}`}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
          >
            {part}
          </a>
        ) : (
          <span key={`${index}-text`}>{part}</span>
        ),
      )}
    </>
  );
}

function mergeTool(
  list: AgentToolCall[],
  patch: Partial<AgentToolCall> & { callId: string },
): AgentToolCall[] {
  const index = list.findIndex((item) => item.callId === patch.callId);
  if (index === -1) {
    return [
      ...list,
      {
        title: "",
        tool: null,
        kind: null,
        status: "pending",
        startedAt: Date.now(),
        ...patch,
      },
    ];
  }
  const next = [...list];
  const current = next[index];
  const merged: AgentToolCall = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && value !== null) {
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
  }
  if (isTerminalStatus(merged.status) && !merged.endedAt) {
    merged.endedAt = Date.now();
  }
  next[index] = merged;
  return next;
}

/** Persisted turns → the same message shape the live SSE path builds. */
function messagesFromReplay(turns: AgentReplayTurn[]): Message[] {
  const messages: Message[] = [];
  for (const turn of turns) {
    messages.push({
      id: `replay-user-${turn.turn}`,
      role: "user",
      text: stripReplayPrompt(turn.prompt),
      status: "done",
      startedAt: turn.startedAt,
      tools: [],
      plan: [],
    });
    messages.push({
      id: `replay-assistant-${turn.turn}`,
      role: "assistant",
      text: turn.answer,
      status: "done",
      startedAt: turn.startedAt,
      elapsedMs: replayElapsedMs(turn),
      tools: replayToolCalls(turn),
      plan: [],
    });
  }
  return messages;
}

export function AgentSidebar() {
  const { open, company, initialQuestion, closeAgent, consumeInitialQuestion } =
    useAgent();
  const { t, lang } = useLang();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySessions, setHistorySessions] = useState<AgentSessionSummary[]>(
    [],
  );
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const historyRef = useRef<HTMLDivElement | null>(null);
  const historyRequestRef = useRef(0);
  const sessionRef = useRef<string | null>(null);
  /** A live prompt or history pick started; a slow mount replay must not overwrite it. */
  const liveStartedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const asideRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    const element = asideRef.current;
    if (!element) return;
    element.inert = !open;
    element.setAttribute("aria-hidden", String(!open));
  }, [open]);

  // Restore the last dsh session from its persisted log. dsh owns the log;
  // the API folds it into the same tool-call shape the SSE stream produces, so
  // the trajectory card renders history exactly like a finished live turn.
  useEffect(() => {
    const stored = readStoredAgentSession();
    if (!stored) return;
    sessionRef.current = stored;
    let cancelled = false;
    void getAgentSessionReplay(stored)
      .then((replay) => {
        if (cancelled || liveStartedRef.current) return;
        const restored = messagesFromReplay(replay.turns);
        if (restored.length > 0) setMessages(restored);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        // The log is gone (new machine, cleared DSH_HOME): forget the id.
        if (caught instanceof ApiError && caught.status === 404) {
          clearStoredAgentSession();
          if (!liveStartedRef.current) sessionRef.current = null;
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the history menu from dsh's persisted sessions on each open.
  useEffect(() => {
    if (!historyOpen) return;
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryFailed(false);
    historyRequestRef.current += 1;
    void listAgentSessions()
      .then((sessions) => {
        if (!cancelled) setHistorySessions(sessions);
      })
      .catch(() => {
        if (!cancelled) setHistoryFailed(true);
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [historyOpen]);

  // Dismiss the popover on outside click or Escape.
  useEffect(() => {
    if (!historyOpen) return;
    function onPointerDown(event: MouseEvent): void {
      if (!historyRef.current?.contains(event.target as Node)) {
        setHistoryOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setHistoryOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [historyOpen]);

  // Closing/reloading the page must not leave a dsh turn running. The SSE
  // request abort usually reaches the API, but sendBeacon survives page
  // teardown. Closing the sidebar panel alone intentionally keeps the turn
  // running; only the Stop button or leaving the page cancels it.
  useEffect(() => {
    function cancelOnPageHide(): void {
      const sessionId = sessionRef.current;
      if (!busyRef.current || !sessionId) return;
      const url = `/v1/agent/sessions/${encodeURIComponent(sessionId)}/cancel`;
      if (typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon(url);
      } else {
        void fetch(url, { method: "POST", keepalive: true }).catch(
          () => undefined,
        );
      }
    }
    window.addEventListener("pagehide", cancelOnPageHide);
    return () => window.removeEventListener("pagehide", cancelOnPageHide);
  }, []);

  useEffect(() => {
    const element = bodyRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages, busy]);

  useEffect(() => {
    if (!open) return;
    if (initialQuestion) {
      consumeInitialQuestion();
      void send(initialQuestion);
    } else {
      const timer = window.setTimeout(() => inputRef.current?.focus(), 300);
      return () => window.clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialQuestion]);

  async function send(raw: string) {
    const question = raw.trim();
    if (!question || busyRef.current) return;
    liveStartedRef.current = true;
    setHistoryOpen(false);
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setInput("");

    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    const startedAt = Date.now();
    let assistantText = "";
    let flushTimer: number | null = null;
    let finished = false;
    const seenCalls = new Set<string>();

    setMessages((previous) => [
      ...previous,
      {
        id: userId,
        role: "user",
        text: question,
        status: "done",
        startedAt,
        tools: [],
        plan: [],
      },
      {
        id: assistantId,
        role: "assistant",
        text: "",
        status: "streaming",
        startedAt,
        tools: [],
        plan: [],
      },
    ]);

    const updateAssistant = (updater: (message: Message) => Message) => {
      setMessages((previous) =>
        previous.map((message) =>
          message.id === assistantId ? updater(message) : message,
        ),
      );
    };

    const flushText = () => {
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
        flushTimer = null;
      }
      updateAssistant((message) => ({ ...message, text: assistantText }));
    };

    const scheduleFlush = () => {
      if (flushTimer !== null) return;
      flushTimer = window.setTimeout(() => {
        flushTimer = null;
        setMessages((previous) =>
          previous.map((message) =>
            message.id === assistantId
              ? { ...message, text: assistantText }
              : message,
          ),
        );
      }, TEXT_FLUSH_MS);
    };

    const finish = (status: "done" | "error", fallbackText?: string) => {
      if (finished) return;
      finished = true;
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
        flushTimer = null;
      }
      const text = assistantText || fallbackText || "";
      const elapsedMs = Date.now() - startedAt;
      updateAssistant((message) => ({
        ...message,
        text,
        status,
        elapsedMs,
      }));
    };

    try {
      let sessionId = sessionRef.current;
      if (!sessionId) {
        const session = await createAgentSession();
        sessionId = session.sessionId;
        sessionRef.current = sessionId;
        storeAgentSession(sessionId);
      }

      const controller = new AbortController();
      abortRef.current = controller;
      const contextLine = company
        ? lang === "zh"
          ? `当前公司：${company.name}${company.ticker ? `（${company.ticker}）` : ""}。\n\n`
          : `Current company: ${company.name}${company.ticker ? ` (${company.ticker})` : ""}.\n\n`
        : "";
      const payload = `${contextLine}${question}`;

      await streamAgentPrompt(
        sessionId,
        payload,
        (event: AgentStreamEvent) => {
          if (finished) return;
          if (event.type === "assistant.delta") {
            const delta = asString(event.text);
            if (!delta) return;
            assistantText += delta;
            scheduleFlush();
            return;
          }
          if (event.type === "tool.called") {
            flushText();
            const callId = asString(event.callId);
            if (!callId) return;
            seenCalls.add(callId);
            updateAssistant((message) => ({
              ...message,
              tools: mergeTool(message.tools, {
                callId,
                title: asString(event.title),
                tool: asString(event.tool) || null,
                kind: asString(event.kind) || null,
                status: asString(event.status) || "pending",
                input: event.input,
              }),
            }));
            return;
          }
          if (event.type === "tool.updated") {
            const callId = asString(event.callId);
            if (!callId) return;
            const title = asString(event.title) || undefined;
            const status = asString(event.status) || undefined;
            updateAssistant((message) => ({
              ...message,
              tools: mergeTool(message.tools, {
                callId,
                ...(title ? { title } : {}),
                ...(status ? { status } : {}),
                ...(event.input !== undefined ? { input: event.input } : {}),
                ...(event.output !== undefined ? { output: event.output } : {}),
              }),
            }));
            return;
          }
          if (event.type === "plan") {
            const entries = Array.isArray(event.entries) ? event.entries : [];
            updateAssistant((message) => ({ ...message, plan: entries }));
            return;
          }
          if (event.type === "usage") {
            const used = typeof event.used === "number" ? event.used : undefined;
            const size = typeof event.size === "number" ? event.size : undefined;
            if (used !== undefined && size !== undefined) {
              updateAssistant((message) => ({
                ...message,
                usage: { used, size },
              }));
            }
            return;
          }
          if (event.type === "notice") {
            const title = asString(event.title);
            const description = asString(event.description);
            const code = asString(event.code);
            const fallback = [title, description].filter(Boolean).join(" · ");
            const localized = code
              ? t(code, { steps: seenCalls.size })
              : fallback;
            const text = localized === code ? fallback : localized;
            if (text) {
              setMessages((previous) => {
                // The assistant bubble is created when the question is sent,
                // so a notice would otherwise land below the answer. Put it
                // above the answer, right after the user's question, where it
                // explains what happened before the model responded.
                const next = [...previous];
                const at = next.findIndex(
                  (message) => message.id === assistantId,
                );
                const notice: Message = {
                  id: crypto.randomUUID(),
                  role: "system",
                  text,
                  status: "done",
                  startedAt: Date.now(),
                  tools: [],
                  plan: [],
                  ...(code ? { noticeCode: code } : {}),
                };
                if (at >= 0) next.splice(at, 0, notice);
                else next.push(notice);
                return next;
              });
            }
            return;
          }
          if (event.type === "run.failed") {
            const code = asString(event.code);
            const fallback = asString(event.error) || t("agent.error");
            const localized = code ? t(code) : fallback;
            finish("error", localized === code ? fallback : localized);
            return;
          }
          if (event.type === "run.completed") {
            finish("done");
          }
        },
        controller.signal,
      );

      finish("done");
    } catch (caught) {
      const aborted =
        caught instanceof DOMException && caught.name === "AbortError";
      if (aborted) {
        finish("done");
      } else {
        const message =
          caught instanceof Error ? caught.message : String(caught);
        setError(message);
        finish("error", t("agent.error"));
      }
    } finally {
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      busyRef.current = false;
      setBusy(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
    if (sessionRef.current) {
      void cancelAgentSession(sessionRef.current).catch(() => undefined);
    }
  }

  /** Open a persisted session from the history menu. */
  async function openSession(sessionId: string) {
    setHistoryOpen(false);
    if (busyRef.current || sessionId === sessionRef.current) return;
    const request = ++historyRequestRef.current;
    try {
      const replay = await getAgentSessionReplay(sessionId);
      if (request !== historyRequestRef.current) return;
      liveStartedRef.current = true;
      sessionRef.current = sessionId;
      storeAgentSession(sessionId);
      setMessages(messagesFromReplay(replay.turns));
      setError(null);
      setInput("");
      setHistoryFailed(false);
    } catch (caught) {
      if (request !== historyRequestRef.current) return;
      if (caught instanceof ApiError && caught.status === 404) {
        setHistoryFailed(true);
        return;
      }
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  /** Drop the persisted session and return to the empty greeting. */
  function newChat() {
    liveStartedRef.current = true;
    setHistoryOpen(false);
    if (busyRef.current) {
      stop();
    } else if (sessionRef.current) {
      void cancelAgentSession(sessionRef.current).catch(() => undefined);
    }
    sessionRef.current = null;
    clearStoredAgentSession();
    setMessages([]);
    setError(null);
    setInput("");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send(input);
  }

  const suggestions = company
    ? [
        t("agent.suggest1", { name: company.name }),
        t("agent.suggest2", { name: company.name }),
        t("agent.suggest3", { name: company.name }),
      ]
    : [
        t("agent.genericSuggest1"),
        t("agent.genericSuggest2"),
        t("agent.genericSuggest3"),
      ];

  const historyQueryText = historyQuery.trim().toLowerCase();
  const historyFiltered = historyQueryText
    ? historySessions.filter(
        (session) =>
          session.title.toLowerCase().includes(historyQueryText) ||
          session.sessionId.startsWith(historyQueryText),
      )
    : historySessions;

  return (
    <>
      <aside
        className="ask-sidebar"
        ref={asideRef}
        aria-label={t("agent.title")}
      >
        <div className="ask-sidebar-inner">
          <div className="ask-head">
            <div className="ask-head-main">
              <div className="ask-avatar">AI</div>
              <div>
                <h2>{t("agent.title")}</h2>
                <p>
                  {company
                    ? t("agent.context", { name: company.name })
                    : lang === "zh"
                      ? "OpenCorpCheck · 公司知识库"
                      : "OpenCorpCheck · Company intelligence"}
                </p>
              </div>
            </div>
            <div className="ask-head-actions">
              <div className="ask-history" ref={historyRef}>
                <button
                  className="ask-icon"
                  type="button"
                  onClick={() => {
                    setHistoryQuery("");
                    setHistoryOpen((value) => !value);
                  }}
                  disabled={busy}
                  aria-label={t("agent.history")}
                  aria-haspopup="dialog"
                  aria-expanded={historyOpen}
                  title={t("agent.history")}
                >
                  <svg
                    width="17"
                    height="17"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v5l3 2" />
                  </svg>
                </button>
                {historyOpen ? (
                  <div
                    className="ask-history-menu"
                    role="dialog"
                    aria-label={t("agent.history")}
                  >
                    <input
                      className="ask-history-search"
                      type="search"
                      value={historyQuery}
                      onChange={(event) => setHistoryQuery(event.target.value)}
                      placeholder={t("agent.historySearch")}
                      aria-label={t("agent.historySearch")}
                      autoFocus
                    />
                    <div className="ask-history-list">
                      {historyLoading ? (
                        <p className="ask-history-empty">
                          {t("agent.historyLoading")}
                        </p>
                      ) : historyFailed ? (
                        <p className="ask-history-empty">
                          {t("agent.historyFailed")}
                        </p>
                      ) : historyFiltered.length === 0 ? (
                        <p className="ask-history-empty">
                          {t("agent.historyEmpty")}
                        </p>
                      ) : (
                        historyFiltered.map((session) => (
                          <button
                            key={session.sessionId}
                            className={`ask-history-item${
                              session.sessionId === sessionRef.current
                                ? " active"
                                : ""
                            }`}
                            type="button"
                            onClick={() => void openSession(session.sessionId)}
                          >
                            <span className="ask-history-title">
                              {session.title || t("agent.historyUntitled")}
                            </span>
                            <span className="ask-history-meta">
                              {formatSessionAge(
                                session.updatedAt,
                                Date.now(),
                                lang,
                              )}
                              {session.turns > 1
                                ? ` · ${t("agent.historyTurns", {
                                    count: session.turns,
                                  })}`
                                : ""}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
              <button
                className="ask-new"
                type="button"
                onClick={newChat}
                disabled={busy}
                aria-label={t("agent.newChat")}
                title={t("agent.newChat")}
              >
                {t("agent.newChat")}
              </button>
              <button
                className="ask-close"
                type="button"
                onClick={closeAgent}
                aria-label={lang === "zh" ? "收起助手" : "Collapse assistant"}
                title={lang === "zh" ? "收起助手" : "Collapse assistant"}
              >
                ›
              </button>
            </div>
          </div>

          <div className="ask-body" ref={bodyRef}>
            {messages.length === 0 ? (
              <div className="msg assistant">
                <div className="bubble">{t("agent.greeting")}</div>
              </div>
            ) : null}

            {messages.map((message) => {
              if (message.role === "system") {
                // The resume fallback is a real loss of context, not chatter:
                // render it in a highlighted warning box.
                const highlighted =
                  message.noticeCode === "agent.resume.failed";
                return (
                  <div
                    className={`msg system${highlighted ? " notice-warn" : ""}`}
                    key={message.id}
                    role={highlighted ? "status" : undefined}
                  >
                    <div className="bubble">{message.text}</div>
                  </div>
                );
              }
              const urls =
                message.role === "assistant"
                  ? uniqueUrls(message.text)
                  : [];
              const hasTrace =
                message.role === "assistant" &&
                (message.tools.length > 0 || message.plan.length > 0);
              return (
                <div className={`msg ${message.role}`} key={message.id}>
                  <div className="bubble">
                    {/* One trajectory card: live while researching, static
                        once the answer streams. It never moves or duplicates. */}
                    {hasTrace ? (
                      <AgentTrajectory
                        calls={message.tools}
                        answer={message.text}
                        plan={message.plan}
                        startedAt={message.startedAt}
                        elapsedMs={
                          message.status === "streaming"
                            ? undefined
                            : message.elapsedMs
                        }
                        streaming={message.status === "streaming"}
                        usage={message.usage}
                      />
                    ) : null}
                    {message.text ? (
                      message.role === "assistant" ? (
                        <Suspense
                          fallback={
                            <div className="md md-fallback">
                              {message.text}
                            </div>
                          }
                        >
                          <MarkdownMessage text={message.text} />
                        </Suspense>
                      ) : (
                        <Linkified text={message.text} />
                      )
                    ) : !hasTrace && message.status === "streaming" ? (
                      <span className="agent-status">
                        <span className="spinner" />
                        {t("agent.thinking")}
                      </span>
                    ) : null}
                    {message.role === "assistant" && urls.length > 0 ? (
                      <div className="cite-row">
                        {urls.slice(0, 6).map((url, index) => (
                          <a
                            className="cite"
                            key={url}
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {lang === "zh" ? "来源" : "Source"} {index + 1}
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}

            {error ? (
              <div className="msg system">
                <div className="bubble agent-status error">{error}</div>
              </div>
            ) : null}
          </div>

          <div className="ask-suggestions">
            {suggestions.map((suggestion) => (
              <button
                className="suggestion"
                key={suggestion}
                type="button"
                onClick={() => void send(suggestion)}
                disabled={busy}
              >
                {suggestion}
              </button>
            ))}
          </div>

          <form className="ask-composer" onSubmit={submit}>
            <input
              id="agent-input"
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={t("agent.placeholder")}
              aria-label={t("agent.placeholder")}
              autoComplete="off"
              disabled={busy}
            />
            {busy ? (
              <button className="btn secondary" type="button" onClick={stop}>
                {t("agent.stop")}
              </button>
            ) : (
              <button className="btn" type="submit" disabled={!input.trim()}>
                {t("agent.send")}
              </button>
            )}
          </form>
        </div>
      </aside>
    </>
  );
}

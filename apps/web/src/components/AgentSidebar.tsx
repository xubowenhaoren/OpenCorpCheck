import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import {
  cancelAgentSession,
  createAgentSession,
  streamAgentPrompt,
  type AgentStreamEvent,
} from "../api";
import { useAgent } from "../contexts/AgentContext";
import { useLang } from "../i18n";

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  status: "streaming" | "done" | "error";
  tools?: number;
}

function uniqueUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s)\]}>"']+/g) ?? [];
  return [...new Set(matches.map((url) => url.replace(/[.,;:!?]+$/, "")))];
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

export function AgentSidebar() {
  const { open, company, initialQuestion, closeAgent, consumeInitialQuestion } =
    useAgent();
  const { t, lang } = useLang();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);
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
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setInput("");

    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    let tools = 0;

    setMessages((previous) => [
      ...previous,
      { id: userId, role: "user", text: question, status: "done" },
      { id: assistantId, role: "assistant", text: "", status: "streaming" },
    ]);

    try {
      let sessionId = sessionRef.current;
      if (!sessionId) {
        const session = await createAgentSession();
        sessionId = session.sessionId;
        sessionRef.current = sessionId;
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
          if (
            event.type === "assistant.delta" &&
            typeof event.text === "string"
          ) {
            const delta = event.text;
            setMessages((previous) =>
              previous.map((message) =>
                message.id === assistantId
                  ? { ...message, text: message.text + delta }
                  : message,
              ),
            );
            return;
          }
          if (event.type === "tool.called") {
            tools += 1;
            setMessages((previous) =>
              previous.map((message) =>
                message.id === assistantId ? { ...message, tools } : message,
              ),
            );
            return;
          }
          if (event.type === "notice") {
            const title =
              typeof event.title === "string" ? event.title : "";
            const description =
              typeof event.description === "string" ? event.description : "";
            if (title || description) {
              setMessages((previous) => [
                ...previous,
                {
                  id: crypto.randomUUID(),
                  role: "system",
                  text: [title, description].filter(Boolean).join(" · "),
                  status: "done",
                },
              ]);
            }
            return;
          }
          if (event.type === "run.failed") {
            const message =
              typeof event.error === "string"
                ? event.error
                : t("agent.error");
            setMessages((previous) =>
              previous.map((item) =>
                item.id === assistantId
                  ? {
                      ...item,
                      text: item.text || message,
                      status: "error",
                    }
                  : item,
              ),
            );
            return;
          }
          if (event.type === "run.completed") {
            setMessages((previous) =>
              previous.map((item) =>
                item.id === assistantId && item.status === "streaming"
                  ? { ...item, status: "done" }
                  : item,
              ),
            );
          }
        },
        controller.signal,
      );

      setMessages((previous) =>
        previous.map((item) =>
          item.id === assistantId && item.status === "streaming"
            ? { ...item, status: "done" }
            : item,
        ),
      );
    } catch (caught) {
      const aborted =
        caught instanceof DOMException && caught.name === "AbortError";
      if (aborted) {
        setMessages((previous) =>
          previous.map((item) =>
            item.id === assistantId && item.status === "streaming"
              ? { ...item, status: "done" }
              : item,
          ),
        );
      } else {
        const message =
          caught instanceof Error ? caught.message : String(caught);
        setError(message);
        setMessages((previous) =>
          previous.map((item) =>
            item.id === assistantId
              ? {
                  ...item,
                  text: item.text || t("agent.error"),
                  status: "error",
                }
              : item,
          ),
        );
      }
    } finally {
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

          <div className="ask-body" ref={bodyRef}>
            {messages.length === 0 ? (
              <div className="msg assistant">
                <div className="bubble">{t("agent.greeting")}</div>
              </div>
            ) : null}

            {messages.map((message) => {
              if (message.role === "system") {
                return (
                  <div className="msg system" key={message.id}>
                    <div className="bubble">{message.text}</div>
                  </div>
                );
              }
              const urls =
                message.role === "assistant"
                  ? uniqueUrls(message.text)
                  : [];
              return (
                <div className={`msg ${message.role}`} key={message.id}>
                  <div className="bubble">
                    {message.text ? (
                      <Linkified text={message.text} />
                    ) : message.status === "streaming" ? (
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
                    {message.role === "assistant" &&
                    message.status !== "streaming" &&
                    (message.tools ?? 0) > 0 ? (
                      <div className="msg-meta">
                        {t("agent.footer", {
                          tools: message.tools ?? 0,
                          sources: urls.length,
                        })}
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

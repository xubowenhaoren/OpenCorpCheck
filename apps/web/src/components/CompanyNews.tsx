import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { CompanyProfileView, NewsEventView } from "@occ/core";

import { getNewsStatus } from "../api";
import { useAgent } from "../contexts/AgentContext";
import { useSource } from "../contexts/SourceContext";
import { formatDate } from "../format";
import { useLang } from "../i18n";
import { relativePast } from "../lib/news-dock";
import { EmptyState } from "./States";

export function CompanyNews({
  events,
  company,
}: {
  events: NewsEventView[];
  company: CompanyProfileView;
}) {
  const { t, lang } = useLang();
  const { openSource } = useSource();
  const { openAgent } = useAgent();
  const queryClient = useQueryClient();
  const lastUpdateRef = useRef<string | null | undefined>(undefined);

  // The News tab never triggers a fetch itself; it observes the automatic
  // sweep. Polling this endpoint also lets the API start a due sweep lazily.
  const statusQuery = useQuery({
    queryKey: ["news-status", company.slug],
    queryFn: () => getNewsStatus(company.slug),
    staleTime: 0,
    refetchInterval: (query) => {
      const jobStatus = query.state.data?.data.company?.run?.jobStatus;
      return jobStatus === "active" || jobStatus === "queued" ? 5_000 : 60_000;
    },
  });
  const companyStatus = statusQuery.data?.data.company;
  const run = companyStatus?.run;
  const updating =
    run &&
    (run.runStatus === "queued" || run.runStatus === "running") &&
    (run.jobStatus === "active" || run.jobStatus === "queued");
  const queued = updating && run?.jobStatus === "queued";
  const lastUpdateAt = companyStatus?.lastUpdateAt ?? null;

  // When the cursor advances, the company card (which holds the news events)
  // is stale. Refetch it once instead of asking the reader to reload.
  useEffect(() => {
    if (lastUpdateRef.current === undefined) {
      lastUpdateRef.current = lastUpdateAt;
      return;
    }
    if (lastUpdateAt && lastUpdateAt !== lastUpdateRef.current) {
      lastUpdateRef.current = lastUpdateAt;
      void queryClient.invalidateQueries({ queryKey: ["company"] });
    }
  }, [lastUpdateAt, queryClient]);

  const statusLine = updating
    ? queued
      ? t("news.queued")
      : t("news.updating")
    : lastUpdateAt
      ? t("news.updated", { time: relativePast(lastUpdateAt, lang) })
      : companyStatus
        ? t("news.never")
        : null;

  if (events.length === 0) {
    return (
      <EmptyState
        title={t("news.empty")}
        hint={statusLine ?? t("news.emptyHint")}
      >
        <button
          type="button"
          className="btn secondary"
          onClick={() =>
            openAgent(
              {
                ref: company.slug,
                name: company.displayName,
                ticker: company.tickers[0]?.ticker,
              },
              lang === "zh"
                ? `查一下 ${company.displayName} 最近的新闻`
                : `Find the latest news about ${company.displayName}`,
            )
          }
        >
          {t("graph.askAgent")}
        </button>
      </EmptyState>
    );
  }

  return (
    <section className="card block">
      <div className="block-head">
        <h2>{t("news.title")}</h2>
        <span className="hint">
          {events.length} {lang === "zh" ? "条" : "items"}
        </span>
      </div>
      {statusLine ? <p className="news-status">{statusLine}</p> : null}
      <div className="news-list">
        {events.map((event) => (
          <div className="news-item" key={event.id}>
            <span className="date">{formatDate(event.date, lang)}</span>
            <div>
              <div className="news-title">{event.title}</div>
              <div className="news-sub">
                {event.kind === "news"
                  ? lang === "zh"
                    ? "新闻"
                    : "News"
                  : lang === "zh"
                    ? "公司大事"
                    : "Company event"}
                {event.source?.title ? ` · ${event.source.title}` : ""}
              </div>
            </div>
            {event.source?.url ? (
              <button
                type="button"
                className="src-btn"
                onClick={() =>
                  openSource({
                    url: event.source!.url,
                    title: event.source!.title,
                    trustTier: event.source!.trustTier,
                    quote: event.quote ?? event.summary,
                    date: event.date,
                  })
                }
              >
                {t("news.source")}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

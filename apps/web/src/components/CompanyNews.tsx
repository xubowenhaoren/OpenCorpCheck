import type { CompanyProfileView, NewsEventView } from "@occ/core";

import { useAgent } from "../contexts/AgentContext";
import { useSource } from "../contexts/SourceContext";
import { formatDate } from "../format";
import { useLang } from "../i18n";
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

  if (events.length === 0) {
    return (
      <EmptyState title={t("news.empty")} hint={t("news.emptyHint")}>
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

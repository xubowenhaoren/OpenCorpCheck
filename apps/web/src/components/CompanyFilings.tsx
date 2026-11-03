import type {
  CompanyProfileView,
  FilingRefreshView,
  NewsEventView,
} from "@occ/core";

import { useSource } from "../contexts/SourceContext";
import { formatDate } from "../format";
import { useLang } from "../i18n";
import { filingStatus } from "../lib/filing-status";
import { EmptyState } from "./States";

/**
 * Official filing/announcement list (P1.4) plus the P1.5 daily refresh line.
 * Kept separate from the News tab so a busy news day cannot hide the company's
 * filings.
 */
export function CompanyFilings({
  filings,
  company,
  refresh,
}: {
  filings: NewsEventView[];
  company: CompanyProfileView;
  refresh?: FilingRefreshView;
}) {
  const { t, lang } = useLang();
  const { openSource } = useSource();
  const status = filingStatus(refresh, lang, t);

  if (filings.length === 0) {
    return (
      <EmptyState
        title={lang === "zh" ? "暂无公告" : "No filings yet"}
        hint={
          status?.text ??
          (lang === "zh"
            ? "官方公告由系统每日检查交易所披露页，发现后会自动出现在这里。"
            : "Official filings are checked daily; new items appear here automatically.")
        }
      >
        {refresh?.latest ? (
          <a
            className="btn secondary"
            href={refresh.latest.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("news.source")}
          </a>
        ) : null}
      </EmptyState>
    );
  }

  return (
    <section className="card block">
      <div className="block-head">
        <h2>{lang === "zh" ? "公告文件" : "Filings"}</h2>
        <span className="hint">
          {filings.length} {lang === "zh" ? "条" : "items"}
        </span>
      </div>
      {status?.text ? (
        <p className={`news-status${status.warn ? " warn" : ""}`}>
          {status.text}
        </p>
      ) : null}
      <p className="news-status">
        {lang === "zh"
          ? `${company.displayName} 的官方披露文件；每条都可以打开原始 PDF 或披露页。`
          : `Official disclosure documents for ${company.displayName}; every row opens the original PDF or filing page.`}
      </p>
      <div className="news-list">
        {filings.map((filing) => (
          <div className="news-item" key={filing.id}>
            <span className="date">{formatDate(filing.date, lang)}</span>
            <div>
              <div className="news-title">{filing.title}</div>
              <div className="news-sub">
                {[filing.summary, sourceLabel(filing)]
                  .filter(Boolean)
                  .join(" · ") ||
                  (lang === "zh" ? "官方公告" : "Official filing")}
              </div>
            </div>
            {filing.source?.url ? (
              <button
                type="button"
                className="src-btn"
                onClick={() =>
                  openSource({
                    url: filing.source!.url,
                    title: filing.source!.title,
                    trustTier: filing.source!.trustTier,
                    quote: filing.summary ?? filing.title,
                    date: filing.date,
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

/** The source row title is the announcement title; avoid repeating it. */
function sourceLabel(filing: NewsEventView): string | undefined {
  const title = filing.source?.title?.trim();
  if (!title || title === filing.title) return undefined;
  return title;
}

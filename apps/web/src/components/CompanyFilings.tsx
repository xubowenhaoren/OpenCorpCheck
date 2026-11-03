import type { CompanyProfileView, NewsEventView } from "@occ/core";

import { useSource } from "../contexts/SourceContext";
import { formatDate } from "../format";
import { useLang } from "../i18n";
import { EmptyState } from "./States";

/**
 * Official filing/announcement list (P1.4). Kept separate from the News tab so
 * a busy news day cannot hide the company's filings.
 */
export function CompanyFilings({
  filings,
  company,
}: {
  filings: NewsEventView[];
  company: CompanyProfileView;
}) {
  const { t, lang } = useLang();
  const { openSource } = useSource();

  if (filings.length === 0) {
    return (
      <EmptyState
        title={lang === "zh" ? "暂无公告" : "No filings yet"}
        hint={
          lang === "zh"
            ? "官方公告由运营侧从交易所披露页同步，补充后会自动出现在这里。"
            : "Official filings are synced from exchange disclosure pages; new items appear here automatically."
        }
      />
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

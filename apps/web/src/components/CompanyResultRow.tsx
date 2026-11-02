import { Link } from "react-router-dom";
import type { CompanyHit } from "@occ/core";

import { useLang } from "../i18n";
import { Highlight } from "../lib/Highlight";

export function CompanyResultRow({
  hit,
  query,
}: {
  hit: CompanyHit;
  query?: string;
}) {
  const { t, lang } = useLang();
  const ticker = hit.tickers[0];
  const indices = [...new Set(hit.indices)];
  const base = `/c/${encodeURIComponent(hit.slug)}`;

  return (
    <article className="result-row">
      <div className="result-top">
        <div style={{ minWidth: 0 }}>
          <h2 className="result-name">
            <Link to={base}>
              <Highlight text={hit.displayName} query={query} />
            </Link>
            {hit.coverageTier === "stub" ? (
              <span className="tag stub-badge">{t("company.stubBadge")}</span>
            ) : null}
          </h2>
          {hit.legalName && hit.legalName !== hit.displayName ? (
            <p className="result-legal">{hit.legalName}</p>
          ) : null}
          <div className="result-meta">
            {ticker ? (
              <span className="result-ticker">
                {ticker.ticker} · {ticker.exchange}
              </span>
            ) : null}
            {hit.sector ? <span>{hit.sector}</span> : null}
            {hit.country ? <span>{hit.country}</span> : null}
            {indices.map((index) => (
              <span className="tag" key={index}>
                {index}
              </span>
            ))}
          </div>
        </div>
        <div className="result-actions">
          <Link className="btn secondary small" to={base}>
            {lang === "zh" ? "资料" : "Profile"}
          </Link>
          {hit.coverageTier === "stub" ? null : (
            <Link className="btn secondary small" to={`${base}/graph`}>
              {t("tabs.graph")}
            </Link>
          )}
        </div>
      </div>
      {hit.description ? (
        <p className="result-desc">
          <Highlight text={hit.description} query={query} />
        </p>
      ) : null}
    </article>
  );
}

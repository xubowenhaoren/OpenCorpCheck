import { useEffect, useState } from "react";
import type {
  CompanyFactView,
  CompanyProfileView,
  NewsEventView,
} from "@occ/core";

import { useAgent } from "../contexts/AgentContext";
import { factText, formatDate, truncate } from "../format";
import { useLang } from "../i18n";
import { isFollowed, toggleFollow } from "../lib/follow";

function factValue(
  facts: CompanyFactView[],
  predicate: string,
): string | undefined {
  const fact = facts.find((entry) => entry.predicate === predicate);
  const text = fact ? factText(fact.value) : "";
  return text || undefined;
}

export function CompanyHeader({
  company,
  facts,
  events,
}: {
  company: CompanyProfileView;
  facts: CompanyFactView[];
  events: NewsEventView[];
}) {
  const { t, lang } = useLang();
  const { openAgent } = useAgent();
  const [followed, setFollowed] = useState(() => isFollowed(company.slug));

  useEffect(() => {
    setFollowed(isFollowed(company.slug));
  }, [company.slug]);

  const ticker = company.tickers[0];
  const indices = [...new Set(company.indices)];
  const founded = factValue(facts, "founded");
  const employees = factValue(facts, "employees");
  const marketCap = factValue(facts, "market_cap");
  const foundedShort =
    founded?.match(/(?:19|20)\d{2}/)?.[0] ??
    (founded ? truncate(founded, 24) : "");
  const employeesShort = employees?.split(/[（(]/)[0].trim() ?? "";
  const marketCapShort = marketCap?.split(/[（(]/)[0].trim() ?? "";
  const updatedCandidates = [
    ...facts.map((fact) => fact.observedAt ?? ""),
    ...events.map((event) => event.date ?? ""),
  ].filter(Boolean);
  const updated = updatedCandidates.sort().at(-1);

  return (
    <section className="company-head">
      <div className="company-title-row">
        <div>
          <h1>{company.displayName}</h1>
          {company.legalName && company.legalName !== company.displayName ? (
            <p className="legal">{company.legalName}</p>
          ) : null}
          <div className="meta-row">
            {ticker ? (
              <span className="ticker">
                {ticker.ticker} · {ticker.exchange}
              </span>
            ) : null}
            {company.country ? <span>{company.country}</span> : null}
            {company.sector ? <span>{company.sector}</span> : null}
            {company.website ? (
              <a href={company.website} target="_blank" rel="noopener noreferrer">
                {company.website.replace(/^https?:\/\//, "")}
              </a>
            ) : null}
          </div>
        </div>
        <div className="head-actions company-title-actions">
          <button
            className="btn secondary"
            type="button"
            onClick={() => setFollowed(toggleFollow(company.slug))}
          >
            {followed ? t("company.following") : t("company.follow")}
          </button>
          <button
            className="btn"
            type="button"
            onClick={() =>
              openAgent({
                ref: company.slug,
                name: company.displayName,
                ticker: ticker?.ticker,
              })
            }
          >
            {t("company.ask")}
          </button>
        </div>
      </div>

      <div className="meta-row secondary">
        {founded ? (
          <span title={founded}>
            {t("company.founded")} {foundedShort}
          </span>
        ) : null}
        {employees ? (
          <span title={employees}>
            {t("company.employees")} {employeesShort}
          </span>
        ) : null}
        {marketCap ? (
          <span title={marketCap}>
            {t("company.marketCap")} {marketCapShort}
          </span>
        ) : null}
        {updated ? (
          <span>
            {t("company.updated")} {formatDate(updated, lang)}
          </span>
        ) : null}
        {indices.map((index) => (
          <span className="tag" key={index}>
            {index}
          </span>
        ))}
      </div>
    </section>
  );
}

import { Link } from "react-router-dom";
import type { CompanyProfileView } from "@occ/core";

import { useLang } from "../i18n";

const MARKET_BY_EXCHANGE: Record<string, "A" | "HK" | "US"> = {
  SSE: "A",
  SZSE: "A",
  BSE: "A",
  HKEX: "HK",
  NASDAQ: "US",
  NYSE: "US",
  AMEX: "US",
  CBOE: "US",
};

const MARKET_LABEL_KEY: Record<"A" | "HK" | "US", string> = {
  A: "search.stockA",
  HK: "search.stockHK",
  US: "search.stockUS",
};

function formatWeight(weight: number): string {
  return `${weight.toFixed(weight >= 1 ? 2 : 3)}%`;
}

/**
 * Read-only placeholder for a searchable `coverage_tier='stub'` company.
 * It shows only the fields we actually have (names, ticker, market, index
 * membership) — no fake metrics, no tabs, and no research/agent CTA.
 */
export function CompanyStub({ company }: { company: CompanyProfileView }) {
  const { t } = useLang();
  const markets = [
    ...new Set(
      company.tickers
        .map((ticker) => MARKET_BY_EXCHANGE[ticker.exchange.toUpperCase()])
        .filter((market): market is "A" | "HK" | "US" => Boolean(market)),
    ),
  ];
  const memberships: Array<{ code: string; weight?: number }> =
    company.indexMemberships?.length
      ? company.indexMemberships
      : company.indices.map((code) => ({ code }));

  return (
    <div className="stub-page">
      <section className="company-head stub-head">
        <div className="company-title-row">
          <div>
            <h1>
              {company.displayName}
              <span className="tag stub-badge">{t("company.stubBadge")}</span>
            </h1>
            {company.legalName && company.legalName !== company.displayName ? (
              <p className="legal">{company.legalName}</p>
            ) : null}
            <div className="meta-row">
              {company.tickers.map((ticker) => (
                <span className="ticker" key={`${ticker.exchange}:${ticker.ticker}`}>
                  {ticker.ticker} · {ticker.exchange}
                </span>
              ))}
              {markets.map((market) => (
                <span key={market}>{t(MARKET_LABEL_KEY[market])}</span>
              ))}
              {company.country ? <span>{company.country}</span> : null}
            </div>
          </div>
        </div>
      </section>

      <section className="panel stub-panel">
        <h2>{t("company.stubTitle")}</h2>
        <p>{t("company.stubNote")}</p>
        <p className="muted stub-hint">{t("company.stubHint")}</p>
      </section>

      <section className="panel stub-panel">
        <h2>{t("company.stubBasic")}</h2>
        <dl className="stub-facts">
          <div>
            <dt>{t("company.legalName")}</dt>
            <dd>{company.legalName}</dd>
          </div>
          <div>
            <dt>{t("company.ticker")}</dt>
            <dd>
              {company.tickers.map((ticker) => (
                <span key={`${ticker.exchange}:${ticker.ticker}`}>
                  {ticker.ticker} · {ticker.exchange}
                </span>
              ))}
            </dd>
          </div>
          <div>
            <dt>{t("company.country")}</dt>
            <dd>{company.country ?? "—"}</dd>
          </div>
          <div>
            <dt>{t("company.stubIndex")}</dt>
            <dd className="stub-indices">
              {memberships.length > 0
                ? memberships.map((membership) => (
                    <Link
                      className="tag"
                      key={membership.code}
                      to={`/indices/${membership.code}`}
                    >
                      {membership.code}
                      {membership.weight !== undefined
                        ? ` · ${t("company.stubWeight")} ${formatWeight(membership.weight)}`
                        : ""}
                    </Link>
                  ))
                : "—"}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

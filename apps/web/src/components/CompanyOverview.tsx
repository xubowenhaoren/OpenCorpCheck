import { Link } from "react-router-dom";
import type {
  CompanyCard,
  CompanyFactView,
  FinancialFactView,
  RelationView,
} from "@occ/core";

import { useAgent } from "../contexts/AgentContext";
import { useSource } from "../contexts/SourceContext";
import {
  factText,
  factNumber,
  financialItemLabel,
  formatDate,
  formatFinancialValue,
  latestFact,
  relationTypeLabel,
  statusLabel,
  periodLabel,
} from "../format";
import { useLang } from "../i18n";

function factValue(facts: CompanyFactView[], predicate: string): string {
  const fact = facts.find((entry) => entry.predicate === predicate);
  return fact ? factText(fact.value) : "";
}

function sourceButton(
  fact: FinancialFactView | CompanyFactView | undefined,
  openSource: ReturnType<typeof useSource>["openSource"],
  label: string,
) {
  if (!fact?.source?.url) return null;
  return (
    <button
      type="button"
      className="src-btn"
      onClick={() =>
        openSource({
          url: fact.source!.url,
          title: fact.source!.title,
          trustTier: fact.source!.trustTier,
          quote: fact.quote,
          date:
            "observedAt" in fact
              ? fact.observedAt
              : "periodEnd" in fact
                ? fact.periodEnd
                : undefined,
        })
      }
    >
      {label}
    </button>
  );
}

function relationStatusClass(status: string): string {
  if (status === "verified") return "ok";
  if (status === "reported") return "info";
  return "warn";
}

export function CompanyOverview({ card }: { card: CompanyCard }) {
  const { t, lang } = useLang();
  const { openAgent } = useAgent();
  const { openSource } = useSource();
  const { company } = card;
  const facts = card.facts ?? [];
  const financials = card.financials ?? [];
  const relations = [
    ...(card.relations?.incoming ?? []),
    ...(card.relations?.outgoing ?? []),
  ];
  const events = card.events ?? [];

  const revenue = latestFact(financials, "revenue", "annual");
  const netIncome =
    latestFact(financials, "net_income", "annual") ??
    latestFact(financials, "net_income_attributable", "annual");
  const netIncomeItem = financials.some(
    (fact) => fact.item === "net_income" && fact.periodKind === "annual",
  )
    ? "net_income"
    : "net_income_attributable";
  const grossMargin = latestFact(financials, "gross_margin", "annual");
  const employees = facts.find((fact) => fact.predicate === "employees");

  const keyNumbers = [
    {
      label: financialItemLabel("revenue", lang),
      value: revenue ? formatFinancialValue(revenue, lang) : t("company.noData"),
      period: revenue ? periodLabel(revenue) : "",
      fact: revenue,
    },
    {
      label: financialItemLabel(netIncomeItem, lang),
      value: netIncome
        ? formatFinancialValue(netIncome, lang)
        : t("company.noData"),
      period: netIncome ? periodLabel(netIncome) : "",
      fact: netIncome,
    },
    {
      label: financialItemLabel("gross_margin", lang),
      value: grossMargin
        ? formatFinancialValue(grossMargin, lang)
        : t("company.noData"),
      period: grossMargin ? periodLabel(grossMargin) : "",
      fact: grossMargin,
    },
    {
      label: t("company.employees"),
      value: employees ? factText(employees.value) : t("company.noData"),
      period: employees?.observedAt
        ? formatDate(employees.observedAt, lang)
        : "",
      fact: employees,
    },
  ];

  const infoRows = [
    { label: t("company.legalName"), value: company.legalName },
    {
      label: t("company.ticker"),
      value: company.tickers
        .map((ticker) => `${ticker.ticker} · ${ticker.exchange}`)
        .join(" / "),
    },
    { label: t("company.listing"), value: factValue(facts, "listing") },
    { label: t("company.country"), value: company.country ?? "" },
    { label: t("company.sector"), value: company.sector ?? "" },
    { label: t("company.founded"), value: factValue(facts, "founded") },
    { label: t("company.employees"), value: factValue(facts, "employees") },
    {
      label: t("company.fiscalYearEnd"),
      value: factValue(facts, "fiscal_year_end"),
    },
    {
      label: t("company.marketCap"),
      value: factValue(facts, "market_cap"),
    },
    { label: t("company.website"), value: company.website ?? "" },
  ].filter((row) => row.value);

  const segments = facts
    .filter((fact) => fact.predicate === "revenue_segment")
    .map((fact) => {
      const value = (fact.value ?? {}) as Record<string, unknown>;
      return {
        fact,
        name: typeof value.segment === "string" ? value.segment : "",
        share: factNumber(value, "share"),
        revenue: factNumber(value, "revenue"),
        currency: typeof value.currency === "string" ? value.currency : undefined,
        period: typeof value.period === "string" ? value.period : undefined,
      };
    })
    .filter((segment) => segment.name)
    .sort((a, b) => (b.share ?? 0) - (a.share ?? 0))
    .slice(0, 6);

  const investmentTypes = new Set(["invests_in", "owns", "parent_of"]);
  const shareholders = (card.relations?.incoming ?? []).filter((relation) =>
    investmentTypes.has(relation.type),
  );
  const outbound = (card.relations?.outgoing ?? []).filter((relation) =>
    investmentTypes.has(relation.type),
  );
  const supply = relations.filter(
    (relation) => relation.type === "supplies" || relation.type === "buys_from",
  );
  const competition = relations.filter(
    (relation) => relation.type === "competes_with",
  );
  const partnership = relations.filter((relation) =>
    ["partners_with", "joint_venture_with", "licenses_to", "licenses_from"].includes(
      relation.type,
    ),
  );

  const graphHref = `/c/${encodeURIComponent(company.slug)}/graph`;

  function openRelationSource(relation: RelationView) {
    const evidence = relation.evidence[0];
    if (!evidence?.url) return;
    openSource({
      url: evidence.url,
      title: evidence.title,
      quote: evidence.quote,
      trustTier: evidence.trustTier,
      date: evidence.publishedAt,
    });
  }

  return (
    <div className="layout-main-aside">
      <div className="stack">
        <section className="card block">
          <h2>{t("company.oneLine")}</h2>
          <p className="company-summary">
            {company.description ?? t("company.noData")}
          </p>
        </section>

        <section className="card block">
          <h2>{t("company.business")}</h2>
          {segments.length > 0 ? (
            <div className="segment-list">
              {segments.map((segment) => (
                <div className="segment-row" key={segment.fact.id}>
                  <span className="segment-name">{segment.name}</span>
                  <span className="segment-bar">
                    <span
                      style={{
                        width: `${Math.max(
                          0,
                          Math.min(100, segment.share ?? 0),
                        )}%`,
                      }}
                    />
                  </span>
                  <span className="segment-share">
                    {segment.share !== undefined
                      ? `${segment.share.toFixed(1)}%`
                      : "—"}
                  </span>
                  {sourceButton(segment.fact, openSource, t("graph.source"))}
                </div>
              ))}
            </div>
          ) : (
            <p className="company-grid-note">{t("company.noSegments")}</p>
          )}
        </section>

        <section className="card block">
          <h2>{t("company.basicInfo")}</h2>
          {infoRows.length > 0 ? (
            <table className="info-table">
              <tbody>
                {infoRows.map((row) => (
                  <tr key={row.label}>
                    <th>{row.label}</th>
                    <td>{row.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="company-grid-note">{t("company.noData")}</p>
          )}
        </section>

        <section className="card block">
          <div className="block-head">
            <h2>{t("company.recent")}</h2>
            {events.length > 3 ? (
              <Link
                className="link-button"
                to={`/c/${encodeURIComponent(company.slug)}/news`}
              >
                {t("company.viewAll")}
              </Link>
            ) : null}
          </div>
          {events.length > 0 ? (
            <div className="mini-timeline">
              {events.slice(0, 3).map((event) => (
                <div className="item" key={event.id}>
                  <span className="date">{formatDate(event.date, lang)}</span>
                  <span>{event.title}</span>
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
                      {t("graph.source")}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="company-grid-note">{t("company.noData")}</p>
          )}
        </section>
      </div>

      <aside className="stack">
        <section className="card block aside-section">
          <h3>{t("company.keyNumbers")}</h3>
          <div className="key-list">
            {keyNumbers.map((number) => (
              <div className="key-row" key={number.label}>
                <span className="label">{number.label}</span>
                <span className="value">
                  {number.value}
                  <span className="sub">
                    {number.period}
                    {number.period ? " · " : ""}
                    {sourceButton(number.fact, openSource, t("graph.source"))}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="card block aside-section">
          <h3>{t("company.shareholders")}</h3>
          {shareholders.length > 0 ? (
            <div className="aside-list">
              {shareholders.slice(0, 5).map((relation) => (
                <button
                  type="button"
                  className="row as-link"
                  key={relation.id}
                  onClick={() => openRelationSource(relation)}
                >
                  <span>{relation.src.displayName}</span>
                  <span className="value">
                    {relationTypeLabel(relation.type, lang)}
                    <span
                      className={`pill ${relationStatusClass(relation.status)}`}
                    >
                      {statusLabel(relation.status, lang)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <>
              <p className="company-grid-note">{t("company.noRelations")}</p>
              <button
                type="button"
                className="link-button"
                onClick={() =>
                  openAgent(
                    {
                      ref: company.slug,
                      name: company.displayName,
                      ticker: company.tickers[0]?.ticker,
                    },
                    lang === "zh"
                      ? `查一下 ${company.displayName} 的主要股东和投资方`
                      : `Find the major shareholders and investors of ${company.displayName}`,
                  )
                }
              >
                {t("graph.askAgent")}
              </button>
            </>
          )}
        </section>

        <section className="card block aside-section">
          <h3>{t("company.investments")}</h3>
          <p className="company-grid-note">
            {outbound.length > 0
              ? `${outbound.length} ${lang === "zh" ? "家" : "companies"}`
              : t("company.noRelations")}
          </p>
          <Link className="link-button" to={graphHref}>
            {t("company.viewGraph")}
          </Link>
        </section>

        <section className="card block aside-section">
          <h3>{t("company.related")}</h3>
          <div className="aside-list">
            <div className="row">
              <span>{t("graph.supply")}</span>
              <span className="value">{supply.length}</span>
            </div>
            <div className="row">
              <span>{t("graph.competition")}</span>
              <span className="value">{competition.length}</span>
            </div>
            <div className="row">
              <span>{t("graph.partnership")}</span>
              <span className="value">{partnership.length}</span>
            </div>
          </div>
          <Link className="link-button" to={graphHref}>
            {t("company.viewGraph")}
          </Link>
        </section>

        <section className="card block aside-section">
          <h3>{t("company.ask")}</h3>
          <p className="company-grid-note">
            {lang === "zh"
              ? "让 AI 助手总结业务、财务和关系，并给出处。"
              : "Ask the AI assistant to summarize the business, financials and relationships with sources."}
          </p>
          <button
            type="button"
            className="btn secondary"
            onClick={() =>
              openAgent({
                ref: company.slug,
                name: company.displayName,
                ticker: company.tickers[0]?.ticker,
              })
            }
          >
            {t("company.ask")}
          </button>
        </section>
      </aside>
    </div>
  );
}

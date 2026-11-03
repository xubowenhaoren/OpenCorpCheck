import { Link } from "react-router-dom";

import { useLang } from "../i18n";

export type CompanyTab =
  | "overview"
  | "financials"
  | "graph"
  | "news"
  | "filings"
  | "sources";

export function CompanyTabs({
  companyRef,
  active,
  counts,
}: {
  companyRef: string;
  active: CompanyTab;
  counts: {
    financials: number;
    relations: number;
    events: number;
    filings: number;
    sources: number;
  };
}) {
  const { t } = useLang();
  const base = `/c/${encodeURIComponent(companyRef)}`;
  const tabs: Array<{
    key: CompanyTab;
    label: string;
    to: string;
    count?: number;
  }> = [
    { key: "overview", label: t("tabs.overview"), to: base },
    {
      key: "financials",
      label: t("tabs.financials"),
      to: `${base}/financials`,
      count: counts.financials,
    },
    {
      key: "graph",
      label: t("tabs.graph"),
      to: `${base}/graph`,
      count: counts.relations,
    },
    {
      key: "news",
      label: t("tabs.news"),
      to: `${base}/news`,
      count: counts.events,
    },
    {
      key: "filings",
      label: t("tabs.filings"),
      to: `${base}/filings`,
      count: counts.filings,
    },
    {
      key: "sources",
      label: t("tabs.sources"),
      to: `${base}/sources`,
      count: counts.sources,
    },
  ];

  return (
    <nav className="tabs" role="tablist" aria-label="公司信息">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          to={tab.to}
          role="tab"
          aria-selected={active === tab.key}
          className={`tab${active === tab.key ? " active" : ""}`}
        >
          {tab.label}
          {tab.count && tab.count > 0 ? (
            <span className="count">{tab.count}</span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}

import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { getCompanyCard } from "../api";
import { CompanyGraph } from "../components/CompanyGraph";
import { SearchBox } from "../components/SearchBox";
import { ErrorView, Loading } from "../components/States";
import { useAgent } from "../contexts/AgentContext";
import { useLang } from "../i18n";

const SUGGESTED = ["AAPL", "NVDA", "MSFT", "600519", "00700"];

export function GraphPage() {
  const [params, setParams] = useSearchParams();
  const { t, lang } = useLang();
  const { openAgent } = useAgent();
  const company = params.get("company") ?? "";

  const companyQuery = useQuery({
    queryKey: ["company-lite", company],
    queryFn: () =>
      getCompanyCard(company, {
        include: "facts",
        financialLimit: 1,
        factLimit: 1,
        relationLimit: 1,
        eventLimit: 1,
      }),
    enabled: Boolean(company),
    staleTime: 60_000,
  });

  function chooseCompany(ref: string) {
    const next = new URLSearchParams(params);
    next.set("company", ref);
    setParams(next);
  }

  if (!company) {
    return (
      <div className="graph-page">
        <div className="graph-pick">
          <h1>{t("graphPage.pickTitle")}</h1>
          <p className="muted">{t("graphPage.pickHint")}</p>
          <div style={{ maxWidth: 560, margin: "24px auto 0" }}>
            <SearchBox
              onSelectCompany={(hit) => chooseCompany(hit.slug)}
              autoFocus
            />
          </div>
          <div className="hot-list" style={{ justifyContent: "center", marginTop: 22 }}>
            {SUGGESTED.map((ref) => (
              <Link
                className="hot-chip"
                key={ref}
                to={`/graph?company=${encodeURIComponent(ref)}`}
              >
                {ref}
              </Link>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (companyQuery.isLoading) return <Loading />;
  if (companyQuery.isError || !companyQuery.data) {
    return (
      <ErrorView
        message={
          companyQuery.error instanceof Error
            ? companyQuery.error.message
            : undefined
        }
        onRetry={() => void companyQuery.refetch()}
      />
    );
  }

  const card = companyQuery.data.data;
  return (
    <div className="graph-page">
      <div className="search-page-head">
        <div>
          <h1>{t("graph.title")}</h1>
          <span className="muted">
            {lang === "zh" ? "当前中心：" : "Center: "}
            {card.company.displayName}
          </span>
        </div>
        <button
          type="button"
          className="btn secondary"
          onClick={() =>
            openAgent({
              ref: card.company.slug,
              name: card.company.displayName,
              ticker: card.company.tickers[0]?.ticker,
            })
          }
        >
          {t("company.ask")}
        </button>
      </div>
      <div style={{ maxWidth: 560, margin: "12px 0 16px" }}>
        <SearchBox onSelectCompany={(hit) => chooseCompany(hit.slug)} />
      </div>
      <CompanyGraph
        companyRef={card.company.slug}
        companyName={card.company.displayName}
        companySlug={card.company.slug}
      />
    </div>
  );
}

import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { getSectors, searchCompanies } from "../api";
import { CompanyResultRow } from "../components/CompanyResultRow";
import { SearchBox } from "../components/SearchBox";
import { EmptyState, ErrorView, Loading } from "../components/States";
import { useAgent } from "../contexts/AgentContext";
import { useLang } from "../i18n";
import { filterRelevantCompanyHits } from "../lib/search";

const MARKETS = [
  { value: "", key: "search.all" },
  { value: "A", key: "search.stockA" },
  { value: "HK", key: "search.stockHK" },
  { value: "US", key: "search.stockUS" },
];

const INDICES = ["NDX", "A500", "HSI", "SPX"];

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const { t } = useLang();
  const { openAgent } = useAgent();
  const q = params.get("q") ?? "";
  const market = params.get("market") ?? "";
  const index = params.get("index") ?? "";
  const sector = params.get("sector") ?? "";

  const sectorsQuery = useQuery({
    queryKey: ["sectors"],
    queryFn: getSectors,
    staleTime: 5 * 60_000,
  });

  const searchQuery = useQuery({
    queryKey: ["search", q, market, index, sector],
    queryFn: () =>
      searchCompanies({
        q,
        market: market || undefined,
        index: index || undefined,
        sector: sector || undefined,
        limit: 20,
        explain: true,
      }),
    enabled: q.trim().length > 0,
    staleTime: 30_000,
  });

  function updateParam(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }

  const hits = filterRelevantCompanyHits(
    searchQuery.data?.data.hits ?? [],
    q,
  );

  if (!q.trim()) {
    return (
      <div className="search-page">
        <EmptyState title={t("search.title")} hint={t("search.placeholder")}>
          <div style={{ maxWidth: 560, margin: "0 auto" }}>
            <SearchBox variant="hero" autoFocus />
          </div>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="search-page">
      <div className="search-page-head">
        <h1>{t("search.title")}</h1>
        {searchQuery.data ? (
          <span className="muted">
            {t("search.found", { count: hits.length })}
          </span>
        ) : null}
      </div>

      <div className="search-filters">
        <div className="chips">
          {MARKETS.map((item) => (
            <button
              type="button"
              key={item.key}
              className={`chip${market === item.value ? " active" : ""}`}
              onClick={() => updateParam("market", item.value)}
            >
              {t(item.key)}
            </button>
          ))}
        </div>
        <div className="filter-group">
          <span>{t("search.index")}</span>
          <select
            className="filter-select"
            value={index}
            onChange={(event) => updateParam("index", event.target.value)}
          >
            <option value="">{t("search.all")}</option>
            {INDICES.map((code) => (
              <option value={code} key={code}>
                {code}
              </option>
            ))}
          </select>
        </div>
        <div className="filter-group">
          <span>{t("search.sector")}</span>
          <select
            className="filter-select"
            value={sector}
            onChange={(event) => updateParam("sector", event.target.value)}
          >
            <option value="">{t("search.all")}</option>
            {(sectorsQuery.data?.data.sectors ?? []).map((value) => (
              <option value={value} key={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
      </div>

      {searchQuery.isLoading ? <Loading /> : null}

      {searchQuery.isError ? (
        <ErrorView
          message={
            searchQuery.error instanceof Error
              ? searchQuery.error.message
              : undefined
          }
          onRetry={() => void searchQuery.refetch()}
        />
      ) : null}

      {!searchQuery.isLoading && !searchQuery.isError && hits.length === 0 ? (
        <EmptyState title={t("search.empty")} hint={t("search.emptyHint")}>
          <button
            type="button"
            className="btn secondary"
            onClick={() => openAgent(null, q)}
          >
            {t("search.ask")}
          </button>
        </EmptyState>
      ) : null}

      {hits.length > 0 ? (
        <div className="result-list">
          {hits.map((hit) => (
            <CompanyResultRow key={hit.id} hit={hit} query={q} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

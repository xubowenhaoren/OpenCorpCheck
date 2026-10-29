import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { ApiError, getIndex } from "../api";
import { EmptyState, ErrorView, Loading } from "../components/States";
import { formatDate } from "../format";
import { useLang } from "../i18n";

const INDEX_CODES = ["NDX", "A500", "HSI", "SPX"];

export function IndexPage() {
  const { code: rawCode } = useParams<{ code: string }>();
  const code = (rawCode ?? "NDX").toUpperCase();
  const { t, lang } = useLang();
  const [filter, setFilter] = useState("");
  const [sector, setSector] = useState("");

  const query = useQuery({
    queryKey: ["index", code],
    queryFn: () => getIndex(code),
    enabled: Boolean(code),
    staleTime: 5 * 60_000,
  });

  const members = query.data?.data.members ?? [];
  const sectors = useMemo(
    () =>
      [...new Set(members.map((member) => member.sector).filter(Boolean))]
        .sort() as string[],
    [members],
  );
  const visible = members.filter((member) => {
    if (sector && member.sector !== sector) return false;
    const needle = filter.trim().toLowerCase();
    if (!needle) return true;
    return (
      member.displayName.toLowerCase().includes(needle) ||
      member.legalName?.toLowerCase().includes(needle) ||
      member.tickers.some((ticker) =>
        ticker.ticker.toLowerCase().includes(needle),
      )
    );
  });

  if (query.isLoading) return <Loading />;

  const notFound =
    query.error instanceof ApiError && query.error.status === 404;
  if (notFound) {
    return (
      <div className="index-page">
        <div className="index-head">
          <div>
            <h1>{code}</h1>
            <p>{t("index.notLoaded")}</p>
          </div>
        </div>
        <div className="chips" style={{ marginTop: 16 }}>
          {INDEX_CODES.map((value) => (
            <Link
              className={`chip${value === code ? " active" : ""}`}
              key={value}
              to={`/indices/${value}`}
            >
              {value}
            </Link>
          ))}
        </div>
        <div style={{ marginTop: 20 }}>
          <EmptyState
            title={t("index.notLoaded")}
            hint={t("index.notLoadedHint")}
          >
            <Link className="btn secondary" to="/indices/NDX">
              NASDAQ-100
            </Link>
          </EmptyState>
        </div>
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <ErrorView
        message={query.error instanceof Error ? query.error.message : undefined}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const index = query.data.data;

  return (
    <div className="index-page">
      <div className="index-head">
        <div>
          <h1>{index.code}</h1>
          <p>
            {t("index.count")}：{index.members.length}
            {index.asOf ? ` · ${t("index.asOf")} ${formatDate(index.asOf, lang)}` : ""}
          </p>
        </div>
        <div className="chips">
          {INDEX_CODES.map((value) => (
            <Link
              className={`chip${value === index.code ? " active" : ""}`}
              key={value}
              to={`/indices/${value}`}
            >
              {value}
            </Link>
          ))}
        </div>
      </div>

      <div className="index-tools">
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t("index.filter")}
          aria-label={t("index.filter")}
        />
        <select
          className="filter-select"
          value={sector}
          onChange={(event) => setSector(event.target.value)}
        >
          <option value="">{t("search.all")}</option>
          {sectors.map((value) => (
            <option value={value} key={value}>
              {value}
            </option>
          ))}
        </select>
        <span className="muted" style={{ fontSize: 12 }}>
          {visible.length}
        </span>
      </div>

      <div className="table-wrap">
        <table className="index-table">
          <thead>
            <tr>
              <th>#</th>
              <th>{lang === "zh" ? "公司" : "Company"}</th>
              <th>{lang === "zh" ? "代码" : "Ticker"}</th>
              <th>{t("search.sector")}</th>
              <th>{lang === "zh" ? "国家" : "Country"}</th>
              <th>{lang === "zh" ? "指数" : "Indices"}</th>
              <th>{lang === "zh" ? "操作" : "Actions"}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((member, indexNumber) => {
              const ticker = member.tickers[0];
              const base = `/c/${encodeURIComponent(member.slug)}`;
              return (
                <tr key={member.id}>
                  <td className="muted">{indexNumber + 1}</td>
                  <td>
                    <Link to={base}>{member.displayName}</Link>
                    {member.legalName && member.legalName !== member.displayName ? (
                      <div className="source-meta">{member.legalName}</div>
                    ) : null}
                  </td>
                  <td>
                    {ticker ? `${ticker.ticker} · ${ticker.exchange}` : "—"}
                  </td>
                  <td>{member.sector ?? "—"}</td>
                  <td>{member.country ?? "—"}</td>
                  <td>{member.indices.join(" · ")}</td>
                  <td>
                    <Link className="link-button" to={base}>
                      {lang === "zh" ? "资料" : "Profile"}
                    </Link>
                    {" · "}
                    <Link className="link-button" to={`${base}/graph`}>
                      {t("tabs.graph")}
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {visible.length === 0 ? (
        <div style={{ marginTop: 16 }}>
          <EmptyState
            title={t("search.empty")}
            hint={t("search.emptyHint")}
          />
        </div>
      ) : null}
    </div>
  );
}

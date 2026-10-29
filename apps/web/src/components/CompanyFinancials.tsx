import { useMemo, useState } from "react";
import type {
  CompanyProfileView,
  FinancialFactView,
  PeriodKind,
} from "@occ/core";

import { useAgent } from "../contexts/AgentContext";
import { useSource } from "../contexts/SourceContext";
import {
  FIN_ITEM_ORDER,
  financialItemLabel,
  formatFinancialValue,
  latestFact,
  periodKey,
  periodLabel,
  statementLabel,
} from "../format";
import { useLang } from "../i18n";
import { EmptyState } from "./States";

const STATEMENT_ORDER = ["income", "cash_flow", "balance", "per_share"];
const METRIC_ITEMS = [
  "revenue",
  "net_income",
  "gross_margin",
  "operating_income",
  "operating_cash_flow",
  "free_cash_flow",
];

interface PeriodColumn {
  key: string;
  label: string;
  end: string;
  kind: PeriodKind;
}

function buildPeriods(facts: FinancialFactView[]): PeriodColumn[] {
  const map = new Map<string, PeriodColumn>();
  for (const fact of facts) {
    const key = periodKey(fact);
    if (map.has(key)) continue;
    map.set(key, {
      key,
      label: periodLabel(fact),
      end: fact.periodEnd,
      kind: fact.periodKind,
    });
  }
  return [...map.values()]
    .sort((a, b) => b.end.localeCompare(a.end))
    .slice(0, 5);
}

function buildRows(
  facts: FinancialFactView[],
  periods: PeriodColumn[],
): Array<{ item: string; statement: string; byPeriod: Map<string, FinancialFactView> }> {
  const byItem = new Map<
    string,
    { item: string; statement: string; byPeriod: Map<string, FinancialFactView> }
  >();
  for (const fact of facts) {
    let row = byItem.get(fact.item);
    if (!row) {
      row = { item: fact.item, statement: fact.statement, byPeriod: new Map() };
      byItem.set(fact.item, row);
    }
    const key = periodKey(fact);
    const existing = row.byPeriod.get(key);
    if (!existing || (fact.confidence ?? 0) > (existing.confidence ?? 0)) {
      row.byPeriod.set(key, fact);
    }
  }
  const rows = [...byItem.values()].filter((row) =>
    periods.some((period) => row.byPeriod.has(period.key)),
  );
  const order = new Map(FIN_ITEM_ORDER.map((item, index) => [item, index]));
  return rows.sort(
    (a, b) =>
      (order.get(a.item) ?? 999) - (order.get(b.item) ?? 999) ||
      a.item.localeCompare(b.item),
  );
}

export function CompanyFinancials({
  financials,
  company,
}: {
  financials: FinancialFactView[];
  company: CompanyProfileView;
}) {
  const { t, lang } = useLang();
  const { openSource } = useSource();
  const { openAgent } = useAgent();
  const hasAnnual = financials.some((fact) => fact.periodKind === "annual");
  const hasQuarter = financials.some((fact) => fact.periodKind === "quarter");
  const [mode, setMode] = useState<PeriodKind>(
    hasAnnual ? "annual" : "quarter",
  );

  const filtered = useMemo(
    () => financials.filter((fact) => fact.periodKind === mode),
    [financials, mode],
  );
  const periods = useMemo(() => buildPeriods(filtered), [filtered]);
  const rows = useMemo(() => buildRows(filtered, periods), [filtered, periods]);

  const metrics = METRIC_ITEMS.map((item) => {
    let fact =
      latestFact(financials, item, "annual") ??
      latestFact(financials, item, "quarter");
    let labelItem = item;
    if (!fact && item === "net_income") {
      fact =
        latestFact(financials, "net_income_attributable", "annual") ??
        latestFact(financials, "net_income_attributable", "quarter");
      labelItem = "net_income_attributable";
    }
    return { item: labelItem, fact };
  });

  function openFactSource(fact: FinancialFactView | undefined) {
    if (!fact?.source?.url) return;
    openSource({
      url: fact.source.url,
      title: fact.source.title,
      trustTier: fact.source.trustTier,
      quote: fact.quote,
      date: fact.periodEnd,
    });
  }

  if (financials.length === 0) {
    return (
      <EmptyState title={t("financial.noData")} hint={t("financial.noDataHint")}>
        <button
          type="button"
          className="btn secondary"
          onClick={() =>
            openAgent(
              {
                ref: company.slug,
                name: company.displayName,
                ticker: company.tickers[0]?.ticker,
              },
              lang === "zh"
                ? `查一下 ${company.displayName} 最新的营收、利润和现金流`
                : `Find the latest revenue, profit and cash flow for ${company.displayName}`,
            )
          }
        >
          {t("graph.askAgent")}
        </button>
      </EmptyState>
    );
  }

  return (
    <div className="stack">
      <div className="metric-strip">
        {metrics.map(({ item, fact }) => (
          <div className="metric" key={item}>
            <div className="label">{financialItemLabel(item, lang)}</div>
            <div className="value">
              {fact ? formatFinancialValue(fact, lang) : t("company.noData")}
            </div>
            <div className="sub">
              <span>{fact ? periodLabel(fact) : ""}</span>
              {fact?.source?.url ? (
                <button
                  type="button"
                  className="src-btn"
                  onClick={() => openFactSource(fact)}
                >
                  {t("graph.source")}
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      <section className="card block">
        <div className="block-head">
          <h2>{t("financial.title")}</h2>
          <div className="segmented" role="group" aria-label={t("financial.period")}>
            <button
              type="button"
              className={mode === "annual" ? "active" : ""}
              onClick={() => setMode("annual")}
              disabled={!hasAnnual && mode === "annual"}
            >
              {t("financial.annual")}
            </button>
            <button
              type="button"
              className={mode === "quarter" ? "active" : ""}
              onClick={() => setMode("quarter")}
              disabled={!hasQuarter && mode === "quarter"}
            >
              {t("financial.quarter")}
            </button>
          </div>
        </div>

        {periods.length > 0 && rows.length > 0 ? (
          <div className="table-wrap">
            <table className="fin-table">
              <thead>
                <tr>
                  <th>{t("financial.item")}</th>
                  {periods.map((period) => (
                    <th key={period.key}>{period.label}</th>
                  ))}
                  <th>{t("financial.source")}</th>
                </tr>
              </thead>
              <tbody>
                {STATEMENT_ORDER.filter((statement) =>
                  rows.some((row) => row.statement === statement),
                ).map((statement) => (
                  <StatementRows
                    key={statement}
                    statement={statement}
                    rows={rows.filter((row) => row.statement === statement)}
                    periods={periods}
                    lang={lang}
                    openFactSource={openFactSource}
                    sourceLabel={t("graph.source")}
                  />
                ))}
                {[...new Set(rows.map((row) => row.statement))]
                  .filter((statement) => !STATEMENT_ORDER.includes(statement))
                  .map((statement) => (
                    <StatementRows
                      key={statement}
                      statement={statement}
                      rows={rows.filter((row) => row.statement === statement)}
                      periods={periods}
                      lang={lang}
                      openFactSource={openFactSource}
                      sourceLabel={t("graph.source")}
                    />
                  ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title={t("financial.noData")}
            hint={t("financial.noDataHint")}
          />
        )}

        <p className="hint">{t("financial.unit")}</p>
      </section>
    </div>
  );
}

function StatementRows({
  statement,
  rows,
  periods,
  lang,
  openFactSource,
  sourceLabel,
}: {
  statement: string;
  rows: Array<{
    item: string;
    statement: string;
    byPeriod: Map<string, FinancialFactView>;
  }>;
  periods: PeriodColumn[];
  lang: "zh" | "en";
  openFactSource: (fact: FinancialFactView | undefined) => void;
  sourceLabel: string;
}) {
  const firstWithSource = rows
    .flatMap((row) => periods.map((period) => row.byPeriod.get(period.key)))
    .find((fact) => fact?.source?.url);
  return (
    <>
      <tr className="fin-section-row">
        <td colSpan={periods.length + 2}>{statementLabel(statement, lang)}</td>
      </tr>
      {rows.map((row) => (
        <tr key={`${statement}-${row.item}`}>
          <td>{financialItemLabel(row.item, lang)}</td>
          {periods.map((period) => {
            const fact = row.byPeriod.get(period.key);
            return (
              <td
                key={period.key}
                className={fact?.source?.url ? "sourceable" : ""}
                onClick={() => openFactSource(fact)}
                title={fact?.source?.url ? sourceLabel : undefined}
              >
                {fact ? formatFinancialValue(fact, lang) : "—"}
              </td>
            );
          })}
          <td className="src-cell">
            {firstWithSource?.source?.url ? (
              <button
                type="button"
                className="src-btn"
                onClick={() => openFactSource(firstWithSource)}
              >
                {sourceLabel}
              </button>
            ) : (
              <span className="muted">—</span>
            )}
          </td>
        </tr>
      ))}
    </>
  );
}

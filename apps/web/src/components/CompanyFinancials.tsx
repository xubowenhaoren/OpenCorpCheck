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
  financialSourceKind,
  financialSourceLabel,
  formatFinancialValue,
  isCumulativePeriod,
  isDerivedFact,
  latestFact,
  periodKey,
  periodLabel,
  statementLabel,
  type FinancialSourceKind,
} from "../format";
import { useLang } from "../i18n";
import { EmptyState } from "./States";

const STATEMENT_ORDER = ["income", "balance", "cash_flow", "per_share"];
const MODE_ORDER: PeriodKind[] = ["annual", "quarter", "half", "ttm"];
/** Below this many rows the stacked statement layout stays readable. */
const STATEMENT_TAB_THRESHOLD = 12;
const PERIOD_LIMIT: Record<PeriodKind, number> = {
  annual: 5,
  quarter: 6,
  half: 4,
  ttm: 1,
};

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
  badge?: { label: string; kind: FinancialSourceKind };
  cumulative: boolean;
}

function buildPeriods(
  facts: FinancialFactView[],
  lang: "zh" | "en",
  limit: number,
): PeriodColumn[] {
  const map = new Map<string, PeriodColumn>();
  const byPeriod = new Map<string, FinancialFactView[]>();
  for (const fact of facts) {
    const key = periodKey(fact);
    const list = byPeriod.get(key);
    if (list) {
      list.push(fact);
      continue;
    }
    byPeriod.set(key, [fact]);
    map.set(key, {
      key,
      label: periodLabel(fact),
      end: fact.periodEnd,
      kind: fact.periodKind,
      cumulative: isCumulativePeriod(fact),
    });
  }
  for (const [key, list] of byPeriod) {
    const column = map.get(key);
    if (!column) continue;
    const badge = dominantBadge(list, lang);
    if (badge) column.badge = badge;
    column.cumulative = list.some(isCumulativePeriod);
  }
  return [...map.values()]
    .sort((a, b) => b.end.localeCompare(a.end))
    .slice(0, limit);
}

/** The source most cells in one period column share. */
function dominantBadge(
  facts: FinancialFactView[],
  lang: "zh" | "en",
): PeriodColumn["badge"] {
  const counts = new Map<
    string,
    { label: string; kind: FinancialSourceKind; count: number }
  >();
  for (const fact of facts) {
    if (isDerivedFact(fact)) continue;
    const label = financialSourceLabel(fact, lang);
    const kind = financialSourceKind(fact);
    const entry = counts.get(label);
    if (entry) entry.count += 1;
    else counts.set(label, { label, kind, count: 1 });
  }
  const best = [...counts.values()].sort((a, b) => b.count - a.count)[0];
  return best ? { label: best.label, kind: best.kind } : undefined;
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
    // Keep reported values over derived ones for the same cell, then by
    // confidence (a filing beats a profile row).
    let row = byItem.get(fact.item);
    if (!row) {
      row = { item: fact.item, statement: fact.statement, byPeriod: new Map() };
      byItem.set(fact.item, row);
    }
    const key = periodKey(fact);
    const existing = row.byPeriod.get(key);
    if (!existing || cellRank(fact) > cellRank(existing)) {
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

function cellRank(fact: FinancialFactView): number {
  return (isDerivedFact(fact) ? 0 : 10) + (fact.confidence ?? 0);
}

interface Coverage {
  sources: string[];
  latest: string | undefined;
  derived: boolean;
  fiscalYearEnd: string | undefined;
}

function buildCoverage(
  facts: FinancialFactView[],
  lang: "zh" | "en",
  allFacts: FinancialFactView[],
): Coverage {
  const sorted = [...facts].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
  const latestByKind = new Map<FinancialSourceKind, FinancialFactView>();
  for (const fact of sorted) {
    if (isDerivedFact(fact)) continue;
    const kind = financialSourceKind(fact);
    if (!latestByKind.has(kind)) latestByKind.set(kind, fact);
  }
  const order: FinancialSourceKind[] = ["sec", "f10", "other", "profile"];
  const sources = [
    ...new Set(
      order
        .filter((kind) => latestByKind.has(kind))
        // A profile label is only worth showing when nothing structured exists.
        .filter((kind) => kind !== "profile" || latestByKind.size === 1)
        .map((kind) => financialSourceLabel(latestByKind.get(kind)!, lang)),
    ),
  ];
  const latest = sorted.find(
    (fact) => fact.source?.url && !isDerivedFact(fact),
  );
  const annual = [...allFacts]
    .filter((fact) => fact.periodKind === "annual" && fact.item === "revenue")
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
  return {
    sources,
    latest: latest?.periodEnd,
    derived: facts.some(isDerivedFact),
    fiscalYearEnd: annual ? annual.periodEnd.slice(5) : undefined,
  };
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

  const modes = useMemo(
    () => MODE_ORDER.filter((kind) => financials.some((fact) => fact.periodKind === kind)),
    [financials],
  );
  const [mode, setMode] = useState<PeriodKind>(modes[0] ?? "annual");
  const activeMode = modes.includes(mode) ? mode : (modes[0] ?? "annual");
  const [statement, setStatement] = useState<string | null>(null);

  const filtered = useMemo(
    () => financials.filter((fact) => fact.periodKind === activeMode),
    [financials, activeMode],
  );
  const periods = useMemo(
    () => buildPeriods(filtered, lang, PERIOD_LIMIT[activeMode] ?? 5),
    [filtered, lang, activeMode],
  );
  const rows = useMemo(() => buildRows(filtered, periods), [filtered, periods]);
  const coverage = useMemo(
    () => buildCoverage(filtered, lang, financials),
    [filtered, lang, financials],
  );

  const statements = useMemo(
    () =>
      STATEMENT_ORDER.filter((name) =>
        rows.some((row) => row.statement === name),
      ).concat(
        [...new Set(rows.map((row) => row.statement))].filter(
          (name) => !STATEMENT_ORDER.includes(name),
        ),
      ),
    [rows],
  );
  const useStatementTabs = rows.length > STATEMENT_TAB_THRESHOLD && statements.length > 1;
  const activeStatement =
    statement && statements.includes(statement) ? statement : statements[0];
  const visibleStatements = useStatementTabs
    ? statements.filter((name) => name === activeStatement)
    : statements;

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
            <div className="label">
              {financialItemLabel(item, lang)}
              {fact && isDerivedFact(fact) ? (
                <span className="fin-badge derived">
                  {t("financial.derived")}
                </span>
              ) : null}
            </div>
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
          {modes.length > 1 ? (
            <div className="segmented" role="group" aria-label={t("financial.period")}>
              {modes.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={activeMode === kind ? "active" : ""}
                  onClick={() => setMode(kind)}
                >
                  {periodModeLabel(kind, t)}
                </button>
              ))}
            </div>
          ) : (
            <span className="muted fin-mode-note">
              {periodModeLabel(activeMode, t)}
            </span>
          )}
        </div>

        <p className="fin-coverage">
          <span>
            {t("financial.coverage")}
            {lang === "zh" ? "：" : ": "}
          </span>
          {coverage.sources.length > 0 ? (
            coverage.sources.map((source) => (
              <span key={source} className="fin-badge">
                {source}
              </span>
            ))
          ) : (
            <span className="fin-badge">{t("financial.sourceProfile")}</span>
          )}
          {coverage.latest ? (
            <span>· {coverage.latest.slice(0, 10)}</span>
          ) : null}
          {coverage.fiscalYearEnd ? (
            <span>
              · {t("financial.fye")} {coverage.fiscalYearEnd}
            </span>
          ) : null}
          {coverage.derived ? (
            <span className="fin-badge derived">
              {t("financial.derivedNote")}
            </span>
          ) : null}
        </p>

        {useStatementTabs ? (
          <div
            className="segmented fin-statement-tabs"
            role="group"
            aria-label={t("financial.statement")}
          >
            {statements.map((name) => (
              <button
                key={name}
                type="button"
                className={activeStatement === name ? "active" : ""}
                onClick={() => setStatement(name)}
              >
                {statementLabel(name, lang)}
              </button>
            ))}
          </div>
        ) : null}

        {periods.length > 0 && rows.length > 0 ? (
          <div className="table-wrap">
            <table className="fin-table">
              <thead>
                <tr>
                  <th>{t("financial.item")}</th>
                  {periods.map((period) => (
                    <th key={period.key}>
                      <span className="fin-period">{period.label}</span>
                      {period.badge || period.cumulative ? (
                        <span className="fin-badges">
                          {period.badge ? (
                            <span className={`fin-badge ${period.badge.kind}`}>
                              {period.badge.label}
                            </span>
                          ) : null}
                          {period.cumulative ? (
                            <span className="fin-badge derived">
                              {t("financial.cumulative")}
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleStatements.map((name) => (
                  <StatementRows
                    key={name}
                    statement={name}
                    rows={rows.filter((row) => row.statement === name)}
                    periods={periods}
                    lang={lang}
                    openFactSource={openFactSource}
                    sourceLabel={t("graph.source")}
                    derivedLabel={t("financial.derived")}
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

function periodModeLabel(
  kind: PeriodKind,
  t: (key: string) => string,
): string {
  switch (kind) {
    case "annual":
      return t("financial.annual");
    case "quarter":
      return t("financial.quarter");
    case "half":
      return t("financial.half");
    default:
      return t("financial.ttm");
  }
}

function StatementRows({
  statement,
  rows,
  periods,
  lang,
  openFactSource,
  sourceLabel,
  derivedLabel,
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
  derivedLabel: string;
}) {
  return (
    <>
      <tr className="fin-section-row">
        <td colSpan={periods.length + 1}>{statementLabel(statement, lang)}</td>
      </tr>
      {rows.map((row) => (
        <tr key={`${statement}-${row.item}`}>
          <td>{financialItemLabel(row.item, lang)}</td>
          {periods.map((period) => {
            const fact = row.byPeriod.get(period.key);
            if (!fact) {
              return (
                <td key={period.key} className="fin-empty">
                  —
                </td>
              );
            }
            const derived = isDerivedFact(fact);
            const label = financialSourceLabel(fact, lang);
            const kind = financialSourceKind(fact);
            // The column header already names the filing; only flag a cell
            // whose source family differs (e.g. F10 interim inside a SEC
            // column) or that was calculated.
            const showBadge = derived || kind !== period.badge?.kind;
            return (
              <td
                key={period.key}
                className={fact.source?.url ? "sourceable" : ""}
                onClick={() => openFactSource(fact)}
                title={fact.source?.url ? sourceLabel : undefined}
              >
                <span className="fin-cell">
                  <span className="fin-value">
                    {formatFinancialValue(fact, lang)}
                  </span>
                  {showBadge ? (
                    <span
                      className={`fin-badge ${
                        derived ? "derived" : financialSourceKind(fact)
                      }`}
                    >
                      {derived ? derivedLabel : label}
                    </span>
                  ) : null}
                </span>
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}

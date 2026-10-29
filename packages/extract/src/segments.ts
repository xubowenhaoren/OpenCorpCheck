import { factId } from "@occ/db";
import type { Market } from "@occ/core";
import type { SectionChapter } from "@occ/ingest";

import { citationRefs, parseMarkdownTables, stripCitations } from "./markdown-table.js";
import { parseFiscalYearEnd, parsePeriodLabel } from "./periods.js";
import { parseNumericCell, parseUnitContext } from "./units.js";
import type { FactDraft } from "./snapshot.js";

/**
 * Section 3 often ends with a segment-revenue table
 * (`| FY2025 分部 | 收入（亿美元） | 占比 |`). Store each row as a fact.
 */
export function extractSegmentFacts(input: {
  companyId: string;
  chapter: SectionChapter;
  market: Market;
  dataCutoff?: string;
}): FactDraft[] {
  const table = parseMarkdownTables(input.chapter.text).find(
    (candidate) => candidate.headers.length === 3,
  );
  if (!table) return [];

  const lines = input.chapter.text.split("\n");
  const prior = lines
    .slice(0, Math.max(0, table.startLine - 1))
    .filter((line) => line.trim() && !line.trim().startsWith("|"))
    .slice(-2)
    .join(" ");
  const priorRefs = citationRefs(prior);
  const fye = parseFiscalYearEnd(input.chapter.text);
  const period =
    parsePeriodLabel(table.headers[0] ?? "", fye, input.dataCutoff) ??
    parsePeriodLabel(prior, fye, input.dataCutoff);
  const unitContext = parseUnitContext(
    input.chapter.section,
    `${table.headers.join(" ")}\n${input.chapter.text}`,
    input.market,
  );
  const observedAt = input.dataCutoff
    ? new Date(`${input.dataCutoff}T00:00:00Z`)
    : undefined;

  const drafts: FactDraft[] = [];
  for (const [index, row] of table.rows.entries()) {
    const segment = stripCitations(row[0] ?? "");
    const revenueCell = parseNumericCell(row[1]);
    if (!segment || !revenueCell) continue;
    const shareCell = parseNumericCell(row[2]);
    const refs = citationRefs(row.join(" "));
    const sourceRefs = refs.length > 0 ? refs : priorRefs;
    const unit = /%/.test(row[1] ?? "") ? "percent" : unitContext.unit;

    const value = {
      segment,
      revenue: Math.round(revenueCell.value * unitContext.scale * 1e6) / 1e6,
      unit,
      currency: unitContext.currency,
      share: shareCell?.value,
      period: period?.label ?? table.headers[0],
    };
    drafts.push({
      id: factId({
        companyId: input.companyId,
        predicate: "revenue_segment",
        value,
        observedAt: input.dataCutoff,
      }),
      companyId: input.companyId,
      predicate: "revenue_segment",
      value,
      quote: table.rawRows[index] ?? row.join(" | "),
      method: "deterministic_table_v1",
      confidence: sourceRefs.length > 0 ? 0.85 : 0.6,
      observedAt,
      sourceRefs,
      sourceRef: sourceRefs[0],
    });
  }
  return drafts;
}

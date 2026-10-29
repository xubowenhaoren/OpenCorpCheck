import { factId } from "@occ/db";
import type { SectionChapter } from "@occ/ingest";

import { citationRefs, parseMarkdownTables, stripCitations } from "./markdown-table.js";

export interface FactDraft {
  id: string;
  companyId: string;
  predicate: string;
  value: unknown;
  quote: string;
  method: string;
  confidence: number;
  observedAt?: Date;
  sourceRefs: number[];
  sourceRef?: number;
}

const PREDICATES: Array<{ test: RegExp; predicate: string }> = [
  { test: /股票代码|交易所|上市地/, predicate: "listing" },
  { test: /总部|注册地|地址/, predicate: "headquarters" },
  { test: /成立时间|成立日期|创立/, predicate: "founded" },
  { test: /^财年$|财年/, predicate: "fiscal_year_end" },
  { test: /员工数|员工人数|雇员/, predicate: "employees" },
  { test: /市值/, predicate: "market_cap" },
];

function predicateFor(label: string): string {
  return PREDICATES.find((entry) => entry.test.test(label))?.predicate ?? "snapshot";
}

function parseEmployees(text: string): { count?: number; text: string } {
  const match = /([\d,]+)/.exec(text);
  if (!match) return { text };
  return { count: Number(match[1]!.replace(/,/g, "")), text };
}

/**
 * Section 2 (`公司快照`) is a two-column table. Every row becomes a fact with
 * the data-cutoff date as `observedAt`.
 */
export function extractSnapshotFacts(input: {
  companyId: string;
  chapter: SectionChapter;
  dataCutoff?: string;
}): FactDraft[] {
  const table = parseMarkdownTables(input.chapter.text).find(
    (candidate) => candidate.headers.length === 2,
  );
  if (!table) return [];

  const observedAt = input.dataCutoff
    ? new Date(`${input.dataCutoff}T00:00:00Z`)
    : undefined;
  const drafts: FactDraft[] = [];

  for (const [index, row] of table.rows.entries()) {
    const label = stripCitations(row[0] ?? "");
    const rawValue = row[1] ?? "";
    const text = stripCitations(rawValue).replace(/\s+/g, " ").trim();
    if (!label || !text) continue;

    const predicate = predicateFor(label);
    const refs = citationRefs(row.join(" "));
    const value =
      predicate === "employees"
        ? parseEmployees(text)
        : predicate === "snapshot"
          ? { label, text }
          : { text };

    drafts.push({
      id: factId({
        companyId: input.companyId,
        predicate,
        value,
        observedAt: input.dataCutoff,
      }),
      companyId: input.companyId,
      predicate,
      value,
      quote: table.rawRows[index] ?? `${label} | ${rawValue}`,
      method: "deterministic_snapshot_v1",
      confidence: refs.length > 0 ? 0.9 : 0.7,
      observedAt,
      sourceRefs: refs,
      sourceRef: refs[0],
    });
  }

  return drafts;
}

import { factId } from "@occ/db";
import type { SectionChapter } from "@occ/ingest";

import { citationRefs, stripCitations } from "./markdown-table.js";
import type { FactDraft } from "./snapshot.js";

/**
 * Section 10 (`近 12 个月大事`) bullets:
 *   - 2026-01-12：Apple 与 Alphabet 宣布 …
 */
export function extractTimelineFacts(input: {
  companyId: string;
  chapter: SectionChapter;
  dataCutoff?: string;
}): FactDraft[] {
  const drafts: FactDraft[] = [];

  for (const line of input.chapter.text.split("\n")) {
    const match = /^\s*[-*]\s*(\d{4}-\d{2}-\d{2})\s*[：:]\s*(.+)$/.exec(line);
    if (!match) continue;
    const date = match[1]!;
    const text = stripCitations(match[2]!).trim();
    if (!text) continue;

    const refs = citationRefs(line);
    const value = {
      date,
      title: text.length > 160 ? `${text.slice(0, 157)}…` : text,
      text,
    };
    drafts.push({
      id: factId({
        companyId: input.companyId,
        predicate: "timeline_event",
        value,
        observedAt: date,
      }),
      companyId: input.companyId,
      predicate: "timeline_event",
      value,
      quote: line.trim(),
      method: "deterministic_bullets_v1",
      confidence: refs.length > 0 ? 0.9 : 0.75,
      observedAt: new Date(`${date}T00:00:00Z`),
      sourceRefs: refs,
      sourceRef: refs[0],
    });
  }

  return drafts;
}

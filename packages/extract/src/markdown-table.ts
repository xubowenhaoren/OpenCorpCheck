export interface MarkdownTable {
  headers: string[];
  rows: string[][];
  /** 1-based line number of the header row. */
  startLine: number;
  /** Raw line per row, aligned with `rows`. */
  rawRows: string[];
}

function splitRow(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const withoutTail = inner.endsWith("|") ? inner.slice(0, -1) : inner;
  return withoutTail.split("|").map((cell) => cell.trim());
}

function isSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

/** Parse every GFM table in a chapter. Tables without a separator are ignored. */
export function parseMarkdownTables(text: string): MarkdownTable[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const tables: MarkdownTable[] = [];

  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = lines[index]!;
    if (!header.includes("|")) continue;
    if (!isSeparator(lines[index + 1] ?? "")) continue;

    const headers = splitRow(header);
    const rows: string[][] = [];
    const rawRows: string[] = [];
    let cursor = index + 2;
    while (cursor < lines.length && lines[cursor]!.includes("|")) {
      const line = lines[cursor]!;
      if (isSeparator(line)) {
        cursor += 1;
        continue;
      }
      const cells = splitRow(line);
      rows.push(
        headers.map((_, cellIndex) => cells[cellIndex] ?? ""),
      );
      rawRows.push(line.trim());
      cursor += 1;
    }
    tables.push({ headers, rows, rawRows, startLine: index + 1 });
    index = cursor - 1;
  }

  return tables;
}

/** Strip inline citation markers such as `[10]` / `[4][6]`. */
export function stripCitations(value: string): string {
  return value.replace(/\[\d+\]/g, "").trim();
}

/** Citation numbers in order of appearance, deduplicated. */
export function citationRefs(value: string): number[] {
  const refs = [...value.matchAll(/\[(\d+)\]/g)].map((match) =>
    Number.parseInt(match[1]!, 10),
  );
  return [...new Set(refs)];
}

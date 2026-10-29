import type { Market } from "@occ/core";

export interface UnitContext {
  /** Multiplier applied to the raw cell value. */
  scale: number;
  currency?: string;
  unit: "currency" | "percent" | "currency_per_share";
  label: string;
  /** True when we had to fall back to a market default. */
  inferred: boolean;
}

export interface NumericCell {
  value: number;
  refs: number[];
  computed: boolean;
  percent: boolean;
  raw: string;
}

const MISSING = /^(未验证|未获取|未单列|未披露|不适用|—|-|–|n\/a|N\/A)$/i;

function marketDefault(market: Market): UnitContext {
  if (market === "A") {
    return {
      scale: 1e8,
      currency: "CNY",
      unit: "currency",
      label: "亿元（默认）",
      inferred: true,
    };
  }
  if (market === "HK") {
    return {
      scale: 1e8,
      currency: "HKD",
      unit: "currency",
      label: "亿港元（默认）",
      inferred: true,
    };
  }
  return {
    scale: 1e6,
    currency: "USD",
    unit: "currency",
    label: "百万美元（默认）",
    inferred: true,
  };
}

/**
 * Read the unit from the chapter heading, a `单位：` line, or the table header
 * cell (`指标（人民币亿元）`). Falls back to the market convention and marks the
 * context as inferred.
 */
export function parseUnitContext(
  chapterTitle: string,
  chapterText: string,
  market: Market,
): UnitContext {
  const head = chapterTitle;
  const line = chapterText
    .split("\n")
    .map((value) => value.trim())
    .find((value) => /^(单位|币种)[：:]/.test(value));
  const headerCell = /\|\s*[^|\n]*[（(]([^）)]*(?:美元|欧元|港元|人民币|亿元)[^）)]*)[）)]/.exec(
    chapterText,
  )?.[1];
  const haystack = [head, line, headerCell].filter(Boolean).join(" ");

  const currency =
    /美元|USD/i.test(haystack)
      ? "USD"
      : /欧元|EUR/i.test(haystack)
        ? "EUR"
        : /港元|港币|HKD/i.test(haystack)
          ? "HKD"
          : /人民币|CNY|RMB|亿元/i.test(haystack)
            ? "CNY"
            : /日元|JPY/i.test(haystack)
              ? "JPY"
              : /英镑|GBP/i.test(haystack)
                ? "GBP"
                : undefined;

  let scale = 0;
  let label = "";
  for (const [pattern, multiplier, name] of [
    [/十亿美元/, 1e9, "十亿美元"],
    [/十亿欧元/, 1e9, "十亿欧元"],
    [/亿美元/, 1e8, "亿美元"],
    [/亿欧元/, 1e8, "亿欧元"],
    [/亿港元/, 1e8, "亿港元"],
    [/亿人民币|人民币亿元|亿元/, 1e8, "亿元"],
    [/百万美元|美元，百万|美元,百万/, 1e6, "百万美元"],
    [/百万欧元/, 1e6, "百万欧元"],
    [/百万港元/, 1e6, "百万港元"],
    [/千美元|千美元/, 1e3, "千美元"],
  ] as const) {
    if (pattern.test(haystack)) {
      scale = multiplier;
      label = name;
      break;
    }
  }

  if (!scale) {
    const fallback = marketDefault(market);
    return {
      ...fallback,
      currency: currency ?? fallback.currency,
      label: currency ? `${currency}（默认）` : fallback.label,
    };
  }

  return {
    scale,
    currency,
    unit: "currency",
    label,
    inferred: false,
  };
}

/**
 * Normalize a table cell. Returns null for "not verified"/"not disclosed" —
 * those must never become zero.
 */
export function parseNumericCell(cell: string | undefined): NumericCell | null {
  if (cell === undefined) return null;
  const raw = cell.trim();
  if (!raw) return null;

  const refs = [...raw.matchAll(/\[(\d+)\]/g)].map((match) =>
    Number.parseInt(match[1]!, 10),
  );
  const computed = /（计算）|\(计算\)|\*/.test(raw);
  const cleaned = raw
    .replace(/\[\d+\]/g, "")
    .replace(/（计算）|\(计算\)/g, "")
    .replace(/[*＊]/g, "")
    .replace(/\s+/g, "")
    .replace(/[，,]/g, "")
    .trim();

  if (MISSING.test(cleaned)) return null;

  const percent = /%|％/.test(cleaned);
  const numeric = cleaned.replace(/[%％]/g, "");
  if (!/^[-+]?\d+(?:\.\d+)?$/.test(numeric)) return null;

  return {
    value: Number.parseFloat(numeric),
    refs: [...new Set(refs)],
    computed,
    percent,
    raw,
  };
}

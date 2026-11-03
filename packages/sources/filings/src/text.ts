import { createHash } from "node:crypto";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode the small entity set needed by RSS/HTML titles, then collapse space. */
export function cleanText(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity: string) => {
      try {
        if (entity.startsWith("#x") || entity.startsWith("#X")) {
          const code = Number.parseInt(entity.slice(2), 16);
          return Number.isFinite(code) ? String.fromCodePoint(code) : "";
        }
        if (entity.startsWith("#")) {
          const code = Number.parseInt(entity.slice(1), 10);
          return Number.isFinite(code) ? String.fromCodePoint(code) : "";
        }
        return ENTITIES[entity.toLowerCase()] ?? "";
      } catch {
        // Out-of-range code points and surrogate values are dropped.
        return "";
      }
    })
    // Postgres text columns reject NUL and other C0 controls.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Canonical URL used for dedupe. Removes tracking parameters and the
 * `random` cache-buster used by exchange search endpoints; keeps everything
 * else (announcement ids and PDF dates are meaningful).
 */
export function canonicalFilingUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|trk($|[_-])|random$|_$)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.hostname = url.hostname.toLowerCase();
    if (
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443")
    ) {
      url.port = "";
    }
    return url.toString();
  } catch {
    return raw.trim();
  }
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Stable identity for one source filing, independent of its display text. */
export function filingKey(item: {
  source: string;
  externalId: string;
  url: string;
}): string {
  return `${item.source}|${item.externalId}|${canonicalFilingUrl(item.url)}`;
}

/** `dd/mm/yyyy HH:MM` (HKEXnews) or `yyyy-mm-dd` → ISO, else undefined. */
export function parseFilingDate(value: string | null | undefined): string | undefined {
  const raw = (value ?? "").trim();
  if (!raw) return undefined;
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(raw);
  if (dmy) {
    const [, day, month, year, hour = "0", minute = "0"] = dmy;
    const date = new Date(
      Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
      ),
    );
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  const ymd = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(raw);
  if (ymd) {
    const [, year, month, day, hour = "0", minute = "0", second = "0"] = ymd;
    const date = new Date(
      Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
      ),
    );
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** `YYYYMMDD` / `YYYY-MM-DD` as a `Date` at 00:00Z. */
export function startOfDay(value: string): Date {
  const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`invalid date ${value}; use YYYY-MM-DD`);
  return new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

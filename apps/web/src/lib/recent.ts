export interface RecentCompany {
  ref: string;
  name: string;
  ticker?: string;
}

const KEY = "occ-recent";
const MAX = 8;

function isRecent(value: unknown): value is RecentCompany {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as RecentCompany).ref === "string" &&
    typeof (value as RecentCompany).name === "string"
  );
}

export function readRecent(): RecentCompany[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecent).slice(0, MAX);
  } catch {
    return [];
  }
}

export function addRecent(item: RecentCompany): void {
  try {
    const next = [
      item,
      ...readRecent().filter((entry) => entry.ref !== item.ref),
    ].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

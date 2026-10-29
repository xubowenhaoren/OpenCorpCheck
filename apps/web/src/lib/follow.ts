const KEY = "occ-follows";

export function readFollows(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

export function isFollowed(ref: string): boolean {
  return readFollows().includes(ref);
}

export function toggleFollow(ref: string): boolean {
  try {
    const current = readFollows();
    const next = current.includes(ref)
      ? current.filter((value) => value !== ref)
      : [...current, ref];
    localStorage.setItem(KEY, JSON.stringify(next));
    return next.includes(ref);
  } catch {
    return false;
  }
}

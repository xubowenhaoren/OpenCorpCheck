import { ulid } from "ulid";

/** New internal entity id (ULID; sortable by creation time). */
export function newId(): string {
  return ulid();
}

/** Stable slug used in URLs and for idempotent seed data. */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

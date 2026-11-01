/**
 * Incremental-fetch window for the automatic news sweep.
 *
 * Google News RSS has no reliable `since` cursor: it returns the newest items
 * for a query. The per-company cursor is therefore a *hint* — it chooses how
 * far back to accept items and how many to ask for — never a filter that could
 * discard an article that is new to the database.
 */

export const NEWS_COLD_START_DAYS = 30;
export const NEWS_COLD_START_MAX_ITEMS = 20;
export const NEWS_STEADY_MAX_ITEMS = 10;

export interface NewsWindowInput {
  lastUpdateAt?: Date | string | null;
  newestPublishedAt?: Date | string | null;
  now?: Date;
}

export interface NewsFetchWindow {
  sinceDays: number;
  maxItems: number;
  coldStart: boolean;
}

function toTime(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) ? null : time;
}

/**
 * `sinceDays = clamp(ceil((now − min(last_update_at, newest_published_at)) / 1d) + 1, 1, 30)`
 *
 * Taking the older of run time and newest article time widens the window when
 * the feed lags, so late-indexed articles are not skipped. A company that has
 * never been checked gets the 30-day cold start.
 */
export function newsFetchWindow(input: NewsWindowInput = {}): NewsFetchWindow {
  const now = input.now ?? new Date();
  const last = toTime(input.lastUpdateAt);
  const newest = toTime(input.newestPublishedAt);
  if (last === null && newest === null) {
    return {
      sinceDays: NEWS_COLD_START_DAYS,
      maxItems: NEWS_COLD_START_MAX_ITEMS,
      coldStart: true,
    };
  }
  const anchor = Math.min(last ?? newest!, newest ?? last!);
  const elapsedDays = Math.ceil(
    Math.max(0, now.getTime() - anchor) / 86_400_000,
  );
  return {
    sinceDays: Math.min(
      30,
      Math.max(1, elapsedDays + 1),
    ),
    maxItems: NEWS_STEADY_MAX_ITEMS,
    coldStart: false,
  };
}

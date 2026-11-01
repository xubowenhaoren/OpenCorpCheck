import type { Lang } from "../i18n";
import type { NewsSweepView } from "../api";

/** Percent complete for a sweep, clamped to 0–100. */
export function sweepPercent(sweep: Pick<NewsSweepView, "done" | "total">): number {
  if (!sweep.total) return 0;
  return Math.max(0, Math.min(100, Math.round((sweep.done / sweep.total) * 100)));
}

export function sweepState(sweep: Pick<NewsSweepView, "status">):
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "queued" {
  if (sweep.status === "queued") return "queued";
  if (sweep.status === "running") return "running";
  if (sweep.status === "partial") return "partial";
  if (sweep.status === "failed") return "failed";
  return "completed";
}

/** "刚刚" / "3 分钟前" / "2 小时前" / "1 天前" */
export function relativePast(
  iso: string | null | undefined,
  lang: Lang,
  now = Date.now(),
): string {
  if (!iso) return lang === "zh" ? "尚未更新" : "Not updated";
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return lang === "zh" ? "尚未更新" : "Not updated";
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return lang === "zh" ? "刚刚" : "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return lang === "zh" ? `${minutes} 分钟前` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return lang === "zh" ? `${hours} 小时前` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return lang === "zh" ? `${days} 天前` : `${days}d ago`;
}

/** "约 3 小时后" / "in about 3 hours" — used for the next automatic sweep. */
export function relativeFuture(
  iso: string | null | undefined,
  lang: Lang,
  now = Date.now(),
): string {
  if (!iso) return lang === "zh" ? "即将自动更新" : "soon";
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return lang === "zh" ? "即将自动更新" : "soon";
  const seconds = Math.max(0, Math.round((time - now) / 1000));
  if (seconds < 60) return lang === "zh" ? "马上" : "any moment";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) {
    return lang === "zh" ? `约 ${minutes} 分钟后` : `in about ${minutes}m`;
  }
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) {
    return lang === "zh" ? `约 ${hours} 小时后` : `in about ${hours}h`;
  }
  const days = Math.ceil(hours / 24);
  return lang === "zh" ? `约 ${days} 天后` : `in about ${days}d`;
}

/** Elapsed run time: "42s", "3m 05s", "1h 02m". */
export function formatElapsed(ms: number, lang: Lang): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) {
    return lang === "zh" ? `${totalSeconds} 秒` : `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return lang === "zh"
      ? `${minutes} 分 ${String(seconds).padStart(2, "0")} 秒`
      : `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  const hours = Math.floor(minutes / 60);
  return lang === "zh"
    ? `${hours} 小时 ${String(minutes % 60).padStart(2, "0")} 分`
    : `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** One-line status for a sweep; the dock renders it next to the state dot. */
export function describeSweep(
  sweep: NewsSweepView,
  lang: Lang,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const state = sweepState(sweep);
  if (state === "queued") return t("dock.queued");
  if (state === "running") {
    return t("dock.running", {
      done: sweep.done,
      total: sweep.total,
      pct: sweepPercent(sweep),
    });
  }
  if (state === "partial") return t("dock.partial", { failed: sweep.failed });
  if (state === "failed") return t("dock.failed");
  return t("dock.completed", { count: sweep.inserted });
}

/** Short right-hand detail for one company inside an expanded sweep. */
export function describeJob(
  job: { status: string; meta?: Record<string, unknown> },
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (job.status === "completed") {
    const inserted = Number(job.meta?.inserted ?? 0);
    return inserted > 0
      ? t("dock.items", { count: inserted })
      : t("dock.emptyFeed");
  }
  if (job.status === "active") return t("dock.runningDetail");
  if (job.status === "queued") return t("dock.queuedDetail");
  return t("dock.failedDetail");
}

import type { FilingRefreshView } from "@occ/core";

import type { Lang } from "../i18n";
import { relativePast } from "./news-dock";

type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

export interface FilingStatusLine {
  text: string;
  warn?: boolean;
}

/**
 * Company-page filing status line (P1.5). Pure so the pending / retrying /
 * latest-report branches can be tested without rendering React.
 */
export function filingStatus(
  refresh: FilingRefreshView | undefined,
  lang: Lang,
  t: Translate,
): FilingStatusLine | null {
  if (!refresh) return null;
  if (refresh.lastStatus === "failed" || refresh.lastStatus === "paused") {
    return {
      text: t("filing.retrying", { count: refresh.consecutiveFailures }),
      warn: true,
    };
  }
  if (refresh.pending) return { text: t("filing.pending") };
  if (refresh.latest) {
    const date =
      refresh.latest.periodEnd?.slice(0, 10) ??
      refresh.latest.filedAt?.slice(0, 10) ??
      "";
    const form =
      refresh.latest.form ?? (lang === "zh" ? "定期报告" : "periodic");
    const parts: string[] = [];
    if (date) parts.push(t("filing.latest", { period: date, form }));
    if (refresh.latest.filedAt) {
      parts.push(
        t("filing.updated", {
          time: relativePast(refresh.latest.filedAt, lang),
        }),
      );
    }
    return { text: parts.join(" · ") || t("filing.never") };
  }
  if (refresh.lastCheckedAt) {
    return {
      text: t("filing.checked", {
        time: relativePast(refresh.lastCheckedAt, lang),
      }),
    };
  }
  return { text: t("filing.never") };
}

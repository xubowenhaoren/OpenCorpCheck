import { useEffect } from "react";

import type { SourceSheetData } from "../contexts/SourceContext";
import { trustLabel } from "../format";
import { useLang } from "../i18n";

export function SourceSheet({
  source,
  onClose,
}: {
  source: SourceSheetData | null;
  onClose: () => void;
}) {
  const { lang } = useLang();

  useEffect(() => {
    if (!source) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [source, onClose]);

  if (!source) return null;

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div
        className="source-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={source.title ?? "来源"}
      >
        <button
          className="sheet-close"
          onClick={onClose}
          aria-label={lang === "zh" ? "关闭来源" : "Close source"}
        >
          ×
        </button>
        <h3>{source.title ?? (lang === "zh" ? "来源" : "Source")}</h3>
        <div className="sheet-meta">
          {trustLabel(source.trustTier, lang)}
          {source.date ? ` · ${source.date}` : ""}
        </div>
        {source.quote ? (
          <div className="sheet-quote">“{source.quote}”</div>
        ) : null}
        <a
          className="sheet-link"
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {lang === "zh" ? "打开原始网页" : "Open original"}
        </a>
        <p className="hint">
          {lang === "zh"
            ? "来源为外部网页，内容以原文为准。"
            : "External source; the original page is authoritative."}
        </p>
      </div>
    </>
  );
}

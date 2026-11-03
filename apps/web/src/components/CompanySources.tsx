import { useMemo, useState } from "react";
import type { CompanyCard } from "@occ/core";

import { useSource } from "../contexts/SourceContext";
import { trustLabel } from "../format";
import { useLang } from "../i18n";
import { EmptyState } from "./States";

interface SourceEntry {
  url: string;
  title?: string;
  trustTier?: string;
  quotes: string[];
  references: number;
}

const TRUST_ORDER = ["filing", "secondary", "media", "news", "proposal", "fixture", "other"];

function trustRank(tier: string | undefined): number {
  const index = TRUST_ORDER.indexOf(tier ?? "other");
  return index === -1 ? TRUST_ORDER.length : index;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function CompanySources({ card }: { card: CompanyCard }) {
  const { t, lang } = useLang();
  const { openSource } = useSource();
  const [copied, setCopied] = useState(false);

  const sources = useMemo(() => {
    const map = new Map<string, SourceEntry>();
    const put = (
      url: string | undefined,
      title: string | undefined,
      trustTier: string | undefined,
      quote: string | undefined,
    ) => {
      if (!url) return;
      const entry = map.get(url) ?? {
        url,
        title,
        trustTier,
        quotes: [],
        references: 0,
      };
      entry.references += 1;
      if (!entry.title && title) entry.title = title;
      if (!entry.trustTier && trustTier) entry.trustTier = trustTier;
      if (quote && !entry.quotes.includes(quote)) entry.quotes.push(quote);
      map.set(url, entry);
    };

    for (const fact of card.financials ?? []) {
      put(fact.source?.url, fact.source?.title, fact.source?.trustTier, fact.quote);
    }
    for (const fact of card.facts ?? []) {
      put(fact.source?.url, fact.source?.title, fact.source?.trustTier, fact.quote);
    }
    for (const event of card.events ?? []) {
      put(
        event.source?.url,
        event.source?.title,
        event.source?.trustTier,
        event.quote ?? event.summary,
      );
    }
    for (const filing of card.filings ?? []) {
      put(
        filing.source?.url,
        filing.source?.title,
        filing.source?.trustTier,
        filing.summary ?? filing.title,
      );
    }
    for (const relation of [
      ...(card.relations?.incoming ?? []),
      ...(card.relations?.outgoing ?? []),
    ]) {
      for (const evidence of relation.evidence) {
        put(evidence.url, evidence.title, evidence.trustTier, evidence.quote);
      }
    }
    return [...map.values()].sort(
      (a, b) =>
        trustRank(a.trustTier) - trustRank(b.trustTier) ||
        b.references - a.references,
    );
  }, [card]);

  if (sources.length === 0) {
    return <EmptyState title={t("sources.empty")} hint={t("sources.emptyHint")} />;
  }

  const grouped = new Map<string, SourceEntry[]>();
  for (const source of sources) {
    const key = source.trustTier ?? "other";
    grouped.set(key, [...(grouped.get(key) ?? []), source]);
  }

  async function copyAll() {
    const text = sources
      .map((source) => {
        const title = source.title ?? source.url;
        const quote = source.quotes[0] ? `\n  > ${source.quotes[0]}` : "";
        return `- [${title}](${source.url})${quote}`;
      })
      .join("\n");
    const ok = await copyText(text);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    }
  }

  return (
    <section className="card block">
      <div className="block-head">
        <h2>{t("sources.title")}</h2>
        <div className="head-actions">
          <span className="hint">{t("sources.count", { count: sources.length })}</span>
          <button type="button" className="btn secondary small" onClick={() => void copyAll()}>
            {copied ? t("sources.copied") : t("sources.copy")}
          </button>
        </div>
      </div>

      {[...grouped.entries()].map(([tier, entries]) => (
        <div className="source-group" key={tier}>
          <h3>{trustLabel(tier, lang)}</h3>
          {entries.map((source) => (
            <div className="source-item" key={source.url}>
              <div>
                <button
                  type="button"
                  className="link-button"
                  onClick={() =>
                    openSource({
                      url: source.url,
                      title: source.title,
                      trustTier: source.trustTier,
                      quote: source.quotes[0],
                    })
                  }
                >
                  {source.title ?? source.url}
                </button>
                <div className="source-meta">
                  {source.url.replace(/^https?:\/\//, "").slice(0, 80)}
                  {source.references > 1
                    ? ` · ${source.references} ${
                        lang === "zh" ? "处引用" : "references"
                      }`
                    : ""}
                </div>
              </div>
              <a
                className="src-btn"
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("common.open")}
              </a>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

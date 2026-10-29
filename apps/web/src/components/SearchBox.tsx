import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { searchCompanies } from "../api";
import { useAgent } from "../contexts/AgentContext";
import { useLang } from "../i18n";
import { looksLikeQuestion, useDebouncedValue } from "../lib/hooks";
import { filterRelevantCompanyHits } from "../lib/search";
import type { CompanyHit } from "@occ/core";

interface SearchBoxProps {
  variant?: "nav" | "hero";
  initialQuery?: string;
  onSelectCompany?: (hit: CompanyHit) => void;
  autoFocus?: boolean;
}

export function SearchBox({
  variant = "nav",
  initialQuery = "",
  onSelectCompany,
  autoFocus = false,
}: SearchBoxProps) {
  const navigate = useNavigate();
  const { t } = useLang();
  const { openAgent } = useAgent();
  const [query, setQuery] = useState(initialQuery);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const debounced = useDebouncedValue(query.trim(), 200);

  const { data, isFetching } = useQuery({
    queryKey: ["quick-search", debounced],
    queryFn: () =>
      searchCompanies({ q: debounced, limit: 8, explain: true }),
    enabled: debounced.length > 0,
    staleTime: 30_000,
  });

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  const hits = filterRelevantCompanyHits(
    data?.data.hits ?? [],
    debounced,
  );
  const isQuestion = looksLikeQuestion(query);

  function choose(hit: CompanyHit) {
    setOpen(false);
    setQuery("");
    if (onSelectCompany) onSelectCompany(hit);
    else navigate(`/c/${encodeURIComponent(hit.slug)}`);
  }

  function ask() {
    const text = query.trim();
    if (!text) return;
    setOpen(false);
    openAgent(null, text);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = query.trim();
    if (!text) return;
    setOpen(false);
    if (onSelectCompany && hits[0]) {
      onSelectCompany(hits[0]);
      return;
    }
    navigate(`/search?q=${encodeURIComponent(text)}`);
  }

  const showPopup = open && query.trim().length > 0;

  return (
    <div
      className={variant === "hero" ? "home-search" : "nav-search"}
      ref={wrapperRef}
    >
      <form onSubmit={submit} role="search">
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
          autoFocus={autoFocus}
          placeholder={
            variant === "hero"
              ? t("home.searchPlaceholder")
              : t("nav.searchPlaceholder")
          }
          aria-label={t("nav.searchPlaceholder")}
          aria-expanded={showPopup}
          aria-controls="global-search-popup"
        />
        {variant === "hero" ? (
          <button className="home-search-submit" type="submit">
            {t("home.searchButton")}
          </button>
        ) : null}
      </form>

      {showPopup ? (
        <div
          className={`search-pop${variant === "hero" ? " home-pop" : ""}`}
          id="global-search-popup"
          role="listbox"
        >
          {isQuestion ? (
            <button
              type="button"
              className="search-item"
              onClick={ask}
              role="option"
            >
              <span className="search-dot ask" />
              <span>
                <strong>{t("search.ask")}</strong>
                <span className="search-sub">{query.trim()}</span>
              </span>
            </button>
          ) : null}

          {hits.map((hit) => {
            const ticker = hit.tickers[0];
            return (
              <button
                type="button"
                className="search-item"
                key={hit.id}
                onClick={() => choose(hit)}
                role="option"
              >
                <span className="search-dot" />
                <span>
                  <strong>{hit.displayName}</strong>
                  <span className="search-sub">
                    {[
                      ticker ? `${ticker.ticker} · ${ticker.exchange}` : null,
                      hit.sector,
                      hit.country,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
              </button>
            );
          })}

          {isFetching && hits.length === 0 ? (
            <div className="search-item muted" aria-live="polite">
              <span className="spinner" />
              {t("common.loading")}
            </div>
          ) : null}

          {!isFetching && hits.length === 0 && !isQuestion ? (
            <div className="search-item muted">{t("search.empty")}</div>
          ) : null}

          {!isQuestion ? (
            <button
              type="button"
              className="search-item"
              onClick={ask}
              role="option"
            >
              <span className="search-dot ask" />
              <span>
                <strong>{t("search.ask")}</strong>
                <span className="search-sub">{query.trim()}</span>
              </span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export type { SearchBoxProps };

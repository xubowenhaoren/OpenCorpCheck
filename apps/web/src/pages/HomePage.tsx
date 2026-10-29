import { Link } from "react-router-dom";

import { SearchBox } from "../components/SearchBox";
import { useLang } from "../i18n";
import { readRecent } from "../lib/recent";

const HOT = [
  { ref: "AAPL", name: "Apple Inc.", ticker: "AAPL" },
  { ref: "NVDA", name: "NVIDIA Corporation", ticker: "NVDA" },
  { ref: "MSFT", name: "Microsoft Corporation", ticker: "MSFT" },
  { ref: "600519", name: "贵州茅台", ticker: "600519" },
  { ref: "00700", name: "腾讯控股", ticker: "00700" },
  { ref: "TSLA", name: "Tesla, Inc.", ticker: "TSLA" },
  { ref: "AMZN", name: "Amazon.com, Inc.", ticker: "AMZN" },
  { ref: "META", name: "Meta Platforms, Inc.", ticker: "META" },
];

export function HomePage() {
  const { t, lang } = useLang();
  const recent = readRecent();

  return (
    <div className="home-page">
      <section className="home-hero">
        <span className="home-kicker">{t("home.kicker")}</span>
        <h1 className="home-title">{t("home.title")}</h1>
        <p className="home-sub">{t("home.sub")}</p>
        <SearchBox variant="hero" autoFocus />
      </section>

      <section className="home-section">
        <div className="home-section-head">
          <h2>{t("home.hot")}</h2>
        </div>
        <div className="hot-list">
          {HOT.map((item) => (
            <Link
              className="hot-chip"
              key={item.ref}
              to={`/c/${encodeURIComponent(item.ref)}`}
            >
              {item.name}
              <span className="ticker">{item.ticker}</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="home-section">
        <div className="home-section-head">
          <h2>{t("home.markets")}</h2>
        </div>
        <div className="market-grid">
          <Link className="market-card" to="/search?market=A">
            <strong>{t("home.marketA")}</strong>
            <span>{t("home.marketAHint")}</span>
          </Link>
          <Link className="market-card" to="/search?market=HK">
            <strong>{t("home.marketHK")}</strong>
            <span>{t("home.marketHKHint")}</span>
          </Link>
          <Link className="market-card" to="/search?market=US">
            <strong>{t("home.marketUS")}</strong>
            <span>{t("home.marketUSHint")}</span>
          </Link>
        </div>
        <Link className="index-shortcut" to="/indices/NDX">
          <span>
            <strong>{t("home.indexShortcut")}</strong>
            <span className="muted" style={{ display: "block", fontSize: 12 }}>
              {t("home.indexShortcutHint")}
            </span>
          </span>
          <span className="count">100</span>
        </Link>
      </section>

      <section className="home-section">
        <div className="home-section-head">
          <h2>{t("home.recent")}</h2>
        </div>
        {recent.length > 0 ? (
          <div className="recent-list">
            {recent.map((item) => (
              <Link
                className="hot-chip"
                key={item.ref}
                to={`/c/${encodeURIComponent(item.ref)}`}
              >
                {item.name}
                {item.ticker ? (
                  <span className="ticker">{item.ticker}</span>
                ) : null}
              </Link>
            ))}
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 13 }}>
            {lang === "zh"
              ? t("home.recentEmpty")
              : t("home.recentEmpty")}
          </p>
        )}
      </section>
    </div>
  );
}

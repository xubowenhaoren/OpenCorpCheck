import { Link, useLocation, useSearchParams } from "react-router-dom";

import { useAgent } from "../contexts/AgentContext";
import { useTheme } from "../contexts/ThemeContext";
import { useLang } from "../i18n";
import { SearchBox } from "./SearchBox";

export function TopNav() {
  const location = useLocation();
  const [params] = useSearchParams();
  const query = params.get("q") ?? "";
  const { t, lang, toggleLang } = useLang();
  const { theme, toggleTheme } = useTheme();
  const { openAgent } = useAgent();
  const isHome = location.pathname === "/";
  const inCompanies =
    location.pathname.startsWith("/c/") ||
    location.pathname.startsWith("/indices/") ||
    location.pathname === "/search";
  const inGraph =
    location.pathname === "/graph" ||
    location.pathname.endsWith("/graph");

  return (
    <header className="topnav">
      <div className="wrap nav-inner">
        <Link className="brand" to="/" aria-label="OpenCorpCheck 公司百科">
          <span className="brand-mark">OCC</span>
          <span>{lang === "zh" ? "公司百科" : "Company Wiki"}</span>
        </Link>

        {!isHome ? <SearchBox initialQuery={query} key={query} /> : null}

        <nav className="nav-links" aria-label="主导航">
          <Link className={location.pathname === "/" ? "active" : ""} to="/">
            {t("nav.home")}
          </Link>
          <Link className={inCompanies ? "active" : ""} to="/search">
            {t("nav.search")}
          </Link>
          <Link className={inGraph ? "active" : ""} to="/graph">
            {t("nav.graph")}
          </Link>
          <button
            type="button"
            className="nav-link-button"
            onClick={() => openAgent(null)}
          >
            {t("nav.ask")}
          </button>
        </nav>

        <div className="nav-actions">
          <button
            type="button"
            className="ghost-icon"
            onClick={toggleLang}
            aria-label={lang === "zh" ? "Switch to English" : "切换到中文"}
          >
            {lang === "zh" ? "EN" : "中"}
          </button>
          <button
            type="button"
            className="ghost-icon"
            onClick={toggleTheme}
            aria-label={theme === "dark" ? t("nav.themeLight") : t("nav.themeDark")}
          >
            {theme === "dark" ? t("nav.themeLight") : t("nav.themeDark")}
          </button>
        </div>
      </div>
    </header>
  );
}

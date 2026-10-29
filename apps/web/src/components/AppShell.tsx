import { Outlet } from "react-router-dom";

import { useAgent } from "../contexts/AgentContext";
import { useLang } from "../i18n";
import { AgentSidebar } from "./AgentSidebar";
import { TopNav } from "./TopNav";

export function AppShell() {
  const { openAgent } = useAgent();
  const { t } = useLang();

  return (
    <>
      <TopNav />
      <div className="app-shell" id="app-shell">
        <main className="wrap">
          <Outlet />
        </main>
      </div>
      <AgentSidebar />
      <button
        type="button"
        className="ask-fab"
        onClick={() => openAgent(null)}
        aria-label={t("nav.ask")}
      >
        💬 {t("company.ask")}
      </button>
    </>
  );
}

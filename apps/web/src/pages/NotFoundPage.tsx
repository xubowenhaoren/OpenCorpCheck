import { Link } from "react-router-dom";

import { EmptyState } from "../components/States";
import { useLang } from "../i18n";

export function NotFoundPage() {
  const { t } = useLang();
  return (
    <div style={{ paddingTop: 48 }}>
      <EmptyState title={t("notFound.title")} hint={t("notFound.hint")}>
        <Link className="btn" to="/">
          {t("notFound.home")}
        </Link>
      </EmptyState>
    </div>
  );
}

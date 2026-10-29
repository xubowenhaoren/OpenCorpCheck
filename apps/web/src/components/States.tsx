import { useLang } from "../i18n";

export function Loading({ label }: { label?: string }) {
  const { t } = useLang();
  return (
    <div className="loading" role="status">
      <span className="spinner" />
      {label ?? t("common.loading")}
    </div>
  );
}

export function ErrorView({
  message,
  code,
  onRetry,
}: {
  message?: string;
  code?: string;
  onRetry?: () => void;
}) {
  const { t } = useLang();
  return (
    <div className="error-view" role="alert">
      <h3>{t("common.error")}</h3>
      <p>{message ?? t("common.error")}</p>
      {code ? <div className="error-code">{code}</div> : null}
      {onRetry ? (
        <button className="btn secondary" type="button" onClick={onRetry}>
          {t("common.retry")}
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      {hint ? <p>{hint}</p> : null}
      {children}
    </div>
  );
}

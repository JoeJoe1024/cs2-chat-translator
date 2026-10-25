import { useEffect } from "react";
import { hasKey, useI18n } from "../i18n";
import type { Toast } from "../lib/useServer";

const AUTO_DISMISS_MS = 9000;
/** Notices with a button stay a little longer so there is time to decide. */

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const { t } = useI18n();
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.code, onDismiss]);

  const noticeKey = `notice.${toast.code}`;
  const errorKey = `error.${toast.code}`;
  const params = { name: toast.detail ?? "" };
  const message = hasKey(noticeKey) ? t(noticeKey, params) : hasKey(errorKey) ? t(errorKey) : t("error.generic");
  return (
    <div className={`toast toast--${toast.level}`} role={toast.level === "error" ? "alert" : "status"}>
      <span>{message}</span>
      <button type="button" className="btn btn--small btn--ghost" onClick={() => onDismiss(toast.id)} aria-label="×">
        ×
      </button>
    </div>
  );
}

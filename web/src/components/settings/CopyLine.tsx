import { useState } from "react";
import { useI18n } from "../../i18n";

/** A selectable command with a one-click copy button. */
export function CopyLine({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the command stays visible and selectable */
    }
  };
  return (
    <div className="bind">
      <code>{text}</code>
      <button type="button" className="btn btn--small" onClick={() => void copy()}>
        {copied ? t("composer.copied") : t("composer.copy")}
      </button>
    </div>
  );
}

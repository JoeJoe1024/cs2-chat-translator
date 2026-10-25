import type { TranslationEngineId } from "@shared/languages";
import { useI18n } from "../i18n";

export function EngineSelect({ value, onChange, label, id, className = "viewselect" }: { value: TranslationEngineId; onChange: (v: TranslationEngineId) => void; label: string; id?: string; className?: string }) {
  const { t } = useI18n();
  return (
    <select id={id} className={className} value={value} aria-label={label} title={label} onChange={(e) => onChange(e.target.value as TranslationEngineId)}>
      <option value="google">{t("engine.google")}</option>
      <option value="gemini">{t("engine.gemini")}</option>
    </select>
  );
}

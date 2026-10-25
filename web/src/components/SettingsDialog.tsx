import { useCallback, useEffect, useRef, useState } from "react";
import type { SettingsPatch } from "../../../src/config/schema";
import type { AppState } from "@shared/protocol";
import { useI18n, type MessageKey } from "../i18n";
import { AboutTab, AppearanceTab, Cs2Tab, GeneralTab, TranslationTab } from "./settings/tabs";

type Tab = "general" | "translation" | "cs2" | "appearance" | "about";
type SaveResult = { path: string; message: string }[] | null;

const TABS: Tab[] = ["general", "translation", "cs2", "appearance", "about"];

type Props = {
  open: boolean;
  tab: Tab;
  onTab: (tab: Tab) => void;
  onClose: () => void;
  app: AppState;
  onSave: (patch: SettingsPatch) => Promise<SaveResult>;
  onRefresh: () => Promise<void>;
};

export function SettingsDialog({ open, tab, onTab, onClose, app, onSave, onRefresh }: Props) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  // A newly opened tab starts at its top, not wherever the previous one was scrolled to.
  useEffect(() => {
    if (panelRef.current) panelRef.current.scrollTop = 0;
  }, [tab]);

  // `key` is the path the server reports for this field, e.g. "cs2.bindKey".
  const commit = useCallback(
    async (patch: SettingsPatch, key: string) => {
      const res = await onSave(patch);
      setErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        if (res) next[key] = res[0]?.message ?? t("field.invalid");
        return next;
      });
      if (!res) {
        setSaved(true);
        window.setTimeout(() => setSaved(false), 1200);
      }
      return res === null;
    },
    [onSave, t],
  );

  const props = { app, commit, errors, onRefresh };

  return (
    <dialog ref={ref} className="dialog" aria-labelledby="settings-title" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <div className="dialog-body">
        <div className="dialog-head">
          <h2 id="settings-title">{t("settings.title")}</h2>
          <span className={`saved${saved ? " saved--on" : ""}`} role="status">
            {saved ? `✓ ${t("settings.saved")}` : ""}
          </span>
          <button type="button" className="btn btn--icon" onClick={onClose} aria-label={t("settings.close")}>
            ×
          </button>
        </div>
        <div className="tabs" role="tablist">
          {TABS.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              id={`tab-${k}`}
              aria-selected={tab === k}
              aria-controls={`panel-${k}`}
              className={tab === k ? "tab tab--on" : "tab"}
              onClick={() => onTab(k)}
            >
              {t(`settings.tab.${k}` as MessageKey)}
            </button>
          ))}
        </div>
        <div ref={panelRef} className="tabpanel" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === "general" && <GeneralTab {...props} />}
          {tab === "translation" && <TranslationTab {...props} />}
          {tab === "cs2" && <Cs2Tab {...props} />}
          {tab === "appearance" && <AppearanceTab app={app} commit={commit} />}
          {tab === "about" && <AboutTab />}
        </div>
      </div>
    </dialog>
  );
}

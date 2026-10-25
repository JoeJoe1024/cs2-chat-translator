import type { SettingsPatch } from "../../../src/config/schema";
import type { AppState } from "@shared/protocol";
import { useI18n, type MessageKey } from "../i18n";
import { api } from "../lib/api";
import type { ServerView } from "../lib/useServer";

type Props = {
  app: AppState;
  connection: ServerView["connection"];
  onOpenSettings: () => void;
  onOpenCs2: () => void;
  onSave: (patch: SettingsPatch) => Promise<unknown>;
};

const THEME_ORDER = ["system", "light", "dark"] as const;
const THEME_ICON = { system: "◐", light: "☀", dark: "☾" } as const;

export function Header({ app, connection, onOpenSettings, onOpenCs2, onSave }: Props) {
  const { t } = useI18n();
  const w = app.watcher;
  const ok = w.state === "watching";
  const label = t(`status.${w.state}` as MessageKey);
  const reasonKey = w.reason ? (`status.reason.${w.reason}` as MessageKey) : null;
  const theme = app.settings.appearance.theme;
  const nextTheme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]!;
  const themeLabel = t(`appearance.${theme}` as MessageKey);

  return (
    <header className="topbar">
      <div className="topbar-start">
      <h1 className="brand">
        <img className="brand-mark" src="/cs2-chat-translator-logo.svg" width={26} height={26} alt="" />
        {t("app.title")}
      </h1>
      <button
        type="button"
        className={`pill ${ok ? "pill--ok" : "pill--warn"}`}
        onClick={ok ? undefined : onOpenCs2}
        title={reasonKey ? t(reasonKey) : undefined}
        aria-label={reasonKey ? `${label}: ${t(reasonKey)}` : label}
      >
        <span className="dot" aria-hidden="true" />
        {label}
      </button>
      {connection === "offline" && <span className="pill pill--danger">{t("app.offline")}</span>}
      </div>
      <a className="joelucky" href="https://joelucky.io" target="_blank" rel="noopener noreferrer" title={t("brand.visit")} aria-label={t("brand.visit")}>
        <img className="joelucky-logo joelucky-logo--light" src="/brand/joelucky-logo-light.png" width={800} height={186} alt="" />
        <img className="joelucky-logo joelucky-logo--dark" src="/brand/joelucky-logo-dark.png" width={800} height={186} alt="" />
      </a>
      <div className="topbar-end">
      {app.settings.appearance.rightCollapsed && (
        <button
          type="button"
          className="btn btn--icon"
          onClick={() => void onSave({ appearance: { rightCollapsed: false } })}
          title={t("layout.expand")}
          aria-label={t("layout.expand")}
        >
          <span aria-hidden="true">⟨</span>
        </button>
      )}
      <button
        type="button"
        className="btn btn--ghost"
        aria-pressed={app.runtime.paused}
        onClick={() => void api.setPaused(!app.runtime.paused)}
      >
        {app.runtime.paused ? t("chat.resume") : t("chat.pause")}
      </button>
      <button
        type="button"
        className="btn btn--icon"
        onClick={() => void onSave({ appearance: { theme: nextTheme } })}
        title={`${t("appearance.theme")}: ${themeLabel}`}
        aria-label={`${t("appearance.theme")}: ${themeLabel}`}
      >
        <span aria-hidden="true">{THEME_ICON[theme]}</span>
      </button>
      <button type="button" className="btn btn--icon" onClick={onOpenSettings} title={t("app.settings")} aria-label={t("app.settings")}>
        <span aria-hidden="true">⚙</span>
      </button>
      </div>
    </header>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SettingsPatch } from "../../src/config/schema";
import { Workspace } from "./components/Workspace";
import { QuickComm } from "./components/QuickComm";
import { ChatPanel } from "./components/ChatPanel";
import { Composer } from "./components/Composer";
import { Header } from "./components/Header";
import { SettingsDialog } from "./components/SettingsDialog";
import { Toasts } from "./components/Toasts";
import { I18nProvider, resolveLocale, useI18n } from "./i18n";
import { api, ApiError } from "./lib/api";
import { applyTheme } from "./lib/theme";
import { useServer } from "./lib/useServer";

// navigator.language is the first of navigator.languages; keeping it first also covers environments that report only one.
const readSystemLanguages = (): string[] => [...new Set([navigator.language, ...(navigator.languages ?? [])].filter(Boolean))];

export function App() {
  const server = useServer();
  const { app } = server.view;
  // The system's language preferences, followed live in "automatic" mode only (a fixed choice never changes).
  const [systemLanguages, setSystemLanguages] = useState(readSystemLanguages);
  useEffect(() => {
    const update = () => setSystemLanguages(readSystemLanguages());
    window.addEventListener("languagechange", update);
    return () => window.removeEventListener("languagechange", update);
  }, []);
  const locale = useMemo(
    () => resolveLocale(app?.settings.general.uiLanguage ?? "auto", systemLanguages),
    [app?.settings.general.uiLanguage, systemLanguages],
  );

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  // The server-side setting is the source of truth for the theme; localStorage only avoids a first-paint flash.
  const theme = app?.settings.appearance.theme;
  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);

  return (
    <I18nProvider locale={locale}>
      <Shell server={server} />
    </I18nProvider>
  );
}

function Shell({ server }: { server: ReturnType<typeof useServer> }) {
  const { t } = useI18n();
  const { view } = server;
  const [quick, setQuick] = useState<{ text: string; seq: number } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"general" | "translation" | "cs2" | "appearance" | "about">("general");

  const openSettings = useCallback((tab: typeof settingsTab) => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);

  const saveSettings = useCallback(
    async (patch: SettingsPatch): Promise<{ path: string; message: string }[] | null> => {
      try {
        const { settings } = await api.updateSettings(patch);
        server.setSettings(settings);
        return null;
      } catch (err) {
        if (err instanceof ApiError && err.detail) return err.detail;
        return [{ path: "", message: err instanceof ApiError ? err.code : "error" }];
      }
    },
    [server],
  );

  if (!view.app) {
    return (
      <main className="splash" role="status">
        <p>{view.connection === "failed" ? t("app.loadFailed") : t("app.loading")}</p>
      </main>
    );
  }

  const app = view.app;
  return (
    <div className="shell">
      <Header app={app} connection={view.connection} onOpenSettings={() => openSettings("general")} onOpenCs2={() => openSettings("cs2")} onSave={saveSettings} />
      <Workspace
        pct={app.settings.appearance.rightPct}
        collapsed={app.settings.appearance.rightCollapsed}
        onSave={saveSettings}
        left={
        <ChatPanel entries={view.entries} paused={app.runtime.paused} appearance={app.settings.appearance} translation={app.settings.translation} geminiKeyConfigured={app.settings.secrets.geminiKeyConfigured} general={app.settings.general} ownNames={app.identity.authorized} onSave={saveSettings} onOpenTranslation={() => openSettings("translation")} />
        }
        right={
        <>
        <Composer
          app={app}
          quick={quick}
          prepared={view.prepared}
          onPrepared={server.setPrepared}
          onCleared={server.clearPrepared}
          onSave={saveSettings}
          onOpenTranslation={() => openSettings("translation")}
          onOpenSetup={() => openSettings("cs2")}
        />
        <QuickComm settings={app.settings} onSave={saveSettings} onPick={(text) => setQuick((q) => ({ text, seq: (q?.seq ?? 0) + 1 }))} />
        </>
        }
      />
      <SettingsDialog
        open={settingsOpen}
        tab={settingsTab}
        onTab={setSettingsTab}
        onClose={() => setSettingsOpen(false)}
        app={app}
        onSave={saveSettings}
        onRefresh={server.resync}
      />
      <Toasts
        toasts={view.toasts}
        onDismiss={server.dismissToast}
      />
    </div>
  );
}

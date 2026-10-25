import { useState } from "react";
import type { InstallCandidate } from "@shared/protocol";
import { useI18n, type MessageKey } from "../../i18n";
import { api, ApiError } from "../../lib/api";
import { Section, Status, TextField, type TabProps } from "./fields";

function formatTime(ms: number, locale: string): string {
  return new Date(ms).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Auto mode: detected installs (with a chooser when there are several) + "detect again".
 * Manual mode: native Windows file / folder dialogs; typing a path is an advanced fallback.
 */
export function PathsSection({ app, commit, errors, onRefresh }: TabProps) {
  const { t, locale } = useI18n();
  const cs2 = app.settings.cs2;
  const p = app.paths;
  const manual = p.mode === "manual";
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setMessage({ ok: false, text: t(code === "dialog-open" ? "cs2.paths.dialogOpen" : "cs2.paths.pickFailed") });
    } finally {
      setBusy(null);
    }
  };

  const browse = (kind: "log" | "cfg") =>
    run(kind, async () => {
      const r = await api.pick(kind, t(kind === "log" ? "cs2.paths.dialogLog" : "cs2.paths.dialogCfg"));
      if (!r.path) return; // cancelled
      const ok = await commit(kind === "log" ? { cs2: { pathMode: "manual", logPath: r.path } } : { cs2: { pathMode: "manual", cfgDir: r.path } }, kind === "log" ? "cs2.logPath" : "cs2.cfgDir");
      if (ok && r.warning) setMessage({ ok: false, text: t(r.warning === "not-console-log" ? "cs2.paths.unusualName" : "cs2.paths.notFolder") });
      await onRefresh();
    });

  const switchMode = (mode: "auto" | "manual") => {
    if (mode === p.mode) return;
    // Switching to manual starts from what is in use now, so nothing becomes empty.
    void commit(mode === "manual" ? { cs2: { pathMode: "manual", logPath: cs2.logPath || p.logPath, cfgDir: cs2.cfgDir || p.cfgDir } } : { cs2: { pathMode: "auto" } }, "cs2.pathMode").then(() => onRefresh());
  };

  const choose = (c: InstallCandidate) => void commit({ cs2: { installDir: c.gameDir } }, "cs2.installDir").then(() => onRefresh());

  return (
    <Section title={t("cs2.paths.title")}>
      <fieldset className="setting">
        <legend className="sr-only">{t("cs2.paths.title")}</legend>
        {(["auto", "manual"] as const).map((m) => (
          <label key={m} className="check">
            <input type="radio" name="pathmode" checked={p.mode === m} onChange={() => switchMode(m)} />
            <span>{t(m === "auto" ? "cs2.paths.auto" : "cs2.paths.manual")}</span>
          </label>
        ))}
        <p className="muted help help--indent">{t(manual ? "cs2.paths.manualHelp" : "cs2.paths.autoHelp")}</p>
      </fieldset>

      {!manual && (
        <>
          {p.candidates.length === 0 && <p className="warn">{t("cs2.paths.none")}</p>}
          {p.candidates.length > 1 && (
            <fieldset className="setting candidates">
              <legend className="setting-label">{t("cs2.paths.candidates")}</legend>
              {p.needsChoice && <p className="warn help">{t("cs2.paths.needsChoice")}</p>}
              {p.candidates.map((c) => (
                <label key={c.gameDir} className="check candidate">
                  <input type="radio" name="install" checked={c.selected && !p.needsChoice} onChange={() => choose(c)} />
                  <span>
                    <code className="path">{c.gameDir}</code>
                    <span className="muted help">
                      {c.logModifiedAt ? t("cs2.paths.modified", { time: formatTime(c.logModifiedAt, locale) }) : t("cs2.paths.noLogYet")}
                      {c.selected && p.needsChoice ? " ←" : ""}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
        </>
      )}

      <PathRow
        label={t("cs2.paths.log")}
        path={p.logPath}
        status={<Status ok={p.logExists}>{p.logExists ? t("cs2.logStatus.ok") : t("cs2.logStatus.missing")}</Status>}
        extra={p.logNameUnusual ? <span className="warn help">{t("cs2.paths.unusualName")}</span> : null}
        browse={manual ? { label: t("cs2.paths.browseLog"), onClick: () => void browse("log"), busy: busy === "log", enabled: p.canBrowse } : null}
      />
      <PathRow
        label={t("cs2.paths.cfg")}
        path={p.cfgDir}
        status={
          <Status ok={p.cfgDirExists && p.cfgDirWritable}>
            {p.cfgDirExists && p.cfgDirWritable ? t("cs2.cfgStatus.ok") : p.cfgDirExists ? t("cs2.cfgStatus.bad") : t("cs2.paths.notFound")}
          </Status>
        }
        browse={manual ? { label: t("cs2.paths.browseCfg"), onClick: () => void browse("cfg"), busy: busy === "cfg", enabled: p.canBrowse } : null}
      />
      {manual && !p.canBrowse && <p className="muted help">{t("cs2.paths.noBrowse")}</p>}
      {message && (
        <p className={message.ok ? "ok" : "alert"} role="status">
          {message.text}
        </p>
      )}

      <div className="row">
        <button type="button" className="btn" disabled={busy !== null} onClick={() => void run("redetect", async () => { await api.redetect(); await onRefresh(); })}>
          {t("cs2.paths.redetect")}
        </button>
      </div>

      {manual && (
        <details className="advanced">
          <summary>{t("cs2.paths.typePath")}</summary>
          <TextField label={t("cs2.paths.log")} value={cs2.logPath} mono error={errors["cs2.logPath"]} onCommit={(v) => void commit({ cs2: { pathMode: "manual", logPath: v } }, "cs2.logPath").then(() => onRefresh())} />
          <TextField label={t("cs2.paths.cfg")} value={cs2.cfgDir} mono error={errors["cs2.cfgDir"]} onCommit={(v) => void commit({ cs2: { pathMode: "manual", cfgDir: v } }, "cs2.cfgDir").then(() => onRefresh())} />
        </details>
      )}
    </Section>
  );
}

function PathRow({
  label,
  path,
  status,
  extra,
  browse,
}: {
  label: string;
  path: string;
  status: React.ReactNode;
  extra?: React.ReactNode;
  browse: { label: string; onClick: () => void; busy: boolean; enabled: boolean } | null;
}) {
  const { t } = useI18n();
  return (
    <div className="setting">
      <span className="setting-label">{label}</span>
      <div className="pathrow">
        <code className="path" title={path}>
          {path || t("cs2.paths.notFound" as MessageKey)}
        </code>
        {browse && (
          <button type="button" className="btn" disabled={!browse.enabled || browse.busy} onClick={browse.onClick}>
            {browse.label}
          </button>
        )}
      </div>
      <div className="row row--tight">
        {status}
        {extra}
      </div>
    </div>
  );
}

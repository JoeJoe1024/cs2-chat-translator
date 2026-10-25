import { useEffect, useMemo, useRef, useState } from "react";
import type { SettingsPatch } from "../../../src/config/schema";
import type { AppState, CfgPrepared } from "@shared/protocol";
import { encodeMessage } from "@shared/cfgEncode";
import { EngineSelect } from "./EngineSelect";
import { LanguageOptions } from "./LanguageOptions";
import { hasKey, useI18n, type MessageKey } from "../i18n";
import { api, ApiError } from "../lib/api";
import { nextClick } from "../lib/clock";

const MAX_CHARS = 500;

type Mode = "translate" | "direct";

type Props = {
  app: AppState;
  prepared: CfgPrepared | null;
  onPrepared: (cfg: CfgPrepared) => void;
  onCleared: () => void;
  onSave: (patch: SettingsPatch) => Promise<unknown>;
  onOpenTranslation: () => void;
  onOpenSetup: () => void;
  /** A quick phrase picked in the Quick talk card: translated and prepared through this component's own flow. */
  quick?: { text: string; seq: number } | null;
};

function errorKey(err: unknown): string {
  if (!(err instanceof ApiError)) return "error.generic";
  return `error.${err.code.replace(/^translation-/, "")}`;
}

/**
 * Two ways to say something, one send key, ONE prepared message.
 *  - "Translate, then send" and "Send as typed" keep separate drafts; switching never clears either.
 *  - Only the buttons here prepare anything. Editing, switching mode or a finished background translation never touches
 *    the prepared message, and the card below always shows exactly what is prepared and how it was made.
 *  - Each click carries its own time, so a slow older translation cannot replace a newer message.
 */
export function Composer({ app, prepared, onPrepared, onCleared, onSave, onOpenTranslation, onOpenSetup, quick }: Props) {
  const { t } = useI18n();
  const settings = app.settings;
  const [mode, setMode] = useState<Mode>("translate");
  const [drafts, setDrafts] = useState<Record<Mode, string>>({ translate: "", direct: "" });
  const [target, setTarget] = useState(settings.translation.sendTargetLanguage);
  const [channel, setChannel] = useState<"all" | "team">("all");
  const [preview, setPreview] = useState<{ source: string; text: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<Mode, boolean>>({ translate: false, direct: false });
  const [error, setError] = useState<string | null>(null);

  // Follow the saved target language when it changes elsewhere (adjusting state during render, per React guidance).
  const savedTarget = settings.translation.sendTargetLanguage;
  const [seenTarget, setSeenTarget] = useState(savedTarget);
  if (seenTarget !== savedTarget) {
    setSeenTarget(savedTarget);
    setTarget(savedTarget);
  }

  // Quick phrases never touch the drafts. Latest pick wins: an older, slower translation is dropped.
  const [quickBusy, setQuickBusy] = useState<string | null>(null);
  const latestQuick = useRef(0);

  const draft = drafts[mode];
  const setDraft = (value: string) => setDrafts((d) => ({ ...d, [mode]: value }));
  const translatedPreview = preview && preview.source === drafts.translate ? preview.text : null;
  const directLines = useMemo(() => encodeMessage(drafts.direct), [drafts.direct]);

  const engine = settings.translation.sendEngine;
  const keyOk = settings.secrets.geminiKeyConfigured;
  const fallback = engine === "gemini" && !keyOk;

  const fail = (err: unknown) => {
    const key = errorKey(err);
    setError(hasKey(key) ? t(key) : t("error.generic"));
  };
  const working = (m: Mode, on: boolean) => setBusy((b) => ({ ...b, [m]: on }));

  async function translateText(source: string): Promise<{ text: string; same: boolean }> {
    const res = await api.translate(source, target);
    if (res.status === "done") return { text: res.text, same: false };
    // Nothing to translate (numbers, already in the target language): send the original text as it is.
    return { text: res.text || source.trim(), same: res.reason === "same-language" };
  }

  async function translate(): Promise<string> {
    const { text, same } = await translateText(drafts.translate);
    setNote(same ? t("composer.sameLanguage") : null);
    return text;
  }

  /** The newest prepare action. A failed translation withdraws the prepared message only if nothing newer happened. */
  const latestClick = useRef(0);
  async function dropStale(clickedAt: number) {
    // The key must not send an OLDER message after the one the user just asked for failed to translate.
    if (latestClick.current !== clickedAt) return;
    try {
      await api.clearPrepared();
      onCleared();
    } catch {
      /* nothing more can be done; the error is already shown */
    }
  }

  async function runQuick(source: string, seq: number) {
    latestQuick.current = seq;
    const clickedAt = nextClick();
    latestClick.current = clickedAt;
    setQuickBusy(source);
    setError(null);
    let text: string;
    try {
      ({ text } = await translateText(source));
    } catch (err) {
      if (latestQuick.current === seq) {
        fail(err);
        await dropStale(clickedAt);
        setQuickBusy(null);
      }
      return;
    }
    try {
      if (latestQuick.current !== seq) return; // a newer pick replaced this one
      const res = await api.prepareCfg(text, channel, "translated", clickedAt, source.trim());
      if (latestQuick.current !== seq) return;
      onPrepared(res.prepared);
    } catch (err) {
      if (latestQuick.current === seq) fail(err);
    } finally {
      if (latestQuick.current === seq) setQuickBusy(null);
    }
  }

  const handledQuick = useRef(quick?.seq ?? 0);
  useEffect(() => {
    if (!quick || quick.seq === handledQuick.current) return;
    handledQuick.current = quick.seq;
    void runQuick(quick.text, quick.seq);
    // runQuick reads the channel / target at the moment of the pick, which is exactly when this effect runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quick]);

  async function runTranslate(action: "preview" | "prepare") {
    const source = drafts.translate;
    if (!source.trim() || busy.translate) return;
    const clickedAt = nextClick(); // the moment of the click, not of the answer
    if (action === "prepare") latestClick.current = clickedAt;
    working("translate", true);
    setError(null);
    setNote(null);
    let text: string;
    try {
      text = await translate();
    } catch (err) {
      fail(err);
      if (action === "prepare") await dropStale(clickedAt);
      working("translate", false);
      return;
    }
    try {
      setPreview({ source, text });
      if (action === "prepare") onPrepared((await api.prepareCfg(text, channel, "translated", clickedAt, source.trim())).prepared);
    } catch (err) {
      fail(err);
    } finally {
      working("translate", false);
    }
  }

  async function prepareEdited() {
    if (!translatedPreview?.trim() || busy.translate) return;
    const clickedAt = nextClick();
    latestClick.current = clickedAt;
    working("translate", true);
    setError(null);
    try {
      onPrepared((await api.prepareCfg(translatedPreview, channel, "translated", clickedAt, drafts.translate.trim())).prepared);
    } catch (err) {
      fail(err);
    } finally {
      working("translate", false);
    }
  }

  async function prepareDirect() {
    const text = drafts.direct.trim();
    if (!text || busy.direct) return;
    const clickedAt = nextClick();
    latestClick.current = clickedAt;
    working("direct", true);
    setError(null);
    try {
      // No translation request of any kind: the text goes straight to the safe cfg writer.
      onPrepared((await api.prepareCfg(text, channel, "direct", clickedAt)).prepared);
    } catch (err) {
      fail(err);
    } finally {
      working("direct", false);
    }
  }

  async function clear() {
    setError(null);
    try {
      await api.clearPrepared();
      onCleared();
    } catch (err) {
      fail(err);
    }
  }

  return (
    <section className="composer" aria-labelledby="composer-title">
      <div className="panel-head">
        <h2 id="composer-title">{t("composer.title")}</h2>
      </div>

      <fieldset className="field segmented segmented--full">
        <legend className="sr-only">{t("composer.mode.label")}</legend>
        {(["translate", "direct"] as const).map((m) => (
          <label key={m} className={mode === m ? "seg seg--on" : "seg"}>
            <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
            {t(m === "translate" ? "composer.mode.translate" : "composer.mode.direct")}
          </label>
        ))}
      </fieldset>

      <label className="field box">
        <span className="sr-only">{t("composer.title")}</span>
        <textarea
          value={draft}
          maxLength={MAX_CHARS}
          rows={3}
          placeholder={t(mode === "translate" ? "composer.placeholder" : "composer.direct.placeholder")}
          dir="auto"
          onChange={(e) => {
            setDraft(e.target.value);
            if (mode === "translate") setPreview(null);
          }}
          onKeyDown={(e) => {
            // Enter prepares (never sends: the player still presses the game key); Shift+Enter is a new line.
            if (e.key !== "Enter" || e.shiftKey) return;
            // Chinese / Japanese / Korean input methods use Enter to confirm composed text: leave it to them.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            e.preventDefault();
            void (mode === "translate" ? runTranslate("prepare") : prepareDirect()); // both ignore empty text and a running request
          }}
        />
        <span className="muted counter">
          {t("composer.enterHint")} · {t("composer.counter", { n: draft.length })}
        </span>
      </label>

      {/* Channel always; target language only matters when translating (its saved value is kept either way). */}
      <div className="row row--center">
        <fieldset className="field segmented">
          <legend className="sr-only">{t("composer.channel")}</legend>
          {(["all", "team"] as const).map((c) => (
            <label key={c} className={channel === c ? "seg seg--on" : "seg"}>
              <input type="radio" name="channel" value={c} checked={channel === c} onChange={() => setChannel(c)} />
              {t(`composer.channel.${c}` as MessageKey)}
            </label>
          ))}
        </fieldset>
        {mode === "translate" && (
          <label className="inline grow">
            <span>{t("composer.target")}</span>
            <select
              value={target}
              onChange={(e) => {
                setTarget(e.target.value);
                setPreview(null);
                void onSave({ translation: { sendTargetLanguage: e.target.value } });
              }}
            >
              <LanguageOptions engine={engine} />
            </select>
          </label>
        )}
      </div>

      {mode === "translate" && fallback && (
        <p className="muted help">
          {t("tr.needKey")}{" "}
          <button type="button" className="link" onClick={onOpenTranslation}>
            {t("tr.needKeyOpen")}
          </button>
        </p>
      )}

      {mode === "translate" && translatedPreview !== null && (
        <label className="field">
          <span>{t("composer.preview")}</span>
          <textarea value={translatedPreview} rows={2} maxLength={1000} dir="auto" onChange={(e) => setPreview({ source: drafts.translate, text: e.target.value })} />
        </label>
      )}

      {mode === "direct" && directLines.lines.length > 0 && (
        <div className="field">
          <span>{t("composer.direct.preview")}</span>
          <ol className="lines lines--preview" data-testid="direct-preview">
            {directLines.lines.map((l, i) => (
              <li key={i} dir="auto">
                {l}
              </li>
            ))}
          </ol>
          {directLines.truncated && <p className="alert">{t("composer.ready.truncated", { n: directLines.lines.length })}</p>}
        </div>
      )}

      {note && mode === "translate" && <p className="muted">{note}</p>}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <div className="row row--center actions">
        {mode === "translate" ? (
          <>
            <EngineSelect value={engine} label={t("tr.sendEngine")} className="" onChange={(v) => void onSave({ translation: { sendEngine: v } })} />
            <span className="spacer" />
            <button type="button" className="btn btn--ghost" disabled={busy.translate || !drafts.translate.trim()} onClick={() => void runTranslate("preview")}>
              {t("composer.translateOnly")}
            </button>
            {translatedPreview !== null && (
              <button type="button" className="btn btn--ghost" disabled={busy.translate || !translatedPreview.trim()} onClick={() => void prepareEdited()}>
                {t("composer.prepareEdited")}
              </button>
            )}
            <button type="button" className="btn btn--primary" disabled={busy.translate || !drafts.translate.trim()} onClick={() => void runTranslate("prepare")}>
              {busy.translate ? t("composer.working") : t("composer.prepare")}
            </button>
          </>
        ) : (
          <>
            <span className="spacer" />
            <button type="button" className="btn btn--primary" disabled={busy.direct || !drafts.direct.trim()} onClick={() => void prepareDirect()}>
              {busy.direct ? t("composer.working") : t("composer.direct.prepare")}
            </button>
          </>
        )}
      </div>

      {quickBusy && (
        <p className="muted" role="status" aria-busy="true">
          {t("quick.preparing", { text: quickBusy })}
        </p>
      )}
      <PreparedCard prepared={prepared} bindKey={settings.cs2.bindKey} onClear={() => void clear()} onSetup={onOpenSetup} />
    </section>
  );
}

function PreparedCard({ prepared, bindKey, onClear, onSetup }: { prepared: CfgPrepared | null; bindKey: string; onClear: () => void; onSetup: () => void }) {
  const { t } = useI18n();
  // Nothing prepared: no explanatory block, just a quiet way to the one-time setup.
  if (!prepared) {
    return (
      <button type="button" className="link link--quiet" onClick={onSetup}>
        {t("composer.setup")}
      </button>
    );
  }
  const badge = prepared.mode === "translated" ? "composer.mode.translated" : "composer.mode.directBadge";
  return (
    <div className="ready" role="status" data-testid="prepared-card">
      <div className="ready-head">
        <span className="ready-title">✓ {t("composer.ready.title")}</span>
        <span className={`badge badge--${prepared.mode}`}>{t(badge as MessageKey)}</span>
        <span>{t(prepared.channel === "team" ? "composer.ready.team" : "composer.ready.all")}</span>
        <span className="spacer" />
        <button type="button" className="btn btn--small btn--ghost" onClick={onClear}>
          {t("composer.clear")}
        </button>
      </div>
      <p className="ready-text" dir="auto">
        {prepared.lines.join(" ")}
      </p>
      <p className="muted">
        {t("composer.ready.press")} <kbd>{bindKey.toUpperCase()}</kbd> · {t("composer.ready.notSent")}
      </p>
      {prepared.truncated && <p className="alert">{t("composer.ready.truncated", { n: prepared.lines.length })}</p>}
    </div>
  );
}

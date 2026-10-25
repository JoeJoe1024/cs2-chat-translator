import { useCallback, useEffect, useId, useState } from "react";
import { hasKey, useI18n } from "../../i18n";
import { api, type GeminiModelsView } from "../../lib/api";
import { classifyGeminiModel, isRetiredGeminiModel, RECOMMENDED_GEMINI_MODEL, sortGeminiModels, suggestGeminiModel } from "@shared/gemini";
import { Row, Section, TextField, type TabProps } from "./fields";

const AI_STUDIO_KEYS = "https://aistudio.google.com/app/apikey";

export function GeminiSection({ app, commit, errors, onRefresh }: TabProps) {
  const { t, locale } = useI18n();
  const tr = app.settings.translation;
  const configured = app.settings.secrets.geminiKeyConfigured;
  const keyState = app.settings.secrets.geminiKeyState;
  const hasStored = keyState !== "missing"; // configured, or stored but unreadable here
  const keyId = useId();
  const modelId = useId();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [models, setModels] = useState<GeminiModelsView | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [modelMsg, setModelMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const reason = (code?: string) => {
    const k = `error.${code ?? "generic"}`;
    return hasKey(k) ? t(k) : t("error.generic");
  };

  const refresh = useCallback(async () => {
    setBusy("models");
    setListError(null);
    try {
      const r = await api.refreshGeminiModels();
      setModels(r);
      if (!r.ok) setListError(reason(r.code));
    } catch {
      setListError(t("error.generic"));
    } finally {
      setBusy(null);
    }
    // `reason` / `t` only read the current locale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale]);

  // Show the saved list immediately; refresh from Google once when a key exists but no list was ever loaded.
  useEffect(() => {
    let alive = true;
    void api.geminiModels().then((m) => {
      if (!alive) return;
      setModels(m);
      if (configured && m.fetchedAt === null) void refresh();
    });
    return () => {
      alive = false;
    };
  }, [configured, refresh]);

  const guard = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try {
      await fn();
    } catch {
      setKeyMsg({ ok: false, text: t("error.generic") });
    } finally {
      setBusy(null);
    }
  };

  // Whatever the server sent, only models that pass the shared translation rules are ever shown.
  const list = sortGeminiModels((models?.models ?? []).filter((m) => classifyGeminiModel(m.id)));
  const selectedListed = list.some((m) => m.id === tr.geminiModel);
  // A saved model that no longer passes the rules stays selected (it is the user's choice) but is flagged, never listed as a candidate.
  const retired = isRetiredGeminiModel(tr.geminiModel);
  const eligible = classifyGeminiModel(tr.geminiModel) !== null;
  const notListed = models !== null && models.fetchedAt !== null && !selectedListed;
  const flagged = !eligible || notListed;
  const suggestion = flagged ? suggestGeminiModel(list.length ? list.map((m) => m.id) : [RECOMMENDED_GEMINI_MODEL], tr.geminiModel) : null;
  const flagKey = retired ? "tr.gemini.modelRetired" : !eligible ? "tr.gemini.modelNotRecommended" : "tr.gemini.modelGone";
  const recommendedMissing = models !== null && models.fetchedAt !== null && !list.some((m) => m.id === RECOMMENDED_GEMINI_MODEL);
  const tagFor = (id: string) => {
    if (id === RECOMMENDED_GEMINI_MODEL) return t("tr.gemini.tag.recommended");
    const c = classifyGeminiModel(id);
    if (!c) return null;
    if (c.version < 3) return t("tr.gemini.tag.legacy");
    return t(c.tier === "lite" ? "tr.gemini.tag.lite" : "tr.gemini.tag.flash");
  };

  return (
    <Section title="Gemini">
      <Row label={t("tr.gemini.key")} htmlFor={keyId} help={app.secureStorage === "dpapi" ? t("tr.storage.dpapi") : t("tr.storage.memory")}>
        {keyState === "reenter" ? (
          <div className="notice-box" role="alert">
            <p className="alert">{t("tr.gemini.keyReenter")}</p>
            <p className="muted help">{t("tr.gemini.keyReenterHelp")}</p>
          </div>
        ) : (
          <p className={configured ? "ok" : "muted"}>{configured ? `✓ ${t("tr.gemini.keyConfigured")}` : t("tr.gemini.keyMissing")}</p>
        )}
        <input
          id={keyId}
          type="password"
          value={key}
          placeholder={hasStored ? t("tr.gemini.newKey") : t("tr.gemini.keyPlaceholder")}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setKey(e.target.value)}
        />
        <div className="row">
          <button
            type="button"
            className="btn"
            disabled={busy !== null || key.trim().length < 10}
            onClick={() =>
              void guard("save", async () => {
                await api.setGeminiKey(key.trim());
                setKey("");
                setKeyMsg(null);
                await onRefresh();
                await refresh();
              })
            }
          >
            {hasStored ? t("tr.gemini.replace") : t("tr.gemini.save")}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy !== null || !hasStored}
            onClick={() =>
              void guard("remove", async () => {
                await api.clearGeminiKey();
                setKeyMsg(null);
                await onRefresh();
              })
            }
          >
            {t("tr.gemini.remove")}
          </button>
        </div>
        <p className="help">
          <a href={AI_STUDIO_KEYS} target="_blank" rel="noopener noreferrer">
            {t("tr.gemini.getKey")} ↗
          </a>
        </p>
        <p className="muted help">{t("tr.gemini.getKeyHelp")}</p>
        <p className="muted help">{t("tr.gemini.keySecret")}</p>
        <p className="muted help">{t("tr.gemini.shareNote")}</p>
        {keyMsg && (
          <p className={keyMsg.ok ? "ok" : "alert"} role="status">
            {keyMsg.text}
          </p>
        )}
      </Row>

      <Row label={t("tr.gemini.model")} htmlFor={modelId} error={errors["translation.geminiModel"]}>
        <div className="pathrow">
          <select
            id={modelId}
            value={tr.geminiModel}
            disabled={!configured && list.length === 0}
            onChange={(e) => {
              setModelMsg(null);
              void commit({ translation: { geminiModel: e.target.value } }, "translation.geminiModel");
            }}
          >
            {!selectedListed && (
              <option value={tr.geminiModel}>{!eligible ? t("tr.gemini.modelUnrecommended", { id: tr.geminiModel }) : models?.fetchedAt != null ? t("tr.gemini.modelUnlisted", { id: tr.geminiModel }) : tr.geminiModel}</option>
            )}
            {list.map((m) => (
              <option key={m.id} value={m.id}>
                {`${m.displayName === m.id ? m.id : m.displayName}${tagFor(m.id) ? ` — ${tagFor(m.id)}` : ""}`}
              </option>
            ))}
          </select>
          <button type="button" className="btn" disabled={busy !== null || !configured} onClick={() => void refresh()}>
            {busy === "models" ? t("tr.gemini.refreshing") : t("tr.gemini.refresh")}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null || !configured}
            onClick={() =>
              void guard("test", async () => {
                const r = await api.testGeminiKey(undefined, tr.geminiModel);
                setModelMsg({ ok: r.ok, text: r.ok ? t("tr.gemini.modelTestOk") : t("tr.gemini.testFail", { reason: reason(r.code) }) });
              })
            }
          >
            {t("tr.gemini.testModel")}
          </button>
        </div>
        {!configured && list.length === 0 && <p className="muted help">{t("tr.gemini.modelsNeedKey")}</p>}
        {configured && models && models.fetchedAt === null && !listError && busy !== "models" && <p className="muted help">{t("tr.gemini.modelsNone")}</p>}
        {models?.fetchedAt != null && (
          <p className="muted help">
            {t(models.live ? "tr.gemini.modelsLoaded" : "tr.gemini.modelsKnown", {
              n: list.length,
              time: new Date(models.fetchedAt).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }),
            })}
          </p>
        )}
        {models?.live && recommendedMissing && !flagged && <p className="muted help">{t("tr.gemini.recommendedMissing", { id: RECOMMENDED_GEMINI_MODEL })}</p>}
        {listError && (
          <p className="alert" role="alert">
            {t("tr.gemini.modelsFailed", { reason: listError })}
          </p>
        )}
        {flagged && (
          <p className="alert" role="alert">
            {t(flagKey, { id: tr.geminiModel })}{" "}
            {suggestion && (
              <button type="button" className="link" onClick={() => void commit({ translation: { geminiModel: suggestion } }, "translation.geminiModel")}>
                {t("tr.gemini.useSuggested", { id: suggestion })}
              </button>
            )}
          </p>
        )}
        {modelMsg && (
          <p className={modelMsg.ok ? "ok" : "alert"} role="status">
            {modelMsg.text}
          </p>
        )}
        <p className="muted help">{t("tr.gemini.modelNote")}</p>
      </Row>

      <details className="advanced">
        <summary>{t("cs2.advanced.title")}</summary>
        <TextField
          label={t("tr.gemini.modelId")}
          value={tr.geminiModel}
          mono
          help={t("tr.gemini.modelHelp")}
          error={errors["translation.geminiModel"]}
          onCommit={(v) => void commit({ translation: { geminiModel: v } }, "translation.geminiModel")}
        />
      </details>
    </Section>
  );
}

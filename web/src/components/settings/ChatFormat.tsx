import { useId } from "react";
import { GAME_LANGUAGE_IDS } from "@shared/gameLanguages";
import { useI18n, type MessageKey } from "../../i18n";
import { Row, TextField, type TabProps } from "./fields";

/** Automatic chat-format detection status, with manual tags / language override as the fallback. */
export function ChatFormat({ app, commit, errors }: TabProps) {
  const { t } = useI18n();
  const f = app.settings.cs2.chatFormat;
  const status = app.format;
  const overrideId = useId();

  return (
    <details className="advanced" open={f.mode === "manual" || undefined}>
      <summary>{t("cs2.advanced")}</summary>
      <fieldset className="setting">
        <legend className="setting-label">{t("cs2.format.mode")}</legend>
        {(["auto", "manual"] as const).map((m) => (
          <label key={m} className="check">
            <input type="radio" name="chatformat" checked={f.mode === m} onChange={() => void commit({ cs2: { chatFormat: { mode: m } } }, "cs2.chatFormat.mode")} />
            <span>{t(m === "auto" ? "cs2.format.auto" : "cs2.format.manual")}</span>
          </label>
        ))}
      </fieldset>

      {f.mode === "auto" ? (
        <>
          <p className="muted help">{t("cs2.format.autoHelp")}</p>
          <dl className="facts">
            <dt>{t("cs2.format.language")}</dt>
            <dd>
              {status.detectedLanguage ?? t("cs2.format.languageUnknown")}
              {status.evidence.length > 0 && <span className="muted"> ({status.evidence.map((e) => t(`cs2.format.source.${e.source}` as MessageKey)).join(", ")})</span>}
            </dd>
            <dd className="muted">{t(`cs2.format.templates.${status.templateSource}` as MessageKey)}</dd>
          </dl>
          <Row label={t("cs2.format.override")} htmlFor={overrideId} error={errors["cs2.chatFormat.gameLanguage"]}>
            <select id={overrideId} value={f.gameLanguage} onChange={(e) => void commit({ cs2: { chatFormat: { gameLanguage: e.target.value } } }, "cs2.chatFormat.gameLanguage")}>
              <option value="">{t("cs2.format.overrideAuto")}</option>
              {GAME_LANGUAGE_IDS.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </Row>
          <h4>{t("cs2.format.matched")}</h4>
          {status.matched.length === 0 ? (
            <p className="muted">{t("cs2.format.matchedNone")}</p>
          ) : (
            <ul className="plain">
              {status.matched.map((m) => (
                <li key={m.formatId}>
                  <code>{m.formatId}</code> × {m.count}
                </li>
              ))}
            </ul>
          )}
          {status.unrecognized.length > 0 && (
            <>
              <h4>{t("cs2.format.unrecognized")}</h4>
              <ul className="plain">
                {status.unrecognized.map((u) => (
                  <li key={u.tag}>
                    <code>[{u.tag}]</code> × {u.count}
                  </li>
                ))}
              </ul>
              <p className="muted help">{t("cs2.format.unrecognizedHelp")}</p>
            </>
          )}
        </>
      ) : (
        <>
          <p className="muted help">{t("cs2.format.tagHelp")}</p>
          <div className="row">
            {(["ct", "t", "all"] as const).map((k) => (
              <div className="grow" key={k}>
                <TextField
                  label={t(k === "ct" ? "cs2.format.tagCt" : k === "t" ? "cs2.format.tagT" : "cs2.format.tagAll")}
                  value={f.manual[k]}
                  mono
                  error={errors[`cs2.chatFormat.manual.${k}`]}
                  onCommit={(v) => void commit({ cs2: { chatFormat: { manual: { [k]: v } } } }, `cs2.chatFormat.manual.${k}`)}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </details>
  );
}

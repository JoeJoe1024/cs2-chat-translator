import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CHAT_FONT_DEFAULT, CHAT_FONT_MAX, CHAT_FONT_MIN } from "@shared/chatView";
import { NATIVE_NAMES, UI_LOCALES, uiLocaleName } from "@shared/uiLocales";
import { APP_VERSION } from "@shared/version";
import { useI18n, type MessageKey } from "../../i18n";
import { ChatFormat } from "./ChatFormat";
import { DictionarySection } from "./DictionarySection";
import { FilterSection } from "./FilterSection";
import { FirstUseSection } from "./FirstUseSection";
import { GeminiSection } from "./GeminiSection";
import { IdentitySection } from "./IdentitySection";
import { KeyCapture } from "./KeyCapture";
import { PathsSection } from "./PathsSection";
import { Check, LanguageSelect, Row, Section, TextField, type Commit, type TabProps } from "./fields";

export function GeneralTab({ app, commit, errors }: TabProps) {
  const { t, locale } = useI18n();
  const g = app.settings.general;
  const id = useId();
  return (
    <>
      <Row label={t("general.uiLanguage")} htmlFor={id} error={errors["general.uiLanguage"]}>
        <select id={id} value={g.uiLanguage} onChange={(e) => void commit({ general: { uiLanguage: e.target.value as typeof g.uiLanguage } }, "general.uiLanguage")}>
          <option value="auto">{t("general.uiLanguage.auto")}</option>
          {UI_LOCALES.map((code) => {
            // Named in the current interface language; the language's own name is added so a language chosen by
            // mistake can still be recognised.
            const name = uiLocaleName(code, locale);
            return (
              <option key={code} value={code}>
                {name === NATIVE_NAMES[code] ? name : `${name} — ${NATIVE_NAMES[code]}`}
              </option>
            );
          })}
        </select>
      </Row>
      <Check label={t("general.autoTranslate")} checked={g.autoTranslate} onChange={(v) => void commit({ general: { autoTranslate: v } }, "general.autoTranslate")} />
      <Check label={t("general.translateOwn")} checked={g.translateOwnMessages} onChange={(v) => void commit({ general: { translateOwnMessages: v } }, "general.translateOwnMessages")} />
    </>
  );
}

export function TranslationTab(props: TabProps) {
  const { t } = useI18n();
  const { app, commit } = props;
  const tr = app.settings.translation;
  const chatId = useId();
  const sendId = useId();

  const engineSelect = (id: string, value: "google" | "gemini", field: "chatEngine" | "sendEngine") => (
    <select id={id} value={value} onChange={(e) => void commit({ translation: { [field]: e.target.value as "google" | "gemini" } }, `translation.${field}`)}>
      <option value="google">{t("tr.engine.google")}</option>
      <option value="gemini">{t("tr.engine.gemini")}</option>
    </select>
  );

  return (
    <>
      <Section title={t("settings.tab.translation")}>
        <Row label={t("tr.chatEngine")} htmlFor={chatId}>
          {engineSelect(chatId, tr.chatEngine, "chatEngine")}
        </Row>
        <Row label={t("tr.sendEngine")} htmlFor={sendId} help={t("tr.googleNote")}>
          {engineSelect(sendId, tr.sendEngine, "sendEngine")}
        </Row>
        <LanguageSelect label={t("tr.chatTarget")} value={tr.chatTargetLanguage} onChange={(v) => void commit({ translation: { chatTargetLanguage: v } }, "translation.chatTargetLanguage")} />
        <LanguageSelect label={t("tr.sendTarget")} value={tr.sendTargetLanguage} onChange={(v) => void commit({ translation: { sendTargetLanguage: v } }, "translation.sendTargetLanguage")} />
      </Section>
      <GeminiSection {...props} />
      <DictionarySection {...props} />
      <FilterSection {...props} />
      <p className="muted help">{t("tr.privacy")}</p>
    </>
  );
}

export function Cs2Tab(props: TabProps) {
  const { t } = useI18n();
  const { app, commit, errors, onRefresh } = props;
  const cs2 = app.settings.cs2;

  return (
    <>
      <p className="muted">{t("cs2.launch")}</p>
      <PathsSection {...props} />
      <Section title={t("cs2.key.title")}>
        <KeyCapture
          current={cs2.bindKey}
          error={errors["cs2.bindKey"]}
          onApply={(bind) => commit({ cs2: { bindKey: bind } }, "cs2.bindKey")}
        />
      </Section>
      <FirstUseSection app={app} />
      <IdentitySection {...props} />
      <details className="advanced">
        <summary>{t("cs2.advanced.title")}</summary>
        <TextField
          label={t("cs2.cfgFile")}
          value={cs2.cfgFileName}
          mono
          help={t("cs2.cfgFileHelp")}
          error={errors["cs2.cfgFileName"]}
          onCommit={(v) => void commit({ cs2: { cfgFileName: v } }, "cs2.cfgFileName")}
        />
        <ChatFormat {...props} />
        <div className="row">
          <button type="button" className="btn" onClick={() => void import("../../lib/api").then(({ api }) => api.restartWatcher().then(onRefresh))}>
            {t("cs2.restart")}
          </button>
        </div>
      </details>
    </>
  );
}

export function AppearanceTab({ app, commit }: { app: TabProps["app"]; commit: Commit }) {
  const { t } = useI18n();
  const theme = app.settings.appearance.theme;
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const shown = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  return (
    <>
      <fieldset className="setting">
        <legend className="setting-label">{t("appearance.theme")}</legend>
        <div className="theme-cards">
          {(["system", "light", "dark"] as const).map((k) => (
            <label key={k} className={`theme-card theme-card--${k}${theme === k ? " theme-card--on" : ""}`}>
              <input type="radio" name="theme" checked={theme === k} onChange={() => void commit({ appearance: { theme: k } }, "appearance.theme")} />
              <span className="swatch" aria-hidden="true" />
              <span>{t(`appearance.${k}` as MessageKey)}</span>
            </label>
          ))}
        </div>
        <p className="muted help">{t("appearance.current", { theme: t(`appearance.${shown}` as MessageKey) })}</p>
      </fieldset>
      <ChatFontSetting saved={app.settings.appearance.chatFontSize} commit={commit} />
    </>
  );
}

function ChatFontSetting({ saved, commit }: { saved: number; commit: Commit }) {
  const { t } = useI18n();
  const [value, setValue] = useState(saved);
  const timer = useRef<number | undefined>(undefined);
  // Follow the saved value when it changes elsewhere (the A−/A+ buttons in the chat header, a reset).
  const [seen, setSeen] = useState(saved);
  if (seen !== saved) {
    setSeen(saved);
    setValue(saved);
  }
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const change = (n: number) => {
    setValue(n);
    window.clearTimeout(timer.current);
    // Dragging fires once per step; send the settled value only.
    timer.current = window.setTimeout(() => void commit({ appearance: { chatFontSize: n } }, "appearance.chatFontSize"), 120);
  };
  const reset = () => {
    window.clearTimeout(timer.current);
    setValue(CHAT_FONT_DEFAULT);
    void commit({ appearance: { chatFontSize: CHAT_FONT_DEFAULT } }, "appearance.chatFontSize");
  };

  return (
    <div className="setting">
      <label className="setting-label" htmlFor="chat-font-size">
        {t("appearance.chatFont")}
      </label>
      <div className="fontrow">
        <input id="chat-font-size" type="range" min={CHAT_FONT_MIN} max={CHAT_FONT_MAX} step={1} value={value} onChange={(e) => change(Number(e.target.value))} />
        <output htmlFor="chat-font-size" className="fontvalue">
          {value}px
        </output>
        <button type="button" className="btn btn--small" onClick={reset} disabled={value === CHAT_FONT_DEFAULT && saved === CHAT_FONT_DEFAULT}>
          {t("appearance.chatFontReset")}
        </button>
      </div>
      <p className="fontsample" style={{ fontSize: `${value}px` }} dir="auto">
        {t("appearance.chatFontSample")}
      </p>
      <p className="muted help">{t("appearance.chatFontHelp")}</p>
    </div>
  );
}

export const GITHUB_URL = "https://github.com/JoeJoe1024/cs2-chat-translator";
export const JOELUCKY_URL = "https://joelucky.io";
export const SUPPORT_EMAIL = "support@joelucky.io";

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export function AboutTab() {
  const { t } = useI18n();
  return (
    <div className="about">
      <header>
        <h3 className="about-name">CS2 Chat Translator</h3>
        <p className="muted">{t("general.about", { v: APP_VERSION })}</p>
        <p>{t("about.tagline")}</p>
      </header>

      <dl className="about-facts">
        <dt>{t("about.developer")}</dt>
        <dd>{t("about.developerName")}</dd>
      </dl>

      <section>
        <h4 className="about-h">{t("about.story.title")}</h4>
        <p>{t("about.story")}</p>
      </section>

      <section>
        <h4 className="about-h">{t("about.license.title")}</h4>
        <ul className="about-tags">
          <li>{t("about.license.free")}</li>
          <li>{t("about.license.noCommercial")}</li>
        </ul>
        <p className="muted help">{t("about.license.note")}</p>
        <p>
          <ExternalLink href={`${GITHUB_URL}/blob/main/LICENSE`}>LICENSE</ExternalLink> ·{" "}
          <ExternalLink href={`${GITHUB_URL}/blob/main/STREAMING_PERMISSION.md`}>STREAMING_PERMISSION</ExternalLink>
        </p>
      </section>

      <section>
        <h4 className="about-h">{t("about.links")}</h4>
        <p>
          <ExternalLink href={GITHUB_URL}>GitHub</ExternalLink>
        </p>
        <p>
          <ExternalLink href={JOELUCKY_URL}>{t("about.joelucky")}</ExternalLink>
        </p>
        <p>
          {t("about.contact")}: <a className="link" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </p>
        <p className="muted help">{t("about.contactNote")}</p>
      </section>

      <section>
        <h4 className="about-h">{t("about.star.title")}</h4>
        <p>
          {t("about.star.text")}{" "}
          <ExternalLink href={GITHUB_URL}>{t("about.star.link")}</ExternalLink>
        </p>
      </section>
    </div>
  );
}

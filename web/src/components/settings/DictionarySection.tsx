import { useId, useMemo, useState } from "react";
import { BUILTIN_ENTRIES, type BuiltinEntry } from "@shared/glossaryData";
import { Glossary, validateCustomEntry, type CustomEntry } from "@shared/glossary";
import { languageName } from "@shared/languages";
import { LanguageOptions } from "../LanguageOptions";
import { useI18n, type MessageKey } from "../../i18n";
import { Check, Section, type TabProps } from "./fields";

const newId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

interface Form {
  id?: string;
  term: string;
  translation: string;
  lang: string;
}

const EMPTY: Form = { term: "", translation: "", lang: "*" };

/**
 * The one game-term dictionary: switch it on or off, try phrases, switch built-in terms off, and add or re-word terms.
 * Your wording always beats the built-in one, and every change applies immediately (the server drops old cached results).
 */
export function DictionarySection({ app, commit, errors }: TabProps) {
  const { t, locale } = useI18n();
  const d = app.settings.dictionary;
  const target = app.settings.translation.chatTargetLanguage;
  const glossary = useMemo(() => new Glossary(d), [d]);
  const tryId = useId();
  const searchId = useId();
  const [phrase, setPhrase] = useState("");
  const [filter, setFilter] = useState("");
  const [form, setForm] = useState<Form>(EMPTY);
  const [formError, setFormError] = useState<string | null>(null);

  const saveCustom = (custom: CustomEntry[]) => commit({ dictionary: { custom } }, "dictionary.custom");
  const saveDisabled = (disabled: string[]) => commit({ dictionary: { disabled } }, "dictionary.disabled");

  const submit = async () => {
    const problem = validateCustomEntry(form.term, form.translation);
    if (problem) return setFormError(t(`dict.err.${problem === "no-words" ? "no-words" : problem}` as MessageKey));
    setFormError(null);
    const entry: CustomEntry = { id: form.id ?? newId(), term: form.term.trim(), translation: form.translation.trim(), lang: form.lang };
    // One wording per term and language: re-entering the same term replaces the older entry.
    const rest = d.custom.filter((c) => c.id !== entry.id && !(norm(c.term) === norm(entry.term) && c.lang === entry.lang));
    if (await saveCustom([...rest, entry])) setForm(EMPTY);
  };

  const wording = (b: BuiltinEntry): { text: string; local: boolean } => {
    const own = (b.tr as Record<string, string | undefined>)[target];
    return target === "en" ? { text: b.en, local: true } : own ? { text: own, local: true } : { text: b.en, local: false };
  };

  const builtins = BUILTIN_ENTRIES.filter((b) => {
    const q = norm(filter);
    return !q || b.terms.some((x) => x.includes(q)) || b.en.toLowerCase().includes(q);
  });

  const result = (() => {
    if (!phrase.trim()) return null;
    const local = glossary.translateLocally(phrase, target);
    if (local?.kind === "translated") return t("dict.result.local", { text: local.text });
    if (local?.kind === "known") return t("dict.result.known");
    const { tokens, found } = glossary.matches(phrase);
    if (found.length > 0 && found.reduce((n, m) => n + (m.to - m.from + 1), 0) === tokens.length) {
      return t("dict.result.noWording", { lang: languageName(target, locale) });
    }
    const p = glossary.protect(phrase, target);
    return p.changed ? t("dict.result.mixed", { text: p.payload }) : t("dict.result.plain");
  })();

  return (
    <Section title={t("dict.title")} hint={t("dict.help")}>
      <Check label={t("dict.enable")} checked={d.enabled} onChange={(v) => void commit({ dictionary: { enabled: v } }, "dictionary.enabled")} />

      <details className="advanced">
        <summary>{t("dict.manage")}</summary>

        <div className="setting">
          <label className="setting-label" htmlFor={tryId}>
            {t("dict.try")}
          </label>
          <input id={tryId} type="text" value={phrase} placeholder={t("dict.tryPlaceholder")} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" spellCheck={false} />
          {result && (
            <p className="help" role="status">
              {result}
            </p>
          )}
        </div>

        <h4>{t("dict.custom")}</h4>
        {d.custom.length === 0 ? (
          <p className="muted help">{t("dict.customNone")}</p>
        ) : (
          <ul className="dict-list">
            {d.custom.map((c) => (
              <li key={c.id}>
                <code>{c.term}</code>
                <span className="dict-arrow" aria-hidden="true">
                  →
                </span>
                <span dir="auto">{c.translation}</span>
                <span className="muted dict-lang">{c.lang === "*" ? t("dict.langAny") : languageName(c.lang, locale)}</span>
                <span className="spacer" />
                <button type="button" className="btn btn--small" onClick={() => { setForm({ id: c.id, term: c.term, translation: c.translation, lang: c.lang }); setFormError(null); }}>
                  {t("dict.edit")}
                </button>
                <button type="button" className="btn btn--small btn--ghost" onClick={() => void saveCustom(d.custom.filter((x) => x.id !== c.id))}>
                  {t("dict.delete")}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="dict-form">
          <label className="field">
            <span>{t("dict.term")}</span>
            <input type="text" value={form.term} maxLength={40} onChange={(e) => setForm({ ...form, term: e.target.value })} autoComplete="off" spellCheck={false} />
          </label>
          <label className="field grow">
            <span>{t("dict.translation")}</span>
            <input type="text" value={form.translation} maxLength={200} onChange={(e) => setForm({ ...form, translation: e.target.value })} autoComplete="off" />
          </label>
          <label className="field">
            <span>{t("dict.lang")}</span>
            <select value={form.lang} onChange={(e) => setForm({ ...form, lang: e.target.value })}>
              <option value="*">{t("dict.langAny")}</option>
              <LanguageOptions />
            </select>
          </label>
          <div className="row">
            <button type="button" className="btn btn--primary" onClick={() => void submit()}>
              {form.id ? t("dict.save") : t("dict.add")}
            </button>
            {form.id && (
              <button type="button" className="btn btn--ghost" onClick={() => { setForm(EMPTY); setFormError(null); }}>
                {t("dict.cancel")}
              </button>
            )}
          </div>
          {(formError || errors["dictionary.custom"]) && (
            <p className="alert" role="alert">
              {formError ?? errors["dictionary.custom"]}
            </p>
          )}
        </div>

        <h4>{t("dict.builtin")}</h4>
        <label className="sr-only" htmlFor={searchId}>
          {t("dict.search")}
        </label>
        <input id={searchId} type="text" value={filter} placeholder={t("dict.search")} onChange={(e) => setFilter(e.target.value)} autoComplete="off" spellCheck={false} />
        <ul className="dict-list dict-list--builtin">
          {builtins.map((b) => {
            const w = wording(b);
            const on = !d.disabled.includes(b.id);
            return (
              <li key={b.id} className={on ? "" : "dict-off"}>
                <label className="check">
                  <input type="checkbox" checked={on} onChange={() => void saveDisabled(on ? [...d.disabled, b.id] : d.disabled.filter((x) => x !== b.id))} aria-label={`${t("dict.on")}: ${b.terms.join(", ")}`} />
                </label>
                <code>{b.terms.join(", ")}</code>
                <span className="dict-arrow" aria-hidden="true">
                  →
                </span>
                <span dir="auto">
                  {w.text}
                  {!w.local && <span className="muted"> ({t("dict.noLocal")})</span>}
                </span>
                {b.ambiguous && (
                  <span className="badge" title={t("dict.ambiguous")}>
                    ?
                  </span>
                )}
                <span className="spacer" />
                <button
                  type="button"
                  className="btn btn--small btn--ghost"
                  onClick={() => {
                    setForm({ term: b.terms[0] ?? "", translation: w.local ? w.text : "", lang: target });
                    setFormError(null);
                  }}
                >
                  {t("dict.customize")}
                </button>
              </li>
            );
          })}
        </ul>
      </details>
    </Section>
  );
}

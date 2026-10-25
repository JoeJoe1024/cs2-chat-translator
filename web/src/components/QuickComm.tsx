import { useState } from "react";
import { categoriesOf, DEFAULT_PHRASES, isBuiltInPhraseId, PHRASE_CATEGORIES, type PhraseCategory } from "@shared/quickPhrases";
import type { SettingsPatch } from "../../../src/config/schema";
import { QUICK_LANGUAGES_MAX, QUICK_PHRASES_MAX } from "@shared/quick";
import type { PublicSettings } from "@shared/protocol";
import { localizedLanguageName } from "@shared/languages";
import { LanguageOptions } from "./LanguageOptions";
import { useI18n, type MessageKey } from "../i18n";

type Phrase = { id: string; text: string };
type Tab = "phrases" | "languages";

/** The built-in phrases in the current UI language. */
const builtIns = (t: (k: MessageKey) => string): Phrase[] => DEFAULT_PHRASES.map((p) => ({ id: p.id, text: t(`quick.def.${p.id}` as MessageKey) }));

const newId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Quick communication under the composer. A phrase is translated and prepared for the send key (never sent by itself); languages switch the SEND target. */
export function QuickComm({ settings, onSave, onPick }: { settings: PublicSettings; onSave: (patch: SettingsPatch) => Promise<unknown>; onPick: (text: string) => void }) {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState<Tab>("phrases");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [pick, setPick] = useState("");
  const [cat, setCat] = useState<PhraseCategory>("common");

  // `null` = the built-in list in the current UI language. The first edit turns it into a stored, editable list.
  const stored = settings.quick.phrases;
  const phrases: Phrase[] = stored ?? builtIns(t);
  const savePhrases = (next: Phrase[]) => void onSave({ quick: { phrases: next } });

  // Only the chosen category is shown; edits address the full list through each phrase's own index.
  const visible = phrases.map((p, i) => ({ p, i })).filter(({ p }) => categoriesOf(p.id).includes(cat));

  // Moving swaps with the neighbour that is visible in this category, so the order stays meaningful there.
  const move = (i: number, d: -1 | 1) => {
    const pos = visible.findIndex((v) => v.i === i);
    const other = visible[pos + d];
    if (!other) return;
    const next = [...phrases];
    [next[i], next[other.i]] = [next[other.i]!, next[i]!];
    savePhrases(next);
  };

  /** Back to the built-in set, but the user's own phrases are kept (after the built-ins). */
  const restore = () => {
    const mine = phrases.filter((p) => !isBuiltInPhraseId(p.id));
    void onSave({ quick: { phrases: mine.length === 0 ? null : [...builtIns(t), ...mine] } });
  };
  const edit = (i: number, text: string) => savePhrases(phrases.map((p, k) => (k === i ? { ...p, text } : p)));
  const add = () => {
    const text = draft.trim();
    if (!text || phrases.length >= QUICK_PHRASES_MAX) return;
    savePhrases([...phrases, { id: newId(), text }]); // your own phrases always appear under "common"
    setDraft("");
  };

  const langs = settings.quick.languages;
  const target = settings.translation.sendTargetLanguage;
  const saveLangs = (next: string[]) => void onSave({ quick: { languages: next } });

  return (
    <section className="quick" aria-labelledby="quick-title">
      <div className="panel-head">
        <h2 id="quick-title" className="quick-title">
          {t("quick.title")}
        </h2>
        <span className="spacer" />
        <button type="button" className="btn btn--ghost btn--small" aria-pressed={editing} onClick={() => setEditing((v) => !v)}>
          {editing ? t("quick.done") : t("quick.edit")}
        </button>
      </div>
      <div className="quick-tabs" role="tablist">
        {(["phrases", "languages"] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "tab tab--on" : "tab"} onClick={() => setTab(k)}>
            {t(`quick.tab.${k}` as MessageKey)}
          </button>
        ))}
      </div>

      {tab === "phrases" && (
        <div className="quick-body" role="tabpanel">
          <div className="cats" role="group" aria-label={t("quick.cat.label")}>
            {PHRASE_CATEGORIES.map((c) => (
              <button key={c} type="button" className={cat === c ? "cat cat--on" : "cat"} aria-pressed={cat === c} onClick={() => setCat(c)}>
                {t(`quick.cat.${c}` as MessageKey)}
              </button>
            ))}
          </div>
          {!editing && <p className="muted help">{t("quick.phrasesHint")}</p>}
          {visible.length === 0 && <p className="muted">{t("quick.empty")}</p>}
          {!editing ? (
            <div className="chips">
              {visible.map(({ p }) => (
                <button key={p.id} type="button" className="chipbtn" dir="auto" onClick={() => onPick(p.text)}>
                  {p.text}
                </button>
              ))}
            </div>
          ) : (
            <>
              <ul className="quick-edit">
                {visible.map(({ p, i }, pos) => (
                  <li key={p.id}>
                    <PhraseInput value={p.text} onCommit={(v) => edit(i, v)} />
                    <button type="button" className="btn btn--ghost btn--small" onClick={() => move(i, -1)} disabled={pos === 0} aria-label={t("quick.up")} title={t("quick.up")}>
                      ↑
                    </button>
                    <button type="button" className="btn btn--ghost btn--small" onClick={() => move(i, 1)} disabled={pos === visible.length - 1} aria-label={t("quick.down")} title={t("quick.down")}>
                      ↓
                    </button>
                    <button type="button" className="btn btn--ghost btn--small" onClick={() => savePhrases(phrases.filter((_, k) => k !== i))} aria-label={t("quick.delete")} title={t("quick.delete")}>
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
              {cat === "common" && (
              <div className="row">
                <input type="text" className="grow" value={draft} maxLength={120} placeholder={t("quick.addPlaceholder")} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
                <button type="button" className="btn btn--small" onClick={add} disabled={!draft.trim() || phrases.length >= QUICK_PHRASES_MAX}>
                  {t("quick.add")}
                </button>
              </div>
              )}
              <button type="button" className="link" onClick={restore}>
                {t("quick.restore")}
              </button>
            </>
          )}
        </div>
      )}

      {tab === "languages" && (
        <div className="quick-body" role="tabpanel">
          {!editing && <p className="muted help">{t("quick.langHint")}</p>}
          <div className="chips">
            {langs.map((c) => (
              <span key={c} className="chipgroup">
                <button type="button" className={c === target ? "chipbtn chipbtn--on" : "chipbtn"} aria-pressed={c === target} onClick={() => void onSave({ translation: { sendTargetLanguage: c } })}>
                  {localizedLanguageName(c, locale)}
                </button>
                {editing && (
                  <button type="button" className="chipx" aria-label={`${t("quick.langRemove")}: ${localizedLanguageName(c, locale)}`} onClick={() => saveLangs(langs.filter((x) => x !== c))}>
                    ✕
                  </button>
                )}
              </span>
            ))}
          </div>
          {editing &&
            (langs.length >= QUICK_LANGUAGES_MAX ? (
              <p className="muted help">{t("quick.langMax", { n: QUICK_LANGUAGES_MAX })}</p>
            ) : (
              <div className="row">
                <select className="grow" value={pick} aria-label={t("quick.langAdd")} onChange={(e) => setPick(e.target.value)}>
                  <option value="">{t("quick.langAdd")}…</option>
                  <LanguageOptions engine={settings.translation.sendEngine} />
                </select>
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={!pick || langs.includes(pick)}
                  onClick={() => {
                    saveLangs([...langs, pick]);
                    setPick("");
                  }}
                >
                  {t("quick.add")}
                </button>
              </div>
            ))}
        </div>
      )}
    </section>
  );
}

/** Edits locally and saves when leaving the field, so typing is never interrupted by a round trip. */
function PhraseInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setText(value);
  }
  const commit = () => {
    const v = text.trim();
    if (v && v !== value) onCommit(v);
    else setText(value);
  };
  return <input type="text" className="grow" value={text} maxLength={120} dir="auto" onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />;
}

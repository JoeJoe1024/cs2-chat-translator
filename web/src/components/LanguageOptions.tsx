import { useMemo } from "react";
import { COMMON_LANGUAGE_CODES, languagesFor, localizedLanguageName, type TranslationEngineId } from "@shared/languages";
import { useI18n } from "../i18n";

/**
 * The one list of translation languages: names follow the UI language, values stay the language codes the
 * translation engines use. Put inside a <select>; common languages first, then everything the engine supports.
 */
export function LanguageOptions({ engine = "google", extra }: { engine?: TranslationEngineId; extra?: { value: string; label: string } }) {
  const { t, locale } = useI18n();
  const { common, rest } = useMemo(() => {
    const collator = new Intl.Collator(locale);
    const named = languagesFor(engine).map((l) => ({ code: l.code, name: localizedLanguageName(l.code, locale) }));
    const isCommon = (c: string) => (COMMON_LANGUAGE_CODES as readonly string[]).includes(c);
    return {
      common: COMMON_LANGUAGE_CODES.map((c) => named.find((n) => n.code === c)).filter((n): n is NonNullable<typeof n> => !!n),
      rest: named.filter((n) => !isCommon(n.code)).sort((a, b) => collator.compare(a.name, b.name)),
    };
  }, [engine, locale]);
  return (
    <>
      {extra && <option value={extra.value}>{extra.label}</option>}
      <optgroup label={t("lang.common")}>
        {common.map((l) => (
          <option key={l.code} value={l.code}>
            {l.name}
          </option>
        ))}
      </optgroup>
      <optgroup label={t("lang.all")}>
        {rest.map((l) => (
          <option key={l.code} value={l.code}>
            {l.name}
          </option>
        ))}
      </optgroup>
    </>
  );
}

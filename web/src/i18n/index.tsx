import { createContext, useContext, useMemo, type ReactNode } from "react";
import { detectLocale, type UiLocale } from "@shared/uiLocales";
import { de } from "./de";
import { en, type MessageKey } from "./en";
import { es } from "./es";
import { fr } from "./fr";
import { ja } from "./ja";
import { ko } from "./ko";
import { pl } from "./pl";
import { ptBR } from "./pt-BR";
import { ru } from "./ru";
import { tr } from "./tr";
import { vi } from "./vi";
import { zhCN } from "./zh-CN";
import { zhTW } from "./zh-TW";

export type { UiLocale };
export type { MessageKey };

export const hasKey = (k: string): k is MessageKey => k in en;

export const DICTS: Record<UiLocale, Record<MessageKey, string>> = {
  en,
  "zh-TW": zhTW,
  "zh-CN": zhCN,
  ru,
  "pt-BR": ptBR,
  es,
  pl,
  tr,
  de,
  fr,
  ja,
  ko,
  vi,
};

/**
 * A fixed language is used as it is. `auto` follows the system's language preferences, in the person's own order
 * (Traditional Chinese regions to zh-TW, other Chinese to zh-CN, any Portuguese to pt-BR, no match: English).
 */
export function resolveLocale(pref: "auto" | UiLocale, languages: string | readonly string[]): UiLocale {
  if (pref !== "auto") return pref;
  return detectLocale(typeof languages === "string" ? [languages] : languages);
}

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

export function makeTranslator(locale: UiLocale): Translate {
  const dict = DICTS[locale];
  return (key, params) => {
    const template = dict[key] ?? en[key];
    return params ? template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`)) : template;
  };
}

const I18nContext = createContext<{ t: Translate; locale: UiLocale }>({ t: makeTranslator("en"), locale: "en" });

export function I18nProvider({ locale, children }: { locale: UiLocale; children: ReactNode }) {
  const value = useMemo(() => ({ t: makeTranslator(locale), locale }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);

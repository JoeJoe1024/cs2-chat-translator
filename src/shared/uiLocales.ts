import { localizedLanguageName } from "./languages";

/** The interface languages, in the order they are offered. Independent of the chat translation languages. */
export const UI_LOCALES = ["zh-TW", "en", "ru", "zh-CN", "pt-BR", "es", "pl", "tr", "de", "fr", "ja", "ko", "vi"] as const;
export type UiLocale = (typeof UI_LOCALES)[number];

/** What is stored: a fixed language, or "auto" = follow the system's language preferences. */
export const UI_LANGUAGES = ["auto", ...UI_LOCALES] as const;
export type UiLanguagePref = (typeof UI_LANGUAGES)[number];

/** Each language's own name, so a language switched to by mistake can still be recognised and switched back. */
export const NATIVE_NAMES: Record<UiLocale, string> = {
  "zh-TW": "繁體中文",
  en: "English",
  ru: "Русский",
  "zh-CN": "简体中文",
  "pt-BR": "Português (Brasil)",
  es: "Español",
  pl: "Polski",
  tr: "Türkçe",
  de: "Deutsch",
  fr: "Français",
  ja: "日本語",
  ko: "한국어",
  vi: "Tiếng Việt",
};

const SUPPORTED = new Set<string>(UI_LOCALES.map((l) => l.toLowerCase()));
const TRADITIONAL = new Set(["tw", "hk", "mo", "hant"]);

/** One language tag (e.g. `zh-HK`, `pt-PT`, `de-AT`) to a supported interface language, or null when there is none. */
export function matchLocale(tag: string): UiLocale | null {
  const parts = tag.trim().toLowerCase().replace(/_/g, "-").split("-");
  const lang = parts[0];
  if (!lang) return null;
  if (lang === "zh") {
    // Script and region decide: Taiwan / Hong Kong / Macau / Hant are Traditional, everything else Chinese is Simplified.
    if (parts.slice(1).some((p) => TRADITIONAL.has(p))) return "zh-TW";
    return "zh-CN";
  }
  if (lang === "pt") return "pt-BR"; // the only Portuguese we ship; closest for pt-PT as well
  return SUPPORTED.has(lang) ? (lang as UiLocale) : null;
}

/**
 * The first supported language in the person's preference order. No network, no IP or country guessing.
 * Nothing supported: English.
 */
export function detectLocale(preferences: readonly string[]): UiLocale {
  for (const tag of preferences) {
    const m = matchLocale(tag);
    if (m) return m;
  }
  return "en";
}

/** The name of an interface language written in the current interface language. */
export function uiLocaleName(code: UiLocale, inLocale: string): string {
  if (code === "pt-BR") {
    try {
      const n = new Intl.DisplayNames([inLocale], { type: "language", fallback: "none" }).of("pt-BR");
      if (n) return n;
    } catch {
      /* fall through */
    }
    return "Portuguese (Brazil)";
  }
  return localizedLanguageName(code, inLocale);
}

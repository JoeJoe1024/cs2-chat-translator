/** Translation target languages. `code` is the BCP-47-ish code accepted by Google Translate and Gemini prompts. */
export interface Language {
  code: string;
  name: string;
  native: string;
}

export const LANGUAGES: readonly Language[] = [
  { code: "af", name: "Afrikaans", native: "Afrikaans" },
  { code: "sq", name: "Albanian", native: "Shqip" },
  { code: "ar", name: "Arabic", native: "العربية" },
  { code: "hy", name: "Armenian", native: "Հայերեն" },
  { code: "az", name: "Azerbaijani", native: "Azərbaycanca" },
  { code: "be", name: "Belarusian", native: "Беларуская" },
  { code: "bn", name: "Bengali", native: "বাংলা" },
  { code: "bs", name: "Bosnian", native: "Bosanski" },
  { code: "bg", name: "Bulgarian", native: "Български" },
  { code: "ca", name: "Catalan", native: "Català" },
  { code: "zh-CN", name: "Chinese (Simplified)", native: "简体中文" },
  { code: "zh-TW", name: "Chinese (Traditional)", native: "繁體中文" },
  { code: "hr", name: "Croatian", native: "Hrvatski" },
  { code: "cs", name: "Czech", native: "Čeština" },
  { code: "da", name: "Danish", native: "Dansk" },
  { code: "nl", name: "Dutch", native: "Nederlands" },
  { code: "en", name: "English", native: "English" },
  { code: "et", name: "Estonian", native: "Eesti" },
  { code: "tl", name: "Filipino", native: "Filipino" },
  { code: "fi", name: "Finnish", native: "Suomi" },
  { code: "fr", name: "French", native: "Français" },
  { code: "ka", name: "Georgian", native: "ქართული" },
  { code: "de", name: "German", native: "Deutsch" },
  { code: "el", name: "Greek", native: "Ελληνικά" },
  { code: "gu", name: "Gujarati", native: "ગુજરાતી" },
  { code: "he", name: "Hebrew", native: "עברית" },
  { code: "hi", name: "Hindi", native: "हिन्दी" },
  { code: "hu", name: "Hungarian", native: "Magyar" },
  { code: "is", name: "Icelandic", native: "Íslenska" },
  { code: "id", name: "Indonesian", native: "Bahasa Indonesia" },
  { code: "ga", name: "Irish", native: "Gaeilge" },
  { code: "it", name: "Italian", native: "Italiano" },
  { code: "ja", name: "Japanese", native: "日本語" },
  { code: "kn", name: "Kannada", native: "ಕನ್ನಡ" },
  { code: "kk", name: "Kazakh", native: "Қазақша" },
  { code: "km", name: "Khmer", native: "ខ្មែរ" },
  { code: "ko", name: "Korean", native: "한국어" },
  { code: "ky", name: "Kyrgyz", native: "Кыргызча" },
  { code: "lo", name: "Lao", native: "ລາວ" },
  { code: "lv", name: "Latvian", native: "Latviešu" },
  { code: "lt", name: "Lithuanian", native: "Lietuvių" },
  { code: "mk", name: "Macedonian", native: "Македонски" },
  { code: "ms", name: "Malay", native: "Bahasa Melayu" },
  { code: "ml", name: "Malayalam", native: "മലയാളം" },
  { code: "mt", name: "Maltese", native: "Malti" },
  { code: "mr", name: "Marathi", native: "मराठी" },
  { code: "mn", name: "Mongolian", native: "Монгол" },
  { code: "my", name: "Myanmar (Burmese)", native: "မြန်မာ" },
  { code: "ne", name: "Nepali", native: "नेपाली" },
  { code: "no", name: "Norwegian", native: "Norsk" },
  { code: "fa", name: "Persian", native: "فارسی" },
  { code: "pl", name: "Polish", native: "Polski" },
  { code: "pt", name: "Portuguese", native: "Português" },
  { code: "pa", name: "Punjabi", native: "ਪੰਜਾਬੀ" },
  { code: "ro", name: "Romanian", native: "Română" },
  { code: "ru", name: "Russian", native: "Русский" },
  { code: "sr", name: "Serbian", native: "Српски" },
  { code: "si", name: "Sinhala", native: "සිංහල" },
  { code: "sk", name: "Slovak", native: "Slovenčina" },
  { code: "sl", name: "Slovenian", native: "Slovenščina" },
  { code: "es", name: "Spanish", native: "Español" },
  { code: "sw", name: "Swahili", native: "Kiswahili" },
  { code: "sv", name: "Swedish", native: "Svenska" },
  { code: "ta", name: "Tamil", native: "தமிழ்" },
  { code: "te", name: "Telugu", native: "తెలుగు" },
  { code: "th", name: "Thai", native: "ไทย" },
  { code: "tr", name: "Turkish", native: "Türkçe" },
  { code: "uk", name: "Ukrainian", native: "Українська" },
  { code: "ur", name: "Urdu", native: "اردو" },
  { code: "uz", name: "Uzbek", native: "Oʻzbekcha" },
  { code: "vi", name: "Vietnamese", native: "Tiếng Việt" },
  { code: "cy", name: "Welsh", native: "Cymraeg" },
];

const BY_LOWER = new Map(LANGUAGES.map((l) => [l.code.toLowerCase(), l]));

const ALIASES: Record<string, string> = {
  zh: "zh-CN",
  cn: "zh-CN",
  tw: "zh-TW",
  jp: "ja",
  kr: "ko",
  iw: "he",
  jw: "id",
  fil: "tl",
  nb: "no",
  nn: "no",
  br: "pt",
};

/** Normalises user input such as `zh_tw`, `ZH-tw`, `jp` into a supported code, or null. */
export function normalizeLanguageCode(input: string): string | null {
  const key = input.trim().toLowerCase().replace(/_/g, "-");
  if (!key) return null;
  const direct = BY_LOWER.get(key);
  if (direct) return direct.code;
  const alias = ALIASES[key];
  if (alias) return alias;
  const base = key.split("-")[0];
  if (base && base !== key) {
    const b = BY_LOWER.get(base);
    if (b) return b.code;
    const a = ALIASES[base];
    if (a) return a;
  }
  return null;
}

export function languageName(code: string, locale = "en"): string {
  return localizedLanguageName(code, locale);
}

/** Engines this app can translate with; both currently cover the whole list above. */
export type TranslationEngineId = "google" | "gemini";

export function languagesFor(_engine: TranslationEngineId): readonly Language[] {
  return LANGUAGES;
}

/** Shown first in language menus. */
export const COMMON_LANGUAGE_CODES = ["en", "zh-TW", "zh-CN", "ja", "ko", "es", "ru", "de", "fr", "pt", "ar", "tr"] as const;

// Intl has no "Traditional / Simplified" wording that reads naturally, and ICU names Filipino under "fil".
const NAME_OVERRIDES: Record<string, Record<string, string>> = {
  "zh-TW": { "zh-TW": "繁體中文", "zh-CN": "簡體中文" },
  "zh-CN": { "zh-TW": "繁体中文", "zh-CN": "简体中文" },
};
const INTL_CODE: Record<string, string> = { tl: "fil" };
const displayNames = new Map<string, Intl.DisplayNames | null>();

function displayNamesFor(locale: string): Intl.DisplayNames | null {
  let dn = displayNames.get(locale);
  if (dn === undefined) {
    try {
      dn = new Intl.DisplayNames([locale], { type: "language", fallback: "none" });
    } catch {
      dn = null;
    }
    displayNames.set(locale, dn);
  }
  return dn;
}

/**
 * The language's name in the UI language. English uses the curated names; other locales use Intl.DisplayNames with
 * a few overrides, and fall back to the English name (never blank, never the raw code) when Intl has no answer.
 */
export function localizedLanguageName(code: string, locale: string): string {
  const lang = BY_LOWER.get(code.toLowerCase());
  if (!lang) return code;
  if (locale === "en") return lang.name;
  const override = NAME_OVERRIDES[locale]?.[lang.code];
  if (override) return override;
  try {
    const name = displayNamesFor(locale)?.of(INTL_CODE[lang.code] ?? lang.code);
    if (name && name.toLowerCase() !== lang.code.toLowerCase()) return name;
  } catch {
    // fall through to the English name
  }
  return lang.name;
}

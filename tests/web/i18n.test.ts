import { describe, expect, it } from "vitest";
import { en } from "../../web/src/i18n/en";
import { DICTS, makeTranslator, resolveLocale } from "../../web/src/i18n";
import { UI_LANGUAGES, UI_LOCALES, NATIVE_NAMES, detectLocale, matchLocale, uiLocaleName } from "../../src/shared/uiLocales";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const SILENT = new Set(["chat.skipped.same-language", "chat.skipped.not-text", "chat.skipped.empty"]);
// Proper names that are the same in every language.
const NAMES = new Set(["app.title", "about.developerName"]);
const keys = Object.keys(en) as (keyof typeof en)[];
const others = UI_LOCALES.filter((l) => l !== "en");

describe("the 13 interface languages", () => {
  it("are exactly the planned set, each with a dictionary and its own name", () => {
    expect([...UI_LOCALES]).toEqual(["zh-TW", "en", "ru", "zh-CN", "pt-BR", "es", "pl", "tr", "de", "fr", "ja", "ko", "vi"]);
    expect([...UI_LANGUAGES]).toEqual(["auto", ...UI_LOCALES]);
    expect(Object.keys(DICTS).sort()).toEqual([...UI_LOCALES].sort());
    for (const l of UI_LOCALES) expect(NATIVE_NAMES[l].length).toBeGreaterThan(1);
  });

  it.each(others)("%s defines exactly the same keys as English", (locale) => {
    expect(Object.keys(DICTS[locale]).sort()).toEqual([...keys].sort());
  });

  it.each(others)("%s keeps the same {placeholders} in every string", (locale) => {
    for (const key of keys) expect(placeholders(DICTS[locale][key]), `${locale} ${key}`).toEqual(placeholders(en[key]));
  });

  it.each(others)("%s has no empty strings (except the silent ones) and no left-over English sentences", (locale) => {
    for (const key of keys) if (!SILENT.has(key)) expect(DICTS[locale][key].trim(), `${locale} ${key}`).not.toBe("");
    const untouched = keys.filter((k) => !SILENT.has(k) && !NAMES.has(k) && DICTS[locale][k] === en[k] && /[A-Za-z]{4,} [A-Za-z]{3,}/.test(en[k]));
    expect(untouched, locale).toEqual([]);
  });

  it("keeps the developer name and has all 24 quick phrases in every language", () => {
    for (const locale of UI_LOCALES) {
      expect(DICTS[locale]["about.developerName"]).toContain("JoeJoe1024");
      for (let i = 1; i <= 24; i++) expect(DICTS[locale][`quick.def.d${String(i).padStart(2, "0")}` as keyof typeof en].trim().length).toBeGreaterThan(1);
    }
  });

  it("interpolates parameters and leaves unknown ones visible", () => {
    expect(makeTranslator("zh-TW")("quick.langMax", { n: 6 })).toBe("最多 6 個語言。");
    expect(makeTranslator("de")("quick.langMax", { n: 6 })).toBe("Höchstens 6 Sprachen.");
    expect(makeTranslator("en")("chat.newMessages", { n: 3 })).toBe("3 new");
    expect(makeTranslator("en")("chat.newMessages")).toBe("{n} new");
  });
});

describe("choosing the interface language from the system", () => {
  it("maps Chinese by script and region, never sending Traditional users to Simplified", () => {
    for (const tag of ["zh-TW", "zh-HK", "zh-MO", "zh-Hant", "zh-Hant-TW", "zh_TW"]) expect(matchLocale(tag), tag).toBe("zh-TW");
    for (const tag of ["zh-CN", "zh-SG", "zh-Hans", "zh-Hans-CN", "zh"]) expect(matchLocale(tag), tag).toBe("zh-CN");
  });

  it("maps regional variants to the language we ship, and unsupported ones to nothing", () => {
    expect(["pt-BR", "pt-PT", "pt"].map(matchLocale)).toEqual(["pt-BR", "pt-BR", "pt-BR"]);
    expect(["de-AT", "fr-CA", "es-MX", "en-GB", "ja-JP", "ko-KR", "vi-VN", "pl-PL", "tr-TR", "ru-RU"].map(matchLocale)).toEqual(["de", "fr", "es", "en", "ja", "ko", "vi", "pl", "tr", "ru"]);
    expect(matchLocale("sv-SE")).toBeNull();
    expect(matchLocale("")).toBeNull();
  });

  it("follows the order of the person's preferences and falls back to English", () => {
    expect(detectLocale(["sv-SE", "de-DE", "en-US"])).toBe("de"); // first language we support, not just the first
    expect(detectLocale(["fr-FR", "zh-TW"])).toBe("fr");
    expect(detectLocale(["sv", "fi", "nb"])).toBe("en");
    expect(detectLocale([])).toBe("en");
  });

  it("a manual choice always wins over the system; only 'auto' follows it", () => {
    expect(resolveLocale("ja", ["de-DE"])).toBe("ja");
    expect(resolveLocale("en", "zh-TW")).toBe("en");
    expect(resolveLocale("auto", ["de-DE"])).toBe("de");
    expect(resolveLocale("auto", "zh-HK")).toBe("zh-TW");
    expect(resolveLocale("auto", "sw")).toBe("en");
  });

  it("names every interface language in the current interface language", () => {
    expect(uiLocaleName("de", "zh-TW")).toBe("德文");
    expect(uiLocaleName("zh-TW", "zh-TW")).toBe("繁體中文");
    expect(uiLocaleName("zh-CN", "zh-TW")).toBe("簡體中文");
    expect(uiLocaleName("ja", "en")).toBe("Japanese");
    expect(uiLocaleName("pt-BR", "en").toLowerCase()).toContain("portuguese");
    for (const code of UI_LOCALES) for (const inLocale of UI_LOCALES) expect(uiLocaleName(code, inLocale).trim().length, `${code} in ${inLocale}`).toBeGreaterThan(1);
  });
});

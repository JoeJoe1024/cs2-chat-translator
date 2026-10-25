import { describe, expect, it } from "vitest";
import { COMMON_LANGUAGE_CODES, LANGUAGES, localizedLanguageName, normalizeLanguageCode } from "../../src/shared/languages";
import { bucketOf, clampChatFont } from "../../src/shared/chatView";

describe("localized language names", () => {
  it("follow the UI language", () => {
    const zh = (c: string) => localizedLanguageName(c, "zh-TW");
    expect([zh("en"), zh("ja"), zh("ko"), zh("de"), zh("fr"), zh("ru"), zh("ar")]).toEqual(["英文", "日文", "韓文", "德文", "法文", "俄文", "阿拉伯文"]);
    expect([zh("zh-TW"), zh("zh-CN")]).toEqual(["繁體中文", "簡體中文"]);
    expect(["en", "ja", "ko", "zh-TW", "zh-CN"].map((c) => localizedLanguageName(c, "en"))).toEqual(["English", "Japanese", "Korean", "Chinese (Traditional)", "Chinese (Simplified)"]);
  });

  it("never yields a blank name or a raw code for any supported language, in either UI language", () => {
    for (const l of LANGUAGES) {
      for (const locale of ["en", "zh-TW", "xx-unknown"]) {
        const name = localizedLanguageName(l.code, locale);
        expect(name.trim(), `${l.code}/${locale}`).not.toBe("");
        expect(name.toLowerCase(), `${l.code}/${locale}`).not.toBe(l.code.toLowerCase());
      }
    }
  });

  it("keeps the translation codes untouched and the common list valid", () => {
    expect(normalizeLanguageCode("zh_tw")).toBe("zh-TW");
    expect(localizedLanguageName("zz", "zh-TW")).toBe("zz");
    for (const c of COMMON_LANGUAGE_CODES) expect(LANGUAGES.some((l) => l.code === c)).toBe(true);
  });
});

describe("chat view helpers", () => {
  it("team is ct/t only, all is all only, anything else is its own bucket", () => {
    expect(["ct", "t", "all", "spec"].map((c) => bucketOf(c as never))).toEqual(["team", "team", "all", "other"]);
  });
  it("clamps the font size to 12-24", () => {
    expect([clampChatFont(5), clampChatFont(15.4), clampChatFont(99)]).toEqual([12, 15, 24]);
  });
});

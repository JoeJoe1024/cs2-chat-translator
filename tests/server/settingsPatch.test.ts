import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergeSettings, settingsPatchSchema, settingsSchema, type Settings } from "../../src/config/schema";
import { bootApp, bootWeb, type Harness, type WebHarness } from "../fixtures/harness";

/** A settings object where EVERY field differs from its default, so any silent reset is visible. */
function customised(): Settings {
  return {
    general: { uiLanguage: "zh-TW", autoTranslate: false, translateOwnMessages: false, hideOwnMessages: true, smartFilter: false, translationCache: false },
    translation: { chatEngine: "gemini", sendEngine: "gemini", chatTargetLanguage: "ja", sendTargetLanguage: "de", geminiModel: "gemini-custom", staleAfterMs: 8000 },
    cs2: {
      pathMode: "manual",
      installDir: "D:/Steam/x/csgo",
      logPath: "D:/x/console.log",
      cfgDir: "D:/x/cfg",
      cfgFileName: "mine.cfg",
      bindKey: "f8",
      chatFormat: { mode: "manual", manual: { ct: "反恐小組", t: "恐怖份子", all: "所有人" }, gameLanguage: "tchinese" },
      selfNames: ["我", "Me"],
    },
    dictionary: { enabled: false, disabled: ["gg"], custom: [{ id: "c1", term: "nc", translation: "漂亮", lang: "zh-TW" }] },
    appearance: { theme: "dark", chatView: "split", chatFontSize: 19, rightPct: 33, rightCollapsed: true },
    quick: { phrases: [{ id: "x", text: "mine" }], languages: ["fr"] },
  };
}

describe("own-message options: defaults and saved choices", () => {
  it("a new user translates and shows their own lines (both options start unchecked)", () => {
    const fresh = settingsSchema.parse({});
    expect(fresh.general).toMatchObject({ translateOwnMessages: true, hideOwnMessages: false });
  });

  it("a settings file that already has the values is never reset to the defaults", () => {
    const saved = settingsSchema.parse({ general: { translateOwnMessages: false, hideOwnMessages: true } });
    expect(saved.general).toMatchObject({ translateOwnMessages: false, hideOwnMessages: true });
    const again = settingsSchema.parse(JSON.parse(JSON.stringify(saved)));
    expect(again.general).toMatchObject({ translateOwnMessages: false, hideOwnMessages: true });
    expect(settingsSchema.parse({ general: { translateOwnMessages: true } }).general.translateOwnMessages).toBe(true);
  });
});

describe("a partial settings update changes only what it names", () => {
  it("the patch schema adds no defaults", () => {
    for (const patch of [
      { cs2: { bindKey: "f8" } },
      { general: { autoTranslate: false } },
      { translation: { sendTargetLanguage: "ja" } },
      { cs2: { chatFormat: { mode: "manual" } } },
      { cs2: { chatFormat: { manual: { ct: "X" } } } },
      { dictionary: { enabled: false } },
      { appearance: { theme: "dark" } },
      {},
    ]) {
      expect(settingsPatchSchema.parse(patch)).toEqual(patch);
    }
  });

  it("still validates and normalises what it does contain", () => {
    expect(settingsPatchSchema.parse({ translation: { sendTargetLanguage: "zh_tw" } })).toEqual({ translation: { sendTargetLanguage: "zh-TW" } });
    expect(settingsPatchSchema.safeParse({ cs2: { bindKey: 'x" y' } }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ general: { smartFilter: "yes" } }).success).toBe(false);
  });

  it.each([
    ["general", { general: { autoTranslate: true } }],
    ["translation", { translation: { sendTargetLanguage: "fr" } }],
    ["cs2 key", { cs2: { bindKey: "kp_plus" } }],
    ["cs2 path", { cs2: { logPath: "E:/other/console.log" } }],
    ["chat format", { cs2: { chatFormat: { gameLanguage: "english" } } }],
    ["manual tag", { cs2: { chatFormat: { manual: { all: "ALL" } } } }],
    ["dictionary", { dictionary: { disabled: [] } }],
    ["theme", { appearance: { theme: "light" } }],
    ["chat view", { appearance: { chatView: "team" } }],
    ["chat font size", { appearance: { chatFontSize: 22 } }],
    ["right width", { appearance: { rightPct: 47.5 } }],
    ["right collapsed", { appearance: { rightCollapsed: false } }],
    ["quick languages", { quick: { languages: ["en", "ja"] } }],
    ["quick phrases", { quick: { phrases: [{ id: "a1", text: "hello" }] } }],
    ["restore quick phrases", { quick: { phrases: null } }],
    ["hide own messages", { general: { hideOwnMessages: true } }],
  ])("%s: every other setting survives, through the real parse + merge", (_name, rawPatch) => {
    const before = customised();
    const patch = settingsPatchSchema.parse(rawPatch);
    const after = mergeSettings(before, patch);
    const flatten = (o: unknown, prefix = ""): Record<string, unknown> =>
      o && typeof o === "object" && !Array.isArray(o)
        ? Object.entries(o).reduce((acc, [k, v]) => ({ ...acc, ...flatten(v, `${prefix}${k}.`) }), {})
        : { [prefix.slice(0, -1)]: o };
    const b = flatten(before);
    const a = flatten(after);
    const patched = flatten(rawPatch);
    for (const key of Object.keys(b)) {
      if (key in patched) expect(a[key], key).toEqual(patched[key]);
      else expect(a[key], `${key} must not change`).toEqual(b[key]);
    }
  });
});

describe("through the running service", () => {
  let h: Harness | WebHarness;
  afterEach(async () => {
    await h?.stop();
  });

  it("changing one setting never resets the others (paths, names, languages, dictionary)", async () => {
    const w = await bootWeb();
    h = w;
    const put = (body: unknown) =>
      fetch(w.base + "/api/settings", { method: "PUT", headers: { "x-cs2t-token": w.token, "content-type": "application/json" }, body: JSON.stringify(body) });
    const get = async () => ((await (await fetch(w.base + "/api/state", { headers: { "x-cs2t-token": w.token } })).json()) as { settings: Settings }).settings;

    expect((await put({ translation: { chatTargetLanguage: "ja", sendTargetLanguage: "de", geminiModel: "gemini-custom", staleAfterMs: 8000 }, dictionary: { custom: [{ id: "c1", term: "nc", translation: "漂亮", lang: "zh-TW" }] }, cs2: { bindKey: "f8", cfgFileName: "mine.cfg" } })).status).toBe(200);
    const base = await get();
    const mustKeep = {
      paths: [base.cs2.pathMode, base.cs2.logPath, base.cs2.cfgDir],
      names: base.cs2.selfNames,
      languages: [base.translation.chatTargetLanguage, base.translation.sendTargetLanguage],
    };
    expect(mustKeep.names).toEqual(["Me"]);
    expect(mustKeep.paths[0]).toBe("manual");

    // the very calls the UI makes: composer language, theme, a toggle, the send key, the dictionary
    for (const patch of [
      { translation: { sendTargetLanguage: "fr" } },
      { appearance: { theme: "dark" } },
      { general: { autoTranslate: false } },
      { cs2: { bindKey: "kp_end" } },
      { dictionary: { enabled: false } },
      { cs2: { chatFormat: { mode: "manual" } } },
    ]) {
      expect((await put(patch)).status).toBe(200);
    }
    const after = await get();
    expect([after.cs2.pathMode, after.cs2.logPath, after.cs2.cfgDir]).toEqual(mustKeep.paths);
    expect(after.cs2.selfNames).toEqual(mustKeep.names);
    expect(after.cs2.cfgFileName).toBe("mine.cfg");
    expect(after.translation).toMatchObject({ chatTargetLanguage: "ja", sendTargetLanguage: "fr", geminiModel: "gemini-custom", staleAfterMs: 8000 });
    expect(after.dictionary.custom).toHaveLength(1);
    expect(after.dictionary.enabled).toBe(false);
    expect(after.cs2.bindKey).toBe("kp_end");
    expect(after.cs2.chatFormat.manual).toEqual({ ct: "CT", t: "T", all: "ALL" });
    const onDisk = JSON.parse(await fs.readFile(path.join(w.dir, "config", "settings.json"), "utf8")) as Settings;
    const { secrets: _secrets, ...settingsOnly } = after as Settings & { secrets?: unknown };
    expect(onDisk).toEqual(settingsOnly);
  });

  it("a settings change cannot redirect the app to another cfg folder by accident", async () => {
    h = await bootApp();
    const before = h.app.resolvePaths();
    await h.app.updateSettings({ appearance: { theme: "dark" } });
    await h.app.updateSettings({ translation: { sendTargetLanguage: "ja" } });
    expect(h.app.resolvePaths()).toEqual(before);
    expect(h.app.settings.get().cs2.selfNames).toEqual(["Me"]);
  });
});

describe("settings saved by an earlier build", () => {
  it("a file that still has the removed in-game command field loads normally and drops it", () => {
    const legacy = { general: { uiLanguage: "zh-TW", autoTranslate: false, inGameCommands: true }, cs2: { selfNames: ["Me"] } };
    const parsed = settingsSchema.parse(legacy);
    expect(parsed.general).toMatchObject({ uiLanguage: "zh-TW", autoTranslate: false });
    expect("inGameCommands" in parsed.general).toBe(false);
    expect(parsed.cs2.selfNames).toEqual(["Me"]);
    expect(() => settingsPatchSchema.parse({ general: { inGameCommands: false, autoTranslate: true } })).not.toThrow();
  });
});

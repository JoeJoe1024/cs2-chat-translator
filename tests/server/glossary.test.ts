import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemorySecretStore } from "../../src/config/secrets";
import { LogTailer } from "../../src/cs2/logTailer";
import { App } from "../../src/server/app";
import { Glossary, validateCustomEntry, type CustomEntry, type DictionarySettings } from "../../src/shared/glossary";
import { BUILTIN_ENTRIES } from "../../src/shared/glossaryData";
import { TranslationService } from "../../src/translation/service";
import type { TranslationEngine } from "../../src/translation/types";
import { bootApp, bootWeb, googleFetch, until, type Harness, type WebHarness } from "../fixtures/harness";

const dict = (over: Partial<DictionarySettings> = {}): DictionarySettings => ({ enabled: true, disabled: [], custom: [], ...over });
let idSeq = 0;
const mine = (term: string, translation: string, lang = "*", id = `c${++idSeq}`): CustomEntry => ({ id, term, translation, lang });
const G = (over?: Partial<DictionarySettings>) => new Glossary(dict(over));
const local = (g: Glossary, text: string, target: string) => g.translateLocally(text, target);
const translated = (g: Glossary, text: string, target: string) => {
  const r = local(g, text, target);
  return r?.kind === "translated" ? r.text : r?.kind ?? null;
};

describe("built-in vocabulary", () => {
  it("contains every term the user asked for", () => {
    const terms = new Set(BUILTIN_ENTRIES.flatMap((e) => e.terms));
    for (const t of ["nc", "gg", "ggwp", "nt", "ns", "afk", "wp", "glhf", "ez", "mb", "ty", "np", "eco", "force", "save", "rush a", "rush b"]) {
      expect(terms.has(t), t).toBe(true);
    }
  });

  it("is internally consistent: unique lower-case terms and ids, English meaning, wording for the main languages", () => {
    const seen = new Set<string>();
    const ids = new Set<string>();
    for (const e of BUILTIN_ENTRIES) {
      expect(e.id).toMatch(/^[a-z0-9-]+$/);
      expect(ids.has(e.id), `duplicate id ${e.id}`).toBe(false);
      ids.add(e.id);
      expect(e.en.trim()).not.toBe("");
      for (const t of e.terms) {
        expect(t, e.id).toBe(t.toLowerCase());
        expect(t, e.id).toBe(t.trim());
        expect(seen.has(t), `term "${t}" is in two entries`).toBe(false);
        seen.add(t);
      }
      for (const lang of ["zh-TW", "zh-CN", "ja", "ko"] as const) expect(e.tr[lang]?.trim(), `${e.id} ${lang}`).toBeTruthy();
      for (const v of Object.values(e.tr)) expect(v!.trim()).toBe(v);
    }
  });
});

describe("local translation of whole messages", () => {
  const g = G();

  it("answers in the user's target language, not always Chinese", () => {
    expect(translated(g, "gg", "zh-TW")).toBe("好局");
    expect(translated(g, "gg", "zh-CN")).toBe("好局");
    expect(translated(g, "gg", "ja")).toBe("いい試合");
    expect(translated(g, "gg", "ko")).toBe("좋은 게임");
    expect(translated(g, "gg", "de")).toBe("gutes Spiel");
    expect(translated(g, "gg", "fr")).toBe("bien joué");
    expect(translated(g, "gg", "es")).toBe("buen juego");
    expect(translated(g, "gg", "ru")).toBe("хорошая игра");
    expect(translated(g, "gg", "pt")).toBe("bom jogo");
    expect(translated(g, "eco", "de")).toBe("Eco-Runde (kaum kaufen)");
    expect(translated(g, "eco", "zh-TW")).toBe("經濟局（不買裝備）");
  });

  it("recognises every language code spelling the app accepts", () => {
    expect(translated(g, "gg", "zh_tw")).toBe("好局");
    expect(translated(g, "gg", "ZH-tw")).toBe("好局");
    expect(translated(g, "gg", "jp")).toBe("いい試合");
  });

  it("shorthand every English reader knows is left as written for English targets; unfamiliar terms are explained", () => {
    for (const t of ["gg", "wp", "ty", "afk", "gl hf", "ez", "nt", "ns", "nc", "hello", "bye"]) expect(local(g, t, "en"), t).toEqual({ kind: "known" });
    expect(translated(g, "eco", "en")).toBe("economy round");
    expect(translated(g, "mb", "en")).toBe("my bad");
    expect(translated(g, "np", "en")).toBe("no problem");
    expect(local(g, "force buy", "en")).toEqual({ kind: "known" }); // the explanation would repeat the same words
    expect(local(g, "rush b", "en")).toEqual({ kind: "known" }); // the translation would be the same words
  });

  it("is not case sensitive and tolerates spaces and punctuation", () => {
    for (const t of ["gg", "GG", "Gg", "gG", "  gg  ", "gg!", "GG!!!", "gg.", "...gg", "(gg)", "gg?!", "\tgg\n"]) {
      expect(translated(g, t, "zh-TW"), JSON.stringify(t)).toMatch(/^好局[!?.！？。]*$/);
    }
    expect(translated(g, "NT", "zh-TW")).toBe("不錯的嘗試");
    expect(translated(g, "gg!", "zh-TW")).toBe("好局!");
    expect(translated(g, "gg wp!!", "zh-TW")).toBe("好局，打得好!!");
  });

  it("joins several terms naturally for the target language", () => {
    expect(translated(g, "gg wp", "zh-TW")).toBe("好局，打得好");
    expect(translated(g, "gg wp", "ja")).toBe("いい試合、ナイスプレー");
    expect(translated(g, "gg wp", "de")).toBe("gutes Spiel, gut gespielt");
    expect(translated(g, "gg-wp", "de")).toBe("gutes Spiel, gut gespielt");
    expect(translated(g, "gg/wp", "de")).toBe("gutes Spiel, gut gespielt");
    expect(translated(g, "gg eco", "en")).toBe("good game, economy round");
    expect(translated(g, "GGWP", "de")).toBe("gutes Spiel, gut gespielt");
  });

  it("prefers the longest phrase, so a short term cannot break a longer one", () => {
    expect(translated(g, "rush b", "zh-TW")).toBe("衝 B 點");
    expect(translated(g, "RUSH A", "zh-TW")).toBe("衝 A 點");
    expect(translated(g, "rush  mid", "zh-TW")).toBe("衝中路");
    expect(translated(g, "force buy", "zh-TW")).toBe("強起（全力購買）");
    expect(translated(g, "thank you", "de")).toBe("danke");
    // custom one-word "rush" does not steal "rush b" from the two-word built-in
    const withRush = G({ custom: [mine("rush", "go")] });
    expect(translated(withRush, "rush b", "zh-TW")).toBe("衝 B 點");
    expect(translated(withRush, "rush", "zh-TW")).toBe("go");
  });

  it("only matches whole words and never touches letters inside other words", () => {
    for (const t of ["eggs", "ggg", "gg2", "ggez", "tyrant", "ecosystem", "forceful", "saved", "savebob", "mbp", "afkk", "rushing b", "n t", "n.t.", "g g"]) {
      expect(local(g, t, "zh-TW"), t).toBeNull();
      expect(g.protect(t, "zh-TW").changed, t).toBe(false);
    }
    expect(g.protect("tyrants gg", "en").payload).toBe("tyrants good game");
    expect(g.protect("he said eggs", "en").payload).toBe("he said eggs");
  });

  it("does not guess when a message also holds ordinary words, numbers or names", () => {
    for (const t of ["gg everyone", "gg 2", "nice gg", "eco round now", "Mark gg", "gg wp mate", "1v3 gg"]) expect(local(g, t, "zh-TW"), t).toBeNull();
  });

  it("returns nothing for empty, symbol-only or unsupported-language input", () => {
    for (const t of ["", "   ", "!!!", "😀", "666"]) expect(local(g, t, "zh-TW"), JSON.stringify(t)).toBeNull();
    expect(local(g, "gg", "klingon")).toBeNull();
    expect(local(g, "gg", "th")).toBeNull(); // no built-in Thai wording: the translation service is used
  });

  it("turns a term with several meanings into its default wording only when it is the whole message", () => {
    expect(translated(g, "nc", "zh-TW")).toBe("漂亮");
    expect(translated(g, "NC!", "de")).toBe("gut gemacht!");
    expect(translated(g, "np", "zh-TW")).toBe("沒問題");
    expect(translated(g, "force", "zh-TW")).toBe("強起（全力購買）");
    expect(translated(g, "save", "zh-TW")).toBe("保槍（這局不買）");
  });
});

describe("terms inside longer sentences", () => {
  const g = G();

  it("spells unambiguous terms out for a general translator, keeping everything else exactly as written", () => {
    expect(g.protect("nice rush b, we eco next", "en")).toEqual({
      payload: "nice rush b, we economy round next", // "rush b" already says what it means, so it is left alone
      hints: ["eco = economy round"],
      changed: true,
    });
    expect(g.protect("Mark!! GG   wp...", "de").payload).toBe("Mark!! good game   well played...");
    expect(g.protect("gg_wp", "en").changed).toBe(false); // underscore joins words: one unknown word
  });

  it("leaves ambiguous terms alone inside a sentence (NC, NP, SAVE, FORCE)", () => {
    for (const t of ["nc clutch", "np mate", "we save here", "force them out", "that was nc"]) {
      expect(g.protect(t, "en").changed, t).toBe(false);
    }
    expect(g.protect("nc gg", "en").payload).toBe("nc good game");
  });

  it("never alters the player name or the original message (it only builds a separate payload)", () => {
    const original = "Gg_Master: gg all";
    const copy = original.slice();
    g.protect(original, "en");
    expect(original).toBe(copy);
    expect(g.protect("ggmaster gg", "en").payload).toBe("ggmaster good game"); // a name that merely contains letters of a term
  });

  it("uses the user's wording inside sentences too, even for an ambiguous term", () => {
    const own = G({ custom: [mine("nc", "nice clutch")] });
    expect(own.protect("nc man", "en")).toEqual({ payload: "nice clutch man", hints: ["nc = nice clutch"], changed: true });
    expect(own.protect("nc man", "zh-TW").payload).toBe("nice clutch man");
  });
});

describe("user dictionary", () => {
  it("custom wording always beats the built-in wording", () => {
    const g = G({ custom: [mine("gg", "漂亮的一局", "zh-TW"), mine("nc", "nice clutch")] });
    expect(translated(g, "gg", "zh-TW")).toBe("漂亮的一局");
    expect(translated(g, "gg", "ja")).toBe("いい試合"); // other languages keep the built-in
    expect(translated(g, "nc", "zh-TW")).toBe("nice clutch");
    expect(translated(g, "nc", "de")).toBe("nice clutch");
  });

  it("a language-specific entry beats the 'every language' entry for that language", () => {
    const g = G({ custom: [mine("nc", "all-languages wording", "*"), mine("nc", "只給繁中", "zh-TW")] });
    expect(translated(g, "nc", "zh-TW")).toBe("只給繁中");
    expect(translated(g, "nc", "ja")).toBe("all-languages wording");
  });

  it("supports entirely new terms and phrases, in any script", () => {
    const g = G({ custom: [mine("jump spot", "跳點"), mine("哈哈", "lol"), mine("666", "太強了"), mine("my team", "我的隊伍")] });
    expect(translated(g, "JUMP   SPOT", "en")).toBe("跳點");
    expect(translated(g, "哈哈", "en")).toBe("lol");
    expect(translated(g, "666", "zh-TW")).toBe("太強了");
    expect(g.protect("use the jump spot on b", "en").payload).toBe("use the 跳點 on b");
  });

  it("built-in terms can be switched off one by one", () => {
    const g = G({ disabled: ["gg", "rush-b"] });
    expect(local(g, "gg", "zh-TW")).toBeNull();
    expect(local(g, "rush b", "zh-TW")).toBeNull();
    expect(translated(g, "wp", "zh-TW")).toBe("打得好");
    expect(g.protect("gg wp", "en").payload).toBe("gg well played");
  });

  it("the master switch turns the whole dictionary off, custom entries included", () => {
    const g = G({ enabled: false, custom: [mine("gg", "x")] });
    expect(g.enabled).toBe(false);
    expect(local(g, "gg", "zh-TW")).toBeNull();
    expect(g.protect("gg wp", "en")).toEqual({ payload: "gg wp", hints: [], changed: false });
  });

  it("ignores blank or word-less custom entries instead of crashing", () => {
    const g = G({ custom: [mine("   ", "x"), mine("!!!", "y"), mine("ok", "   ")] });
    expect(local(g, "ok", "zh-TW")).toBeNull();
  });

  it("validates input before it is saved", () => {
    expect(validateCustomEntry("gg", "好局")).toBeNull();
    expect(validateCustomEntry("  ", "x")).toBe("empty-term");
    expect(validateCustomEntry("x", "  ")).toBe("empty-translation");
    expect(validateCustomEntry("x".repeat(41), "x")).toBe("term-too-long");
    expect(validateCustomEntry("x", "x".repeat(201))).toBe("translation-too-long");
    expect(validateCustomEntry("!!!", "x")).toBe("no-words");
  });
});

describe("inside the translation service", () => {
  function engineSpy() {
    const seen: { text: string; hints?: string[] }[] = [];
    const engine: TranslationEngine = {
      id: "google",
      translate: async ({ text, glossaryHints }) => {
        seen.push({ text, ...(glossaryHints ? { hints: glossaryHints } : {}) });
        return { text: `T(${text})`, detectedSource: "ru" };
      },
    };
    return { seen, service: new TranslationService({ engines: { google: engine, gemini: engine }, sleep: async () => undefined }) };
  }
  const ask = (s: TranslationService, text: string, over: Record<string, unknown> = {}) =>
    s.translate({ text, target: "zh-TW", engine: "google", priority: "chat", ...over } as Parameters<TranslationService["translate"]>[0]);

  it("answers common shorthand with no network request, before queue, cache and filter", async () => {
    const { seen, service } = engineSpy();
    const out = await ask(service, "GG wp!");
    expect(out).toMatchObject({ status: "done", text: "好局，打得好!", engine: "local", target: "zh-TW", cached: false });
    expect(seen).toEqual([]);
    expect(service.stats()).toMatchObject({ local: 1, completed: 0, filtered: 0, cacheLookups: 0, waiting: 0 });
  });

  it("GG, NT, ECO, AFK are meaningful: never filtered as noise, with the smart filter on", async () => {
    const { seen, service } = engineSpy();
    for (const t of ["gg", "nt", "eco", "afk"]) {
      const out = await ask(service, t, { smartFilter: true });
      expect(out.status, t).toBe("done");
      expect(out.status === "skipped" ? out.reason : "").not.toBe("not-text");
    }
    expect(seen).toEqual([]);
    expect(service.stats().filtered).toBe(0);
    // while genuine noise is still filtered
    expect(await ask(service, "666")).toMatchObject({ status: "skipped", reason: "not-text" });
  });

  it("a user entry for something like '666' beats the noise filter", async () => {
    const { service } = engineSpy();
    service.setGlossary(G({ custom: [mine("666", "太強了")] }));
    expect(await ask(service, "666")).toMatchObject({ status: "done", text: "太強了", engine: "local" });
  });

  it("local answers still work when the provider queue is full or the provider is down", async () => {
    const hung: TranslationEngine = { id: "google", translate: () => new Promise(() => undefined) };
    const service = new TranslationService({ engines: { google: hung, gemini: hung } });
    for (let i = 0; i < 60; i++) void ask(service, `stuck sentence number ${i}`).catch(() => undefined);
    const t0 = Date.now();
    expect(await ask(service, "gg")).toMatchObject({ status: "done", engine: "local" });
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it("known shorthand for English readers returns 'nothing to show' without a request", async () => {
    const { seen, service } = engineSpy();
    expect(await ask(service, "gg", { target: "en" })).toMatchObject({ status: "skipped", reason: "same-language" });
    expect(await ask(service, "eco", { target: "en" })).toMatchObject({ status: "done", text: "economy round", engine: "local" });
    expect(seen).toEqual([]);
  });

  it("a language without built-in wording falls back to the translation service, with the terms spelled out", async () => {
    const { seen, service } = engineSpy();
    const out = await ask(service, "gg", { target: "th" });
    expect(out).toMatchObject({ status: "done", engine: "google" });
    expect(seen).toEqual([{ text: "good game", hints: ["gg = good game"] }]);
  });

  it("editing the dictionary takes effect at once: results cached with the old wording are not reused", async () => {
    const { seen, service } = engineSpy();
    const first = await ask(service, "eco push now", { target: "en" });
    expect(first).toMatchObject({ status: "done", text: "T(economy round push now)" });
    await ask(service, "eco push now", { target: "en" });
    expect(seen).toHaveLength(1); // unchanged dictionary: served from the cache

    service.setGlossary(G({ custom: [mine("eco", "save your money")] }));
    const second = await ask(service, "eco push now", { target: "en" });
    expect(second).toMatchObject({ status: "done", text: "T(save your money push now)" });
    expect(seen).toHaveLength(2);

    service.setGlossary(G({ enabled: false }));
    expect(await ask(service, "eco push now", { target: "en" })).toMatchObject({ text: "T(eco push now)" });
    expect(seen).toHaveLength(3);
  });

  it("Gemini receives the original sentence plus the hints, including the user's own wording", async () => {
    const { seen, service } = engineSpy();
    service.setGlossary(G({ custom: [mine("nc", "nice clutch")] }));
    await ask(service, "nc and rush b please", { engine: "gemini", target: "en" });
    expect(seen).toEqual([{ text: "nc and rush b please", hints: ["nc = nice clutch"] }]);
  });
});

describe("in the running app", () => {
  let h: Harness | WebHarness;
  afterEach(async () => {
    await h?.stop();
  });

  it("chat shorthand is answered locally, in the chat target language, with the original line untouched", async () => {
    const fetchMock = googleFetch();
    h = await bootApp({ fetchMock });
    await h.app.updateSettings({ translation: { chatTargetLanguage: "zh-TW" } });
    await h.writeLog(["[ALL] Alice: gg wp", "[CT] Bob: RUSH B!", "[T] Eve: afk", "[ALL] Mallory: <b>gg</b> wp"]);
    await until(() => h.events.filter((e) => e.type === "translation" && e.update.status !== "pending").length >= 4);
    const entries = (await h.app.getState()).history;
    expect(entries.map((e) => e.text)).toEqual(["gg wp", "RUSH B!", "afk", "<b>gg</b> wp"]); // originals exactly as they were
    expect(entries.map((e) => e.sender)).toEqual(["Alice", "Bob", "Eve", "Mallory"]);
    expect(entries[0]!.translation).toMatchObject({ status: "done", text: "好局，打得好", engine: "local" });
    expect(entries[1]!.translation).toMatchObject({ status: "done", text: "衝 B 點!", engine: "local" });
    expect(entries[2]!.translation).toMatchObject({ status: "done", text: "暫時離開", engine: "local" });
    expect(entries[3]!.translation.status).toBe("done"); // mixed with markup: goes to the translator, spelled out
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URLSearchParams(String((fetchMock.mock.calls[0] as unknown[])[1] && ((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).body)).get("q")).toBe("<b>good game</b> well played");
    expect(h.app.runtime().stats.local).toBe(3);
  });

  it("edits apply immediately to the next message, with no stale cache", async () => {
    const fetchMock = googleFetch();
    h = await bootApp({ fetchMock });
    await h.writeLog(["[ALL] A: eco push now"]);
    await until(() => (h.events.filter((e) => e.type === "translation" && e.update.status === "done").length >= 1));
    const q = (i: number) => new URLSearchParams(String(((fetchMock.mock.calls[i] as unknown[])[1] as RequestInit).body)).get("q");
    expect(q(0)).toBe("economy round push now");
    await h.app.updateSettings({ dictionary: { custom: [mine("eco", "keep your money")] } });
    await h.writeLog(["[ALL] B: eco push now"]);
    await until(() => fetchMock.mock.calls.length === 2);
    expect(q(1)).toBe("keep your money push now");
    await h.app.updateSettings({ dictionary: { enabled: false } });
    await h.writeLog(["[ALL] C: gg"]);
    await until(() => fetchMock.mock.calls.length === 3);
    expect(q(2)).toBe("gg"); // dictionary off: the plain message goes to the translator
  });

  it("is saved with the settings, survives a restart, and is validated by the API", async () => {
    const w = await bootWeb();
    h = w;
    const put = (body: unknown) => fetch(w.base + "/api/settings", { method: "PUT", headers: { "x-cs2t-token": w.token, "content-type": "application/json" }, body: JSON.stringify(body) });
    const ok = await put({ dictionary: { disabled: ["gg"], custom: [mine("nc", "漂亮的一槍", "zh-TW")] } });
    expect(ok.status).toBe(200);
    const again = new App({ configDir: path.join(w.dir, "config"), secrets: new MemorySecretStore(), tailer: new LogTailer(15), installs: [], personaNames: [] });
    await again.init();
    expect(again.settings.get().dictionary).toMatchObject({ enabled: true, disabled: ["gg"], custom: [{ term: "nc", translation: "漂亮的一槍", lang: "zh-TW" }] });
    await again.close();

    const longTerm = "x".repeat(41);
    for (const bad of [
      { custom: [{ id: "a", term: longTerm, translation: "x", lang: "*" }] },
      { custom: [{ id: "a", term: "x", translation: "y".repeat(201), lang: "*" }] },
      { custom: [{ id: "a", term: "x", translation: "y", lang: "klingon" }] },
      { custom: [{ id: "bad id!", term: "x", translation: "y", lang: "*" }] },
      { custom: [{ id: "a", term: "", translation: "y", lang: "*" }] },
      { disabled: ["Not Valid!"] },
      { custom: Array.from({ length: 301 }, (_, i) => ({ id: `c${i}`, term: `t${i}`, translation: "y", lang: "*" })) },
    ]) {
      expect((await put({ dictionary: bad })).status, JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
    const raw = JSON.parse(await fs.readFile(path.join(w.dir, "config", "settings.json"), "utf8")) as { dictionary: { custom: unknown[] } };
    expect(raw.dictionary.custom).toHaveLength(1); // the rejected patches changed nothing
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { TS, bootApp, googleFetch, until, type Harness } from "../fixtures/harness";

let h: Harness;
afterEach(async () => {
  await h?.stop();
});

const translations = () => h.events.filter((e) => e.type === "translation");
const noticeCodes = () => h.events.flatMap((e) => (e.type === "notice" ? [e.code] : []));

describe("chat pipeline (log file → parse → translate → events)", () => {
  it("emits the chat line immediately, then the translation, in log order", async () => {
    h = await bootApp();
    await h.writeLog(["[ALL] Alice: hola", "[CT] Bob: bonjour"]);
    await until(() => translations().filter((e) => e.update.status === "done").length === 2);
    const chats = h.events.flatMap((e) => (e.type === "chat" ? [e.message] : []));
    expect(chats.map((m) => [m.channel, m.sender, m.text])).toEqual([
      ["all", "Alice", "hola"],
      ["ct", "Bob", "bonjour"],
    ]);
    const first = h.events.findIndex((e) => e.type === "chat");
    const firstTranslation = h.events.findIndex((e) => e.type === "translation" && e.update.status === "done");
    expect(first).toBeLessThan(firstTranslation);
    const state = await h.app.getState();
    expect(state.history.map((e) => e.translation.text)).toEqual(["T(hola)", "T(bonjour)"]);
    expect(state.format.templateSource).toBe("builtin-english");
  });

  it("ignores system lines and unknown formats", async () => {
    h = await bootApp();
    await h.writeLog(["[Client] Connected: yes", "[ZZZ] Someone: hi", "Plain text: nothing"]);
    await new Promise((r) => setTimeout(r, 150));
    expect(h.events.some((e) => e.type === "chat")).toBe(false);
  });

  it("does not translate own messages by default, and skips numeric chat", async () => {
    h = await bootApp();
    await h.writeLog(["[ALL] Me: my own words", "[ALL] Alice: 666"]);
    await until(() => translations().length === 2);
    expect(translations().map((e) => e.update.reason)).toEqual(["own-message", "not-text"]);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("marks messages skipped while paused and can translate them on demand", async () => {
    h = await bootApp();
    h.app.setPaused(true);
    await h.writeLog(["[ALL] Alice: hola"]);
    await until(() => translations().length === 1);
    expect(translations()[0]).toMatchObject({ update: { status: "skipped", reason: "paused" } });
    const id = (h.events.find((e) => e.type === "chat") as { message: { id: string } }).message.id;
    const update = await h.app.translateById(id);
    expect(update).toMatchObject({ status: "done", text: "T(hola)" });
  });

  it("reports provider failures per message instead of crashing", async () => {
    h = await bootApp({ fetchMock: googleFetch({ status: 503 }) });
    await h.writeLog(["[ALL] Alice: hola"]);
    await until(() => translations().some((e) => e.update.status === "failed"), 8000);
    expect(translations().at(-1)).toMatchObject({ update: { status: "failed", reason: "network" } });
    await h.writeLog(["[ALL] Alice: again"]);
    await until(() => h.events.filter((e) => e.type === "chat").length === 2);
  });

  it("falls back to Google (with a notice) when Gemini is selected without a key", async () => {
    h = await bootApp();
    await h.app.updateSettings({ translation: { chatEngine: "gemini" } });
    await h.writeLog(["[ALL] Alice: hola"]);
    await until(() => translations().some((e) => e.update.status === "done"));
    expect(translations().at(-1)).toMatchObject({ update: { engine: "google" } });
    expect(noticeCodes()).toContain("gemini-no-key-fallback");
  });

  it("keeps up with a flood of chat lines", async () => {
    h = await bootApp();
    await h.app.updateSettings({ general: { autoTranslate: false } });
    await h.writeLog(Array.from({ length: 1500 }, (_, i) => `[ALL] P${i}: message number ${i}`));
    await until(() => h.events.filter((e) => e.type === "chat").length === 1500, 10000);
    const state = await h.app.getState();
    expect(state.history).toHaveLength(200);
    expect(state.history.at(-1)?.text).toBe("message number 1499");
  });
});

describe("former command-looking chat", () => {
  it("is ordinary chat now: translated like any message, and never touches the cfg", async () => {
    h = await bootApp();
    await h.writeLog(["[ALL] Alice: tm_de hello", "[ALL] Me: code_german", "[CT] Bob: _tl"]);
    await until(() => h.events.filter((e) => e.type === "translation").length >= 3);
    const state = await h.app.getState();
    expect(state.history.map((e) => e.text)).toEqual(["tm_de hello", "code_german", "_tl"]);
    expect(state.history.find((e) => e.sender === "Alice")?.translation.status).toBe("done");
    expect(state.prepared).toBeNull();
    expect(await h.hasSay()).toBe(false);
  });

  it("never lets a hostile translation break out of the cfg string", async () => {
    const evil = vi_evilFetch();
    h = await bootApp({ fetchMock: evil as unknown as ReturnType<typeof googleFetch> });
    const out = await h.app.translateForSend("greetings friend", "en");
    await h.app.prepareCfg(out.status === "done" ? out.text : "x", "all", "translated");
    const cfg = await h.cfg();
    for (const line of cfg.split(/\r?\n/).filter((l) => l && !l.startsWith("//"))) {
      expect(line).toMatch(/^say(_team)? "[^"\\;]*"$/);
    }
  });
});

describe("UI-side cfg preparation", () => {
  it("writes cfg and reports the bind command", async () => {
    h = await bootApp();
    const prepared = await h.app.prepareCfg("Hello \"world\"; quit", "all", "direct");
    expect(prepared.bindCommand).toBe('bind "kp_plus" "exec chat_reader.cfg"');
    expect(await h.cfg()).toContain("say \"Hello \u201dworld\u201d\uff1b quit\"");
    expect(TS).toBeTruthy();
  });

  it("fails with a clear code when the cfg folder is missing", async () => {
    h = await bootApp();
    await h.app.updateSettings({ cs2: { cfgDir: h.dir + "/nope" } });
    await expect(h.app.prepareCfg("hi", "all", "direct")).rejects.toMatchObject({ code: "cfg-dir-missing" });
  });
});

function vi_evilFetch() {
  return async () =>
    new Response(JSON.stringify([[['hi"\nquit\n say "x"; exec evil.cfg // rest\\', "hello"]], null, "en-x"]), { status: 200 });
}

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry, ServerEvent } from "../../src/shared/protocol";
import { bootApp, until, type Harness } from "../fixtures/harness";

const KEY = "AIzaSyDUMMY_KEY_FOR_TESTS_0123456789";

interface Script {
  /** Milliseconds a Google request takes (default 20). */
  googleDelay?: (q: string, call: number) => number;
  /** HTTP status Google answers with (default 200). */
  googleStatus?: (q: string, call: number) => number;
  /** HTTP status Gemini answers with (default 200). */
  geminiStatus?: () => number;
}

/** A scriptable stand-in for Google Translate and Gemini that records every request. */
function scripted(script: Script = {}) {
  const log: { engine: "google" | "gemini"; text: string; tl?: string; at: number }[] = [];
  const started = Date.now();
  const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.includes(":generateContent")) {
      const body = JSON.parse(String(init?.body)) as { contents: { parts: { text: string }[] }[] };
      const { text } = JSON.parse(body.contents[0]!.parts[0]!.text) as { text: string };
      log.push({ engine: "gemini", text, at: Date.now() - started });
      const status = script.geminiStatus?.() ?? 200;
      if (status !== 200) return new Response(JSON.stringify({ error: { message: "quota" } }), { status, headers: { "retry-after": "60" } });
      return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ translation: `G(${text})`, source_language: "es" }) }] } }] }), { status: 200 });
    }
    const q = new URLSearchParams(String(init?.body)).get("q") ?? "";
    const tl = new URL(u).searchParams.get("tl") ?? "";
    const call = log.filter((l) => l.engine === "google").length + 1;
    log.push({ engine: "google", text: q, tl, at: Date.now() - started });
    const delay = script.googleDelay?.(q, call) ?? 20;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    const status = script.googleStatus?.(q, call) ?? 200;
    if (status !== 200) return new Response("err", { status });
    const prefix = tl === "en" ? "T" : tl.toUpperCase();
    return new Response(JSON.stringify([[[`${prefix}(${q})`, q]], null, "ja"]), { status: 200 });
  });
  return { fn, log };
}

let h: Harness;
afterEach(async () => {
  await h?.stop();
});

const chatEvents = () => h.events.filter((e): e is Extract<ServerEvent, { type: "chat" }> => e.type === "chat");
const settled = (id: string) => {
  const last = h.events.filter((e): e is Extract<ServerEvent, { type: "translation" }> => e.type === "translation" && e.update.id === id).at(-1);
  return !!last && last.update.status !== "pending";
};
const history = async (): Promise<ChatEntry[]> => (await h.app.getState()).history;
const byText = async () => new Map((await history()).map((e) => [e.text, e]));

async function waitAllSettled(n: number, ms = 12000) {
  await until(() => chatEvents().length === n && chatEvents().every((c) => settled(c.message.id)), ms);
}

describe("bursts of chat", () => {
  it.each([10, 30, 50])("%i messages in one second: all raw chat appears first, and every translation lands on its own message", async (n) => {
    const s = scripted({ googleDelay: () => 40 });
    h = await bootApp({ fetchMock: s.fn as never });
    const lines = Array.from({ length: n }, (_, i) => `[${i % 3 === 0 ? "CT" : i % 3 === 1 ? "T" : "ALL"}] Player${i}: tactic number ${i} go`);
    await h.writeLog(lines);
    await waitAllSettled(n);

    // 1. nothing waited for the API: every raw chat event precedes the first finished translation
    const firstDone = h.events.findIndex((e) => e.type === "translation" && e.update.status === "done");
    const lastChat = h.events.map((e) => e.type).lastIndexOf("chat");
    expect(lastChat).toBeLessThan(firstDone);

    // 2. nothing lost, in order, with the right sender and channel
    const entries = await history();
    expect(entries).toHaveLength(n);
    entries.forEach((e, i) => {
      expect(e.sender).toBe(`Player${i}`);
      expect(e.text).toBe(`tactic number ${i} go`);
      expect(e.channel).toBe(i % 3 === 0 ? "ct" : i % 3 === 1 ? "t" : "all");
    });

    // 3. every finished translation belongs to its own message (no shifting, no swapping)
    let done = 0;
    for (const e of entries) {
      if (e.translation.status === "done") {
        expect(e.translation.text).toBe(`T(${e.text})`);
        done++;
      } else {
        // only legitimate outcome besides done: the bounded backlog said "too many"
        expect(e.translation).toMatchObject({ status: "failed", reason: "overloaded" });
      }
    }
    if (n <= 30) expect(done).toBe(n);
    else expect(done).toBeGreaterThanOrEqual(43); // 3 running + 40 backlog accepted
    expect(h.app.runtime().stats.waiting).toBe(0);
  });

  it("mixes many players, tactical lines and noise: filters before the API and keeps every raw line", async () => {
    const s = scripted();
    h = await bootApp({ fetchMock: s.fn as never });
    const lines = [
      "[ALL] P1: 666", "[CT] P2: 1v3", "[T] P3: rush B", "[ALL] P4: ?????", "[CT] P5: 30 hp", "[ALL] P6: 😀😀😀",
      "[T] P7: gg", "[ALL] P8: 777777", "[CT] P9: 2 A 1 B", "[ALL] P10: !!!!!!", "[T] P11: eco", "[ALL] P12: 123456",
    ];
    await h.writeLog(lines);
    await waitAllSettled(lines.length);
    const e = await byText();
    for (const noise of ["666", "?????", "😀😀😀", "777777", "!!!!!!", "123456"]) {
      expect(e.get(noise)?.translation, noise).toMatchObject({ status: "skipped", reason: "not-text" });
    }
    for (const real of ["1v3", "30 hp", "2 A 1 B", "eco"]) {
      expect(e.get(real)?.translation.status, real).toBe("done");
    }
    // GG, ECO and RUSH B are dictionary terms: answered locally, so only the three ordinary lines reach the provider
    expect(s.log.map((l) => l.text).sort()).toEqual(["1v3", "2 A 1 B", "30 hp"].sort());
    expect(e.get("eco")?.translation).toMatchObject({ status: "done", text: "economy round", engine: "local" });
    expect(e.get("gg")?.translation).toMatchObject({ status: "skipped", reason: "same-language" });
    expect(e.get("rush B")?.translation).toMatchObject({ status: "skipped", reason: "same-language" });
    expect(h.app.runtime().stats).toMatchObject({ filtered: 6, local: 3 });
    expect(chatEvents()).toHaveLength(12);
  });

  it("with the smart filter off, numbers and symbols are sent to the provider like anything else", async () => {
    const s = scripted();
    h = await bootApp({ fetchMock: s.fn as never });
    await h.app.updateSettings({ general: { smartFilter: false } });
    await h.writeLog(["[ALL] P1: 666", "[ALL] P2: ?????"]);
    await waitAllSettled(2);
    expect(s.log.map((l) => l.text).sort()).toEqual(["666", "?????"]);
  });

  it("merges 50 identical messages into one request, then serves the next 50 from the cache", async () => {
    const s = scripted({ googleDelay: () => 60 });
    h = await bootApp({ fetchMock: s.fn as never });
    await h.writeLog(Array.from({ length: 50 }, (_, i) => `[T] Spammer${i}: push banana`));
    await waitAllSettled(50);
    expect(s.log).toHaveLength(1);
    expect((await history()).every((e) => e.translation.status === "done" && e.translation.text === "T(push banana)")).toBe(true);

    const before = h.app.runtime().stats.cacheHits;
    await h.writeLog(Array.from({ length: 50 }, (_, i) => `[T] Again${i}: push banana`));
    await until(() => chatEvents().length === 100 && chatEvents().every((c) => settled(c.message.id)));
    expect(s.log).toHaveLength(1);
    expect(h.app.runtime().stats.cacheHits - before).toBe(50);
  });

  it("with the cache off, repeated messages (not simultaneous ones) are asked again", async () => {
    const s = scripted({ googleDelay: () => 5 });
    h = await bootApp({ fetchMock: s.fn as never });
    await h.app.updateSettings({ general: { translationCache: false } });
    await h.writeLog(["[ALL] A: push banana"]);
    await waitAllSettled(1);
    await h.writeLog(["[ALL] B: push banana"]);
    await until(() => chatEvents().length === 2 && chatEvents().every((c) => settled(c.message.id)));
    expect(s.log).toHaveLength(2);
    expect(h.app.runtime().stats.cacheHits).toBe(0);
  });
});

describe("slow or failing providers", () => {
  it("skips translations that waited too long, keeps their raw chat, and still serves newer messages", async () => {
    const s = scripted({ googleDelay: () => 250 });
    h = await bootApp({ fetchMock: s.fn as never });
    await h.app.updateSettings({ translation: { staleAfterMs: 1000 } });
    await h.writeLog(Array.from({ length: 30 }, (_, i) => `[ALL] Old${i}: old message ${i}`));
    await new Promise((r) => setTimeout(r, 1300)); // the queue is now older than the freshness window
    await h.writeLog(["[CT] Fresh1: fresh one", "[CT] Fresh2: fresh two", "[CT] Fresh3: fresh three"]);
    await waitAllSettled(33, 15000);

    const entries = await history();
    expect(entries).toHaveLength(33); // raw chat never dropped
    const old = entries.slice(0, 30);
    const stale = old.filter((e) => e.translation.status === "skipped" && e.translation.reason === "stale");
    expect(stale.length).toBeGreaterThanOrEqual(10);
    for (const e of old) {
      if (e.translation.status === "done") expect(e.translation.text).toBe(`T(${e.text})`);
      else expect(["stale", "overloaded"]).toContain(e.translation.reason);
    }
    // the newest messages were not stuck behind the old backlog
    for (const e of entries.slice(30)) expect(e.translation, e.text).toMatchObject({ status: "done", text: `T(${e.text})` });
    expect(h.app.runtime().stats.stale).toBe(stale.length);
    // skipped ones can still be translated by hand
    const first = stale[0]!;
    const manual = await h.app.translateById(first.id);
    expect(manual).toMatchObject({ status: "done", text: `T(${first.text})` });
  }, 30000);

  it("a Gemini quota error fails fast for the rest of the burst, never blocks, and Google keeps working", async () => {
    const s = scripted({ geminiStatus: () => 429 });
    h = await bootApp({ fetchMock: s.fn as never });
    await h.app.setGeminiKey(KEY);
    await h.app.updateSettings({ translation: { chatEngine: "gemini" } });
    await h.writeLog(Array.from({ length: 20 }, (_, i) => `[ALL] P${i}: quota test ${i}`));
    await waitAllSettled(20);
    const entries = await history();
    expect(entries.every((e) => e.translation.status === "failed" && e.translation.reason === "quota")).toBe(true);
    expect(s.log.filter((l) => l.engine === "gemini").length).toBeLessThanOrEqual(2); // concurrency 2, then cool-down
    expect(h.app.runtime().stats.failed).toBe(20);

    await h.app.updateSettings({ translation: { chatEngine: "google" } });
    await h.writeLog(["[ALL] Later: still works"]);
    await until(() => chatEvents().length === 21 && settled(chatEvents()[20]!.message.id));
    expect((await history())[20]!.translation).toMatchObject({ status: "done", text: "T(still works)", engine: "google" });
  });

  it("a Google outage fails quickly after a few attempts and every raw message is still shown", async () => {
    const s = scripted({ googleDelay: () => 0, googleStatus: () => 503 });
    h = await bootApp({ fetchMock: s.fn as never });
    const t0 = Date.now();
    await h.writeLog(Array.from({ length: 25 }, (_, i) => `[ALL] P${i}: outage ${i}`));
    await waitAllSettled(25, 20000);
    expect(Date.now() - t0).toBeLessThan(8000);
    const entries = await history();
    expect(entries).toHaveLength(25);
    expect(entries.every((e) => e.translation.status === "failed" && e.translation.reason === "network")).toBe(true);
    expect(s.log.length).toBeLessThan(15); // the breaker stopped the retries; 25 messages × 3 attempts did not happen
  });

  it("switching the engine while translations are in flight: running ones finish on their engine, later ones use the new one", async () => {
    const s = scripted({ googleDelay: () => 200 });
    h = await bootApp({ fetchMock: s.fn as never });
    await h.app.setGeminiKey(KEY);
    await h.writeLog(Array.from({ length: 6 }, (_, i) => `[ALL] A${i}: first wave ${i}`));
    await until(() => s.log.length >= 3); // requests are in flight
    await h.app.updateSettings({ translation: { chatEngine: "gemini" } });
    await h.writeLog(Array.from({ length: 6 }, (_, i) => `[ALL] B${i}: second wave ${i}`));
    await waitAllSettled(12);
    const entries = await history();
    for (const e of entries.slice(0, 6)) expect(e.translation, e.text).toMatchObject({ status: "done", engine: "google", text: `T(${e.text})` });
    for (const e of entries.slice(6)) expect(e.translation, e.text).toMatchObject({ status: "done", engine: "gemini", text: `G(${e.text})` });
  });

  it("an older, slower result can never overwrite the result of a newer request for the same message", async () => {
    const s = scripted({ googleDelay: (_q, call) => (call === 1 ? 400 : 10) });
    h = await bootApp({ fetchMock: s.fn as never });
    await h.app.updateSettings({ general: { autoTranslate: false } });
    await h.writeLog(["[ALL] Zed: order test"]);
    await until(() => chatEvents().length === 1);
    const id = chatEvents()[0]!.message.id;

    const slowFirst = h.app.translateById(id); // target en, answers after 400 ms
    await until(() => s.log.length === 1);
    await h.app.updateSettings({ translation: { chatTargetLanguage: "de" } });
    const fastSecond = await h.app.translateById(id); // target de, answers after 10 ms
    expect(fastSecond).toMatchObject({ status: "done", text: "DE(order test)" });
    await slowFirst; // the slow one finishes last
    await new Promise((r) => setTimeout(r, 50));

    expect((await history())[0]!.translation).toMatchObject({ status: "done", text: "DE(order test)" });
    const texts = h.events.flatMap((e) => (e.type === "translation" && e.update.id === id && e.update.text ? [e.update.text] : []));
    expect(texts).toEqual(["DE(order test)"]); // the stale answer was never even announced
  });
});

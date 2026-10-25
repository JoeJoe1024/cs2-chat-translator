import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemorySecretStore } from "../../src/config/secrets";
import { LogTailer } from "../../src/cs2/logTailer";
import type { CfgPrepared, ServerEvent } from "../../src/shared/protocol";
import { App, PrepareSupersededError } from "../../src/server/app";
import { bootApp, bootWeb, googleFetch, until, type Harness, type WebHarness } from "../fixtures/harness";

let h: Harness | WebHarness;
afterEach(async () => {
  await h?.stop();
});

const cfgEvents = () => h.events.filter((e): e is Extract<ServerEvent, { type: "cfg" }> => e.type === "cfg").map((e) => e.prepared);
const says = async () => (await h.cfg()).split(/\r?\n/).filter((l) => /^say(_team)? "/.test(l));

describe("one shared key, one prepared message", () => {
  it("translated and typed messages alternate through the same cfg file and the same bind", async () => {
    h = await bootApp();
    const t = Date.now();
    const a = await h.app.prepareCfg("Hallo Welt", "all", "translated", { clickedAt: t, original: "Hello world" });
    expect(a).toMatchObject({ mode: "translated", lines: ["Hallo Welt"], original: "Hello world", channel: "all" });
    expect(await says()).toEqual(['say "Hallo Welt"']);

    const b = await h.app.prepareCfg("rush b now", "team", "direct", { clickedAt: t + 10 });
    expect(b).toMatchObject({ mode: "direct", lines: ["rush b now"], channel: "team" });
    expect(b.original).toBeUndefined();
    expect(await says()).toEqual(['say_team "rush b now"']); // exactly ONE message: the latest

    const c = await h.app.prepareCfg("Guten Tag", "all", "translated", { clickedAt: t + 20, original: "Good day" });
    expect(await says()).toEqual(['say "Guten Tag"']);

    for (const p of [a, b, c]) {
      expect(path.basename(p.file)).toBe("chat_reader.cfg");
      expect(p.bindCommand).toBe('bind "kp_plus" "exec chat_reader.cfg"');
    }
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    expect((await h.app.getState()).prepared?.id).toBe(c.id);
    expect(cfgEvents().map((p) => p.mode)).toEqual(["translated", "direct", "translated"]);
  });

  it("many quick preparations (both modes) leave exactly the last one, announced in order", async () => {
    h = await bootApp();
    const t = Date.now();
    const calls = Array.from({ length: 30 }, (_, i) =>
      h.app.prepareCfg(`message ${i}`, i % 2 ? "team" : "all", i % 3 ? "direct" : "translated", { clickedAt: t + i }),
    );
    const results = await Promise.all(calls);
    expect(results.map((r) => r.lines[0])).toEqual(Array.from({ length: 30 }, (_, i) => `message ${i}`));
    expect(await says()).toEqual(['say_team "message 29"']);
    expect(cfgEvents().map((p) => p.lines[0])).toEqual(results.map((r) => r.lines[0]));
    expect((await h.app.getState()).prepared?.lines).toEqual(["message 29"]);
    // the file was never half-written: no leftovers either
    expect((await fs.readdir(h.cfgDir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("a slower, older click can never overwrite a newer message", async () => {
    h = await bootApp();
    const t = Date.now();
    await h.app.prepareCfg("typed later, answers first", "all", "direct", { clickedAt: t + 500 });
    await expect(h.app.prepareCfg("translated earlier, answers last", "all", "translated", { clickedAt: t + 100 })).rejects.toBeInstanceOf(PrepareSupersededError);
    expect(await says()).toEqual(['say "typed later, answers first"']);
    expect((await h.app.getState()).prepared?.mode).toBe("direct");
    expect(cfgEvents()).toHaveLength(1);
  });

  it("an equal click time is accepted; an absurd future click time cannot block later clicks", async () => {
    h = await bootApp();
    const t = Date.now();
    await h.app.prepareCfg("one", "all", "direct", { clickedAt: t });
    await h.app.prepareCfg("two", "all", "direct", { clickedAt: t });
    await h.app.prepareCfg("from a broken clock", "all", "direct", { clickedAt: t + 24 * 3600_000 });
    const ok = await h.app.prepareCfg("normal click afterwards", "all", "direct");
    expect(ok.lines).toEqual(["normal click afterwards"]);
    expect(await says()).toEqual(['say "normal click afterwards"']);
  });

  it("a failed write changes nothing: the old message stays prepared and no success is announced", async () => {
    h = await bootApp();
    const t = Date.now();
    const good = await h.app.prepareCfg("still valid", "all", "direct", { clickedAt: t });
    const before = cfgEvents().length;
    // make the cfg path unwritable: a directory sits where the file should be
    await fs.rm(h.cfgFile);
    await fs.mkdir(h.cfgFile);
    await expect(h.app.prepareCfg("this will fail", "all", "direct", { clickedAt: t + 50 })).rejects.toMatchObject({ code: "cfg-write-failed" });
    expect(cfgEvents()).toHaveLength(before);
    expect((await h.app.getState()).prepared?.id).toBe(good.id);
    // the failure did not use up the click time: an earlier-clicked message can still be prepared once writing works again
    await fs.rm(h.cfgFile, { recursive: true });
    const retry = await h.app.prepareCfg("retry works", "all", "direct", { clickedAt: t + 20 });
    expect(retry.lines).toEqual(["retry works"]);
    expect(await says()).toEqual(['say "retry works"']);
  });

  it("a missing cfg folder is reported, not hidden", async () => {
    h = await bootApp();
    await h.app.updateSettings({ cs2: { cfgDir: path.join(h.dir, "no-such-folder") } });
    await expect(h.app.prepareCfg("x", "all", "direct")).rejects.toMatchObject({ code: "cfg-dir-missing" });
    expect((await h.app.getState()).prepared).toBeNull();
  });

  it("typed messages get the same injection protection and never touch a translation service", async () => {
    const fetchMock = googleFetch();
    h = await bootApp({ fetchMock });
    const hostile = 'hi"; quit; say "x\nexec evil.cfg // rest\\ \u2028 more';
    const p = await h.app.prepareCfg(hostile, "all", "direct");
    for (const line of (await h.cfg()).split(/\r?\n/).filter((l) => l && !l.startsWith("//"))) expect(line).toMatch(/^say(_team)? "[^"\\;]*"$/);
    expect(p.lines.join(" ")).not.toContain(";");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("splits long typed messages and says so when text had to be dropped", async () => {
    h = await bootApp();
    const p = await h.app.prepareCfg("word ".repeat(200), "all", "direct");
    expect(p.lines).toHaveLength(3);
    expect(p.truncated).toBe(true);
    for (const l of p.lines) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(120);
  });
});

describe("background work never touches the prepared message", () => {
  it("chat translations finishing late, mode switches and settings edits leave it as it was", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = async (_url: unknown, init?: RequestInit) => {
      await gate;
      const q = new URLSearchParams(String(init?.body)).get("q") ?? "";
      return new Response(JSON.stringify([[[`T(${q})`, q]], null, "ja"]), { status: 200 });
    };
    h = await bootApp({ fetchMock: slow as never });
    await h.writeLog(["[ALL] Alice: hola amigo", "[ALL] Bob: buenos dias"]); // translations are now waiting
    const p = await h.app.prepareCfg("what I prepared", "all", "direct");
    release();
    await until(() => h.events.filter((e) => e.type === "translation" && e.update.status === "done").length === 2);
    await h.app.updateSettings({ translation: { chatTargetLanguage: "de", sendTargetLanguage: "ja" }, general: { autoTranslate: false } });
    expect(await says()).toEqual(['say "what I prepared"']);
    expect((await h.app.getState()).prepared?.id).toBe(p.id);
    expect(cfgEvents()).toHaveLength(1);
  });
});

describe("nothing stale is ever sent", () => {
  it("nothing prepared yet: the cfg is the do-nothing file, and the state says so", async () => {
    h = await bootApp();
    const content = await h.cfg();
    expect(content).toContain("Nothing is prepared");
    expect(content).not.toMatch(/\bsay(_team)?\b\s+"/);
    expect((await h.app.getState()).prepared).toBeNull();
  });

  it("a message left in the cfg by an earlier run or by the previous app version is withdrawn at start-up", async () => {
    for (const header of ["// Written by CS2 Chat Translator. Safe to delete.", "// Auto-generated by CS2 Chat Translator"]) {
      h = await bootApp();
      await fs.writeFile(h.cfgFile, `${header}\r\nsay_team "6"\r\n`);
      const again = new App({ configDir: path.join(h.dir, "config"), secrets: new MemorySecretStore(), tailer: new LogTailer(15), installs: [], personaNames: [] });
      await again.init();
      expect(await h.hasSay(), header).toBe(false);
      expect((await again.getState()).prepared).toBeNull();
      await again.close();
      await h.stop();
    }
  });

  it("restarting the app starts from 'nothing prepared', and closing it withdraws what was prepared", async () => {
    h = await bootApp();
    await h.app.prepareCfg("prepared before closing", "all", "direct");
    expect(await h.hasSay()).toBe(true);
    await h.app.close();
    expect(await h.hasSay()).toBe(false); // withdrawn on a normal shutdown
    const again = new App({ configDir: path.join(h.dir, "config"), secrets: new MemorySecretStore(), tailer: new LogTailer(15), installs: [], personaNames: [] });
    await again.init();
    expect((await again.getState()).prepared).toBeNull();
    expect(await h.hasSay()).toBe(false);
    await again.close();
  });

  it("a crash (no shutdown) is covered by the next start-up", async () => {
    h = await bootApp();
    await h.app.prepareCfg("left behind by a crash", "all", "direct");
    // no close(): the file still holds the message ...
    expect(await h.hasSay()).toBe(true);
    const again = new App({ configDir: path.join(h.dir, "config"), secrets: new MemorySecretStore(), tailer: new LogTailer(15), installs: [], personaNames: [] });
    await again.init(); // ... until the app starts again
    expect(await h.hasSay()).toBe(false);
    await again.close();
  });

  it("a cfg file that is not ours is never touched, and the user is told", async () => {
    h = await bootApp();
    await h.app.close();
    await fs.writeFile(h.cfgFile, 'say "my own personal config"\n');
    const again = new App({ configDir: path.join(h.dir, "config"), secrets: new MemorySecretStore(), tailer: new LogTailer(15), installs: [], personaNames: [] });
    const codes: string[] = [];
    const emit = again.hub.emit.bind(again.hub);
    again.hub.emit = (e) => {
      if (e.type === "notice") codes.push(e.code);
      emit(e);
    };
    await again.init();
    expect(await fs.readFile(h.cfgFile, "utf8")).toBe('say "my own personal config"\n');
    expect(codes).toContain("cfg-foreign-file");
    await again.close();
  });

  it("'clear' withdraws the message, and a click that was still being processed cannot bring it back", async () => {
    h = await bootApp();
    const t = Date.now();
    await h.app.prepareCfg("to be withdrawn", "all", "direct", { clickedAt: t });
    await h.app.clearPrepared();
    expect(await h.hasSay()).toBe(false);
    expect((await h.app.getState()).prepared).toBeNull();
    expect(h.events.some((e) => e.type === "cfg-cleared")).toBe(true);
    await expect(h.app.prepareCfg("slow click made before the clear", "all", "translated", { clickedAt: t + 1 })).rejects.toBeInstanceOf(PrepareSupersededError);
    expect(await h.hasSay()).toBe(false);
    await h.app.prepareCfg("a new click after the clear", "all", "direct");
    expect(await h.hasSay()).toBe(true);
  });

  it("changing the send key or file name keeps working and never leaves a message behind the wrong file", async () => {
    h = await bootApp();
    await h.app.prepareCfg("on the old file", "all", "direct");
    await h.app.updateSettings({ cs2: { bindKey: "f8", cfgFileName: "my_chat.cfg" } });
    expect((await h.app.getState()).prepared).toBeNull();
    const idle = await fs.readFile(path.join(h.cfgDir, "my_chat.cfg"), "utf8");
    expect(idle).toContain("Nothing is prepared");
    const p = await h.app.prepareCfg("on the new file", "all", "direct");
    expect(p.bindCommand).toBe('bind "f8" "exec my_chat.cfg"');
    expect(await fs.readFile(path.join(h.cfgDir, "my_chat.cfg"), "utf8")).toContain('say "on the new file"');
  });
});

describe("HTTP API", () => {
  const post = (w: WebHarness, p: string, body: unknown) =>
    fetch(w.base + p, { method: "POST", headers: { "x-cs2t-token": w.token, "content-type": "application/json" }, body: JSON.stringify(body) });

  it("prepares typed text without any translation call, in order, and reports a superseded click as 409", async () => {
    const fetchMock = googleFetch();
    const w = await bootWeb({ fetchMock });
    h = w;
    const t = Date.now();
    const ok = await post(w, "/api/cfg", { message: "straight to the game", channel: "all", mode: "direct", clickedAt: t + 100 });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { prepared: CfgPrepared };
    expect(body.prepared).toMatchObject({ mode: "direct", lines: ["straight to the game"], clickedAt: t + 100 });
    expect(fetchMock).not.toHaveBeenCalled();

    const late = await post(w, "/api/cfg", { message: "older translated message", channel: "all", mode: "translated", clickedAt: t + 50, original: "x" });
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: string }).error).toBe("superseded");
    expect(await says()).toEqual(['say "straight to the game"']);
  });

  it("defaults to translated mode for older clients, validates input, and offers a clear endpoint", async () => {
    const w = await bootWeb();
    h = w;
    const legacy = await post(w, "/api/cfg", { message: "from an older client", channel: "team" });
    expect(((await legacy.json()) as { prepared: CfgPrepared }).prepared.mode).toBe("translated");
    for (const bad of [{ message: "x", channel: "all", mode: "weird" }, { message: "x", channel: "all", clickedAt: -5 }, { message: "", channel: "all" }, { message: "x", channel: "everyone" }]) {
      expect((await post(w, "/api/cfg", bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await post(w, "/api/cfg/clear", {})).status).toBe(200);
    expect(await w.hasSay()).toBe(false);
    expect(((await (await fetch(w.base + "/api/state", { headers: { "x-cs2t-token": w.token } })).json()) as { prepared: unknown }).prepared).toBeNull();
    expect((await fetch(w.base + "/api/cfg/clear", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
  });
});

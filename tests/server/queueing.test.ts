import { describe, expect, it } from "vitest";
import { pickPath, PickerBusyError, safeTitle } from "../../src/server/picker";
import { WorkQueue } from "../../src/translation/queue";
import { TranslationService } from "../../src/translation/service";
import { TranslationError, type TranslationEngine } from "../../src/translation/types";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("stale chat jobs", () => {
  it("skips only jobs that waited too long and have not started; fresh ones still run", async () => {
    let now = 0;
    const q = new WorkQueue({ concurrency: 1, now: () => now });
    let release!: () => void;
    const ran: string[] = [];
    const first = q.add("chat", () => new Promise<void>((r) => (release = r)).then(() => void ran.push("first")), { staleAfterMs: 5000 });
    const old = q.add("chat", async () => void ran.push("old"), { staleAfterMs: 5000 });
    const oldResult = old.then(() => "ran", (e: TranslationError) => e.code);
    now = 6000; // `old` has now waited 6 s
    const fresh = q.add("chat", async () => void ran.push("fresh"), { staleAfterMs: 5000 });
    release();
    await first;
    await fresh;
    expect(await oldResult).toBe("stale");
    expect(ran).toEqual(["first", "fresh"]); // the running job was never interrupted
  });

  it("never marks user-initiated jobs stale, and 0 disables the window", async () => {
    let now = 0;
    const q = new WorkQueue({ concurrency: 1, now: () => now });
    let release!: () => void;
    const blocker = q.add("chat", () => new Promise<void>((r) => (release = r)));
    const user = q.add("user", async () => "user ran", { staleAfterMs: 1 });
    const never = q.add("chat", async () => "never-stale ran", { staleAfterMs: 0 });
    now = 10 * 60_000;
    release();
    await blocker;
    await expect(user).resolves.toBe("user ran");
    await expect(never).resolves.toBe("never-stale ran");
  });

  it("reports queue depth", async () => {
    const q = new WorkQueue({ concurrency: 1 });
    let release!: () => void;
    const a = q.add("chat", () => new Promise<void>((r) => (release = r)));
    void q.add("chat", async () => 1);
    void q.add("chat", async () => 2);
    expect(q.running).toBe(1);
    expect(q.waiting).toBe(2);
    release();
    await a;
    await tick();
    expect(q.size).toBe(0);
  });
});

function engineOf(impl: TranslationEngine["translate"]): TranslationEngine {
  return { id: "google", translate: impl };
}
const done = (text: string, detectedSource = "ja") => async () => ({ text, detectedSource });
const svc = (google: TranslationEngine, gemini: TranslationEngine = google, extra: Partial<ConstructorParameters<typeof TranslationService>[0]> = {}) =>
  new TranslationService({ engines: { google, gemini }, sleep: async () => undefined, ...extra });
const ask = (s: TranslationService, text: string, over: Record<string, unknown> = {}) =>
  s.translate({ text, target: "en", engine: "google", priority: "chat", ...over } as Parameters<TranslationService["translate"]>[0]);

describe("service: filter, cache and stats", () => {
  it("counts filtered messages and never calls a provider for them", async () => {
    let calls = 0;
    const s = svc(engineOf(async () => (calls++, { text: "x", detectedSource: "ja" })));
    for (const t of ["666", "!!!", "😀"]) expect((await ask(s, t)).status).toBe("skipped");
    expect(calls).toBe(0);
    expect(s.stats().filtered).toBe(3);
  });

  it("translates digits and symbols when the smart filter is off", async () => {
    let calls = 0;
    const s = svc(engineOf(async () => (calls++, { text: "six", detectedSource: "ja" })));
    expect((await ask(s, "666", { smartFilter: false })).status).toBe("done");
    expect(calls).toBe(1);
    expect(s.stats().filtered).toBe(0);
  });

  it("the cache can be switched off, while concurrent identical requests are still merged", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = svc(engineOf(async () => (calls++, await gate, { text: "hi", detectedSource: "fr" })));
    const a = ask(s, "salut", { useCache: false });
    const b = ask(s, "salut", { useCache: false });
    release();
    await Promise.all([a, b]);
    expect(calls).toBe(1); // merged in flight
    await ask(s, "salut", { useCache: false });
    expect(calls).toBe(2); // no cache: asked again
    const st = s.stats();
    expect(st.cacheHits).toBe(0);
    expect(st.cacheLookups).toBe(0);
  });

  it("counts cache hits and measures provider latency from real timings", async () => {
    let now = 1000;
    const s = svc(engineOf(async () => ((now += 120), { text: "hello", detectedSource: "es" })), undefined, { now: () => now });
    await ask(s, "hola");
    await ask(s, "hola");
    await ask(s, "hola");
    const st = s.stats();
    expect(st).toMatchObject({ cacheHits: 2, cacheLookups: 3, completed: 1, failed: 0, avgLatencyMs: 120, waiting: 0, running: 0 });
  });

  it("starts with no latency figure instead of a made-up number", () => {
    expect(svc(engineOf(done("x"))).stats().avgLatencyMs).toBeNull();
  });

  it("counts stale skips separately from failures", async () => {
    let now = 0;
    const slow = new WorkQueue({ concurrency: 1, now: () => now });
    let release!: () => void;
    const s = svc(engineOf(() => new Promise((r) => (release = () => r({ text: "ok", detectedSource: "ja" })))), undefined, { queues: { google: slow }, now: () => now });
    const first = ask(s, "first message");
    await tick();
    const late = ask(s, "second message", { staleAfterMs: 1000 });
    const lateOutcome = late.then(() => "ok", (e: TranslationError) => e.code);
    now = 5000;
    release();
    await first;
    expect(await lateOutcome).toBe("stale");
    expect(s.stats()).toMatchObject({ stale: 1, failed: 0, completed: 1 });
  });
});

describe("service: provider trouble must not block the chat", () => {
  it("opens a circuit breaker after repeated network failures, then recovers", async () => {
    let now = 0;
    let calls = 0;
    let healthy = false;
    const s = svc(
      engineOf(async () => {
        calls++;
        if (!healthy) throw new TranslationError("network", "down", true);
        return { text: "ok", detectedSource: "ja" };
      }),
      undefined,
      { now: () => now },
    );
    await expect(ask(s, "one")).rejects.toMatchObject({ code: "network" });
    expect(calls).toBe(3); // 3 attempts → breaker opens
    await expect(ask(s, "two")).rejects.toMatchObject({ code: "network" });
    await expect(ask(s, "three")).rejects.toMatchObject({ code: "network" });
    expect(calls).toBe(3); // later messages fail instantly, without spending timeouts
    healthy = true;
    now += 11_000;
    expect((await ask(s, "four")).status).toBe("done");
    expect(calls).toBe(4);
  });

  it("a hung provider cannot starve the other one (separate queues)", async () => {
    const hung = engineOf(() => new Promise(() => undefined));
    const fine = engineOf(done("hello", "es"));
    const s = svc(hung, fine);
    for (let i = 0; i < 6; i++) void ask(s, `stuck ${i}`, { engine: "google" }).catch(() => undefined);
    const out = await ask(s, "hola", { engine: "gemini" });
    expect(out).toMatchObject({ status: "done", engine: "gemini" });
  });

  it("a quota error puts that engine on a cool-down without affecting the other", async () => {
    let geminiCalls = 0;
    const quota = engineOf(async () => (geminiCalls++, Promise.reject(new TranslationError("quota", "429", false, 30_000))));
    const fine = engineOf(done("hello", "es"));
    const s = svc(fine, quota);
    await expect(ask(s, "a one", { engine: "gemini" })).rejects.toMatchObject({ code: "quota" });
    await expect(ask(s, "b two", { engine: "gemini" })).rejects.toMatchObject({ code: "quota" });
    expect(geminiCalls).toBe(1);
    expect((await ask(s, "c three", { engine: "google" })).status).toBe("done");
  });
});

describe("native file dialog helper", () => {
  it("removes control characters and caps the title length", () => {
    expect(safeTitle("Select\r\nfile\u0000!")).toBe("Selectfile!");
    expect(safeTitle("x".repeat(500))).toHaveLength(120);
    expect(safeTitle(undefined)).toBe("");
  });

  it.skipIf(process.platform !== "win32")("loads the Windows dialog assemblies (dry run) and treats hostile input as plain data", async () => {
    await expect(pickPath({ kind: "file", dryRun: true })).resolves.toBe("ok");
    await expect(pickPath({ kind: "folder", dryRun: true, initialDir: 'C:\\x"; Start-Process calc; "', title: "'; exit 9; '" })).resolves.toBe("ok");
  }, 60000);

  it.skipIf(process.platform !== "win32")("allows only one dialog at a time", async () => {
    const first = pickPath({ kind: "file", dryRun: true });
    await expect(pickPath({ kind: "folder", dryRun: true })).rejects.toBeInstanceOf(PickerBusyError);
    await first;
    await expect(pickPath({ kind: "file", dryRun: true })).resolves.toBe("ok");
  }, 60000);
});

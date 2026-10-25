import { afterEach, describe, expect, it } from "vitest";
import { bootWeb, rawRequest, until, type WebHarness } from "../fixtures/harness";

let h: WebHarness;
afterEach(async () => {
  await h?.stop();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
type ApiResponse = Omit<Response, "json"> & { json(): Promise<Json> };

const api = (path: string, init: RequestInit = {}) =>
  fetch(h.base + path, {
    ...init,
    headers: { "x-cs2t-token": h.token, "content-type": "application/json", ...(init.headers as Record<string, string>) },
  }) as Promise<ApiResponse>;

describe("request guard", () => {
  it("serves the page with the per-run token and strict security headers", async () => {
    h = await bootWeb();
    const res = await fetch(h.base + "/");
    const html = await res.text();
    expect(html).toContain(`content="${h.token}"`);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(h.token.length).toBeGreaterThanOrEqual(40);
  });

  it("rejects API calls without or with a wrong token", async () => {
    h = await bootWeb();
    expect((await fetch(h.base + "/api/state")).status).toBe(401);
    expect((await fetch(h.base + "/api/state", { headers: { "x-cs2t-token": "x".repeat(h.token.length) } })).status).toBe(401);
    expect((await api("/api/state")).status).toBe(200);
  });

  it("blocks DNS-rebinding style Host headers", async () => {
    h = await bootWeb();
    for (const host of ["evil.example.com", `evil.example.com:${h.server.port}`, "127.0.0.1", "localhost:1"]) {
      const r = await rawRequest(h.server.port, { path: "/api/state", headers: { host, "x-cs2t-token": h.token } });
      expect(r.status, `host=${host}`).toBe(421);
    }
    const ok = await rawRequest(h.server.port, { path: "/api/state", headers: { host: `localhost:${h.server.port}`, "x-cs2t-token": h.token } });
    expect(ok.status).toBe(200);
  });

  it("blocks cross-origin and cross-site requests even with the token", async () => {
    h = await bootWeb();
    const bad = await rawRequest(h.server.port, { path: "/api/state", headers: { origin: "https://evil.example", "x-cs2t-token": h.token } });
    expect(bad.status).toBe(403);
    const site = await rawRequest(h.server.port, { path: "/api/state", headers: { "sec-fetch-site": "cross-site", "x-cs2t-token": h.token } });
    expect(site.status).toBe(403);
    const same = await rawRequest(h.server.port, { path: "/api/state", headers: { origin: `http://127.0.0.1:${h.server.port}`, "x-cs2t-token": h.token } });
    expect(same.status).toBe(200);
  });

  it("requires application/json for state-changing requests", async () => {
    h = await bootWeb();
    const r = await rawRequest(h.server.port, {
      method: "PUT",
      path: "/api/runtime",
      headers: { "x-cs2t-token": h.token, "content-type": "text/plain" },
      body: '{"paused":true}',
    });
    expect(r.status).toBe(415);
  });

  it("limits request body size and validates input", async () => {
    h = await bootWeb();
    const big = await api("/api/translate", { method: "POST", body: JSON.stringify({ text: "a".repeat(40_000), target: "en" }) });
    expect(big.status).toBe(413);
    expect((await api("/api/translate", { method: "POST", body: JSON.stringify({ text: "a".repeat(2000), target: "en" }) })).status).toBe(400);
    expect((await api("/api/translate", { method: "POST", body: "{not json" })).status).toBe(400);
    expect((await api("/api/translate", { method: "POST", body: JSON.stringify({ text: "hi" }) })).status).toBe(400);
  });

  it("does not serve files outside the web root", async () => {
    h = await bootWeb();
    for (const p of ["/..%2Fsecret.txt", "/%2e%2e/secret.txt", "/assets/..%5C..%5Csecret.txt", "/../secret.txt"]) {
      const r = await rawRequest(h.server.port, { path: p });
      expect(r.body, p).not.toContain("TOP SECRET");
    }
    expect((await fetch(h.base + "/assets/app.js")).status).toBe(200);
  });

  it("rate limits translation requests", async () => {
    h = await bootWeb();
    const codes: number[] = [];
    for (let i = 0; i < 40; i++) codes.push((await api("/api/translate", { method: "POST", body: JSON.stringify({ text: `hola ${i}`, target: "en" }) })).status);
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    expect(codes.slice(30).every((c) => c === 429)).toBe(true);
  });
});

describe("API", () => {
  it("never exposes the Gemini API key", async () => {
    h = await bootWeb();
    const secret = "AIzaSyDUMMY_KEY_FOR_TESTS_0123456789";
    expect((await api("/api/secrets/gemini", { method: "PUT", body: JSON.stringify({ apiKey: secret }) })).status).toBe(200);
    const state = await (await api("/api/state")).text();
    expect(state).not.toContain(secret);
    expect(JSON.parse(state).settings.secrets.geminiKeyConfigured).toBe(true);
    expect(await (await api("/api/settings", { method: "PUT", body: JSON.stringify({}) })).text()).not.toContain(secret);
    expect(await h.secrets.get("gemini-api-key")).toBe(secret);
    expect((await api("/api/secrets/gemini", { method: "DELETE" })).status).toBe(200);
    expect(JSON.parse(await (await api("/api/state")).text()).settings.secrets.geminiKeyConfigured).toBe(false);
  });

  it("rejects malformed API keys", async () => {
    h = await bootWeb();
    for (const apiKey of ["short", "has space in it 123456", "new\nline-key-0123456789"]) {
      expect((await api("/api/secrets/gemini", { method: "PUT", body: JSON.stringify({ apiKey }) })).status).toBe(400);
    }
  });

  it("validates and persists settings", async () => {
    h = await bootWeb();
    const res = await api("/api/settings", { method: "PUT", body: JSON.stringify({ appearance: { theme: "dark" }, translation: { chatTargetLanguage: "zh_tw" } }) });
    const body = await res.json();
    expect(body.settings.appearance.theme).toBe("dark");
    expect(body.settings.translation.chatTargetLanguage).toBe("zh-TW");
    for (const bad of [
      { appearance: { theme: "neon" } },
      { cs2: { bindKey: 'x" ; quit' } },
      { cs2: { cfgFileName: "../../autoexec.cfg" } },
      { cs2: { cfgFileName: "a/b.cfg" } },
      { translation: { chatTargetLanguage: "klingon" } },
      { translation: { geminiModel: "a b" } },
      { cs2: { chatFormat: { manual: { ct: "[CT]" } } } },
    ]) {
      expect((await api("/api/settings", { method: "PUT", body: JSON.stringify(bad) })).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("translates for the composer and prepares the cfg in two explicit steps", async () => {
    h = await bootWeb();
    const t = await (await api("/api/translate", { method: "POST", body: JSON.stringify({ text: "buenos dias", target: "en" }) })).json();
    expect(t).toMatchObject({ status: "done", text: "T(buenos dias)", engineUsed: "google" });
    const c = await (await api("/api/cfg", { method: "POST", body: JSON.stringify({ message: t.text, channel: "team" }) })).json();
    expect(c.prepared).toMatchObject({ channel: "team", lines: ["T(buenos dias)"], truncated: false });
    expect(await h.cfg()).toContain('say_team "T(buenos dias)"');
  });

  it("reports provider problems with stable error codes", async () => {
    h = await bootWeb({ fetchMock: undefined });
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ translation: { sendEngine: "gemini" } }) });
    await api("/api/secrets/gemini", { method: "PUT", body: JSON.stringify({ apiKey: "AIzaSyDUMMY_KEY_FOR_TESTS_0123456789" }) });
    // Gemini → our mocked fetch returns a Google-shaped body, which Gemini parsing rejects as invalid.
    const res = await api("/api/translate", { method: "POST", body: JSON.stringify({ text: "hola", target: "en" }) });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/^translation-/);
  });

  it("streams events over SSE and clears history", async () => {
    h = await bootWeb();
    const res = await fetch(h.base + "/api/events", { headers: { "x-cs2t-token": h.token } });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    await h.writeLog(["[ALL] Alice: hola"]);
    await until(async () => {
      const { value } = await reader.read();
      buf += dec.decode(value);
      return buf.includes('"type":"translation"') && buf.includes("T(hola)");
    });
    expect(buf).toContain('"sender":"Alice"');
    await api("/api/chat/clear", { method: "POST", body: "{}" });
    expect((await (await api("/api/state")).json()).history).toEqual([]);
    await reader.cancel();
  });

  it("pause is a runtime flag", async () => {
    h = await bootWeb();
    const r = await (await api("/api/runtime", { method: "PUT", body: JSON.stringify({ paused: true }) })).json();
    expect(r.runtime.paused).toBe(true);
  });

  it("returns 404 for unknown routes and never leaks internals on errors", async () => {
    h = await bootWeb();
    expect((await api("/api/nope")).status).toBe(404);
    expect((await fetch(h.base + "/nope.txt")).status).toBe(404);
  });
});

describe("API: paths, filters and dialogs", () => {
  it("validates the new settings", async () => {
    h = await bootWeb();
    const put = (body: unknown) => api("/api/settings", { method: "PUT", body: JSON.stringify(body) });
    expect((await put({ general: { smartFilter: false, translationCache: false } })).status).toBe(200);
    expect((await put({ translation: { staleAfterMs: 0 } })).status).toBe(200);
    expect((await put({ translation: { staleAfterMs: 1000 } })).status).toBe(200);
    expect((await put({ translation: { staleAfterMs: 60000 } })).status).toBe(200);
    for (const bad of [500, 60001, -1, 1500.5, "5000"]) expect((await put({ translation: { staleAfterMs: bad } })).status, String(bad)).toBe(400);
    expect((await put({ cs2: { pathMode: "weird" } })).status).toBe(400);
    expect((await put({ cs2: { logPath: "C:/a\nb" } })).status).toBe(400);
    const state = await (await api("/api/state")).json();
    expect(state.settings.general).toMatchObject({ smartFilter: false, translationCache: false });
    expect(state.settings.translation.staleAfterMs).toBe(60000);
  });

  it("protects the file dialog and re-detect endpoints like every other API call", async () => {
    h = await bootWeb();
    expect((await fetch(h.base + "/api/pick", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "log" }) })).status).toBe(401);
    expect((await fetch(h.base + "/api/paths/redetect", { method: "POST", headers: { "x-cs2t-token": h.token } })).status).toBe(415);
    for (const bad of [{ kind: "exe" }, { kind: "log", title: "x".repeat(500) }, { kind: 5 }, {}]) {
      expect((await api("/api/pick", { method: "POST", body: JSON.stringify(bad) })).status, JSON.stringify(bad)).toBe(400);
    }
    const cross = await rawRequest(h.server.port, { method: "POST", path: "/api/pick", headers: { origin: "https://evil.example", "x-cs2t-token": h.token, "content-type": "application/json" }, body: '{"kind":"log"}' });
    expect(cross.status).toBe(403);
  });

  it("re-detects on request and reports the paths in the state", async () => {
    h = await bootWeb();
    expect((await api("/api/paths/redetect", { method: "POST", body: "{}" })).status).toBe(200);
    const state = await (await api("/api/state")).json();
    expect(state.paths).toMatchObject({ mode: "manual", candidates: [] });
    expect(state.identity).toMatchObject({ authorized: ["Me"] });
    expect(state.runtime.stats).toMatchObject({ waiting: 0, completed: 0, avgLatencyMs: null });
  });
});

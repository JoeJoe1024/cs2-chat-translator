import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiModelCache, isTextTranslationModel, listGeminiModels, toModelInfo } from "../../src/translation/geminiModels";
import { bootApp, bootWeb, type Harness, type WebHarness } from "../fixtures/harness";

const KEY = "AIzaSyDUMMY_KEY_FOR_TESTS_0123456789";

/** Shaped like the official Model resource (https://ai.google.dev/api/models). */
const raw = (id: string, methods: string[], extra: Record<string, unknown> = {}) => ({
  name: `models/${id}`,
  baseModelId: id,
  version: "001",
  displayName: id.replace(/-/g, " "),
  description: `desc of ${id}`,
  inputTokenLimit: 1048576,
  outputTokenLimit: 65536,
  supportedGenerationMethods: methods,
  ...extra,
});

const CATALOG = [
  raw("gemini-3.5-flash-lite", ["generateContent", "countTokens"], { displayName: "Gemini 3.5 Flash-Lite" }),
  raw("gemini-3.1-flash-lite", ["generateContent", "countTokens"], { displayName: "Gemini 3.1 Flash-Lite" }),
  raw("gemini-3.8-flash", ["generateContent", "countTokens", "batchGenerateContent"], { displayName: "Gemini 3.8 Flash" }),
  raw("gemini-3.9-flash-lite", ["generateContent"], { displayName: "Gemini 3.9 Flash-Lite" }), // released after this app: must still appear
  raw("gemini-3.5-pro", ["generateContent"], { displayName: "Gemini 3.5 Pro" }),
  raw("gemini-3.5-flash-preview-05-20", ["generateContent"], { displayName: "Gemini 3.5 Flash Preview" }),
  raw("gemini-3.5-flash-exp", ["generateContent"]),
  raw("gemini-2.0-flash", ["generateContent"]), // older than the supported series
  raw("gemini-flash-latest", ["generateContent"], { displayName: "Gemini Flash Latest" }), // moving alias
  raw("gemini-3.5-flash-live", ["bidiGenerateContent", "generateContent"]),
  raw("gemini-3.5-flash-tts", ["generateContent"]),
  raw("gemini-3.5-flash-image", ["generateContent"]),
  raw("gemini-3.5-flash-native-audio", ["generateContent"]),
  raw("gemini-3.8-flash", ["embedContent"], { name: "models/gemini-3.5-flash-embed" }),
  raw("gemini-embedding-001", ["embedContent"]),
  raw("imagen-4.0-generate-001", ["predict"]),
  raw("veo-3.0-generate-001", ["predictLongRunning"]),
  raw("gemma-3-27b-it", ["generateContent"]),
  raw("aqa", ["generateAnswer"]),
  raw("gemini-3.5-flash-robotics", ["generateContent"]),
  raw("gemini-3.4-flash-lite", ["generateContent"], { displayName: "Gemini 3.4 Flash-Lite", description: "Preview build for testing." }), // right shape, but the description says preview
  raw("gemini-3.5-flash-nobody", ["countTokens"]), // cannot generate text
  { name: "models/weird name!", supportedGenerationMethods: ["generateContent"] },
  { name: "models/no-methods" },
];
const GOOD = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash", "gemini-3.9-flash-lite"];
const goodRaw = (...ids: string[]) => ids.map((id) => CATALOG.find((m) => (m as { name: string }).name === `models/${id}`)!);

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("model list filtering", () => {
  it("keeps only stable Flash / Flash-Lite text models, and leaves out everything else", () => {
    const ids = CATALOG.filter(isTextTranslationModel).map((m) => (m as { name: string }).name.replace("models/", ""));
    expect(ids.sort()).toEqual([...GOOD].sort());
  });

  it("judges text generation and suitability separately", () => {
    expect(isTextTranslationModel(raw("gemini-3.5-flash-lite", ["countTokens"]))).toBe(false); // right series, cannot generate
    expect(isTextTranslationModel(raw("gemini-3.5-pro", ["generateContent"]))).toBe(false); // can generate, wrong series
    expect(isTextTranslationModel(raw("gemini-3.5-flash-lite", ["generateContent"], { displayName: "Gemini 3.5 Flash-Lite Experimental" }))).toBe(false);
  });

  it("is rule based, so a future Flash / Flash-Lite appears but an unknown shape does not", () => {
    expect(isTextTranslationModel(raw("gemini-4-flash", ["generateContent"]))).toBe(true);
    expect(isTextTranslationModel(raw("gemini-4.2-flash-lite-001", ["generateContent"]))).toBe(true);
    expect(isTextTranslationModel(raw("gemini-4-ultra", ["generateContent"]))).toBe(false);
    expect(isTextTranslationModel(raw("gemini-4-flash-thinking", ["generateContent"]))).toBe(false);
  });

  it("extracts friendly names and token limits", () => {
    expect(toModelInfo(raw("gemini-3.5-flash-lite", ["generateContent"], { displayName: "Gemini 3.5 Flash-Lite" }))).toMatchObject({
      id: "gemini-3.5-flash-lite",
      displayName: "Gemini 3.5 Flash-Lite",
      inputTokenLimit: 1048576,
    });
    expect(toModelInfo({ name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] })).toMatchObject({ id: "gemini-3.8-flash", displayName: "gemini-3.8-flash" });
  });
});

describe("listGeminiModels", () => {
  it("follows pagination, drops unsuitable models, ranks recommended > lite > flash and sends the key in a header only", async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = new URL(String(url));
      return u.searchParams.get("pageToken") === "p2"
        ? jsonResponse({ models: goodRaw("gemini-3.1-flash-lite", "gemini-3.8-flash") })
        : jsonResponse({ models: [...goodRaw("gemini-3.5-flash-lite"), CATALOG[4]!], nextPageToken: "p2" });
    });
    const models = await listGeminiModels({ apiKey: KEY, fetchImpl: fetchMock as unknown as typeof fetch });
    expect(models.map((m) => m.id)).toEqual(["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls as unknown as [string, RequestInit & { headers: Record<string, string> }][]) {
      expect(call[0]).toContain("https://generativelanguage.googleapis.com/v1beta/models?");
      expect(call[0]).toContain("pageSize=1000");
      expect(call[0]).not.toContain("AIza");
      expect(call[1].headers["x-goog-api-key"]).toBe(KEY);
    }
  });

  it.each([
    [400, { error: { message: "API key not valid. Please pass a valid API key." } }, "auth"],
    [403, { error: { message: "denied" } }, "permission"],
    [403, { error: { message: "API key expired" } }, "auth"],
    [429, { error: { message: "quota" } }, "quota"],
    [503, {}, "network"],
  ])("maps HTTP %i to %s", async (status, body, code) => {
    const f = async () => jsonResponse(body, status);
    await expect(listGeminiModels({ apiKey: KEY, fetchImpl: f as unknown as typeof fetch })).rejects.toMatchObject({ code });
  });

  it("reports offline and malformed answers", async () => {
    const offline = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(listGeminiModels({ apiKey: KEY, fetchImpl: offline as unknown as typeof fetch })).rejects.toMatchObject({ code: "network" });
    const html = async () => new Response("<html>", { status: 200 });
    await expect(listGeminiModels({ apiKey: KEY, fetchImpl: html as unknown as typeof fetch })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("GeminiModelCache", () => {
  it("persists the last successful list and survives corruption", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs2t-models-"));
    const a = new GeminiModelCache(dir);
    expect(await a.load()).toBeNull();
    await a.save([{ id: "m1", displayName: "M1" }]);
    const b = new GeminiModelCache(dir);
    expect((await b.load())?.models).toEqual([{ id: "m1", displayName: "M1" }]);
    await fs.writeFile(path.join(dir, "gemini-models.json"), "{ not json");
    expect(await new GeminiModelCache(dir).load()).toBeNull();
    expect(JSON.stringify(await fs.readFile(path.join(dir, "gemini-models.json"), "utf8"))).not.toContain("AIza");
  });
});

describe("model list through the app", () => {
  let h: Harness | WebHarness;
  afterEach(async () => {
    await h?.stop();
  });

  const modelsFetch = (state: { fail?: number; body?: unknown }) =>
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("generativelanguage.googleapis.com/v1beta/models?")) {
        return state.fail ? jsonResponse({ error: { message: "nope" } }, state.fail) : jsonResponse(state.body ?? { models: CATALOG });
      }
      if (u.includes(":generateContent")) {
        const model = /models\/([^:]+):generateContent/.exec(u)?.[1];
        return jsonResponse({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ translation: `Bonjour from ${model}`, source_language: "en" }) }] } }] });
      }
      const q = new URLSearchParams(String(init?.body)).get("q") ?? "";
      return new Response(JSON.stringify([[[`T(${q})`, q]], null, "ja"]), { status: 200 });
    });

  it("needs a key, loads the list once one is saved, and exposes no secrets", async () => {
    const state: { fail?: number } = {};
    h = await bootApp({ fetchMock: modelsFetch(state) as never });
    expect(await h.app.refreshGeminiModels()).toMatchObject({ ok: false, code: "auth", models: [] });
    await h.app.setGeminiKey(KEY);
    const r = await h.app.refreshGeminiModels();
    expect(r.ok).toBe(true);
    expect(r.models.map((m) => m.id)).toEqual(["gemini-3.5-flash-lite", "gemini-3.9-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash"]);
    expect(r.selectedAvailable).toBe(true); // the default is the recommended model, which is in the catalogue
    expect(r.live).toBe(true);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("keeps the previous list when a refresh fails and says why", async () => {
    const state: { fail?: number } = {};
    h = await bootApp({ fetchMock: modelsFetch(state) as never });
    await h.app.setGeminiKey(KEY);
    await h.app.refreshGeminiModels();
    state.fail = 429;
    const failed = await h.app.refreshGeminiModels();
    expect(failed).toMatchObject({ ok: false, code: "quota" });
    expect(failed.models).toHaveLength(4);
    expect(failed.live).toBe(true); // it was confirmed earlier in this run
    state.fail = 403;
    expect(await h.app.refreshGeminiModels()).toMatchObject({ ok: false, code: "permission" });
    expect(h.app.geminiModels().models).toHaveLength(4);
  });

  it("never switches the selected model silently when it disappears from Google's list", async () => {
    const state: { body?: unknown } = {};
    h = await bootApp({ fetchMock: modelsFetch(state) as never });
    await h.app.setGeminiKey(KEY);
    await h.app.updateSettings({ translation: { geminiModel: "gemini-3.1-flash-lite" } });
    expect((await h.app.refreshGeminiModels()).selectedAvailable).toBe(true);
    state.body = { models: [CATALOG[0], CATALOG[2]] }; // gemini-3.1-flash-lite retired
    const r = await h.app.refreshGeminiModels();
    expect(r.ok).toBe(true);
    expect(r.selectedAvailable).toBe(false);
    expect(h.app.settings.get().translation.geminiModel).toBe("gemini-3.1-flash-lite"); // still the user's choice
  });

  it("remembers the chosen model across restarts and tests the model that is selected", async () => {
    const fetchMock = modelsFetch({});
    h = await bootApp({ fetchMock: fetchMock as never });
    await h.app.setGeminiKey(KEY);
    await h.app.updateSettings({ translation: { geminiModel: "gemini-3.1-flash-lite" } });
    expect(await h.app.testGeminiKey()).toEqual({ ok: true });
    expect(await h.app.testGeminiKey(undefined, "gemini-3.8-flash")).toEqual({ ok: true });
    const urls = (fetchMock.mock.calls as unknown as [string][]).map((c) => c[0]).filter((u) => u.includes(":generateContent"));
    expect(urls[0]).toContain("models/gemini-3.1-flash-lite:generateContent");
    expect(urls[1]).toContain("models/gemini-3.8-flash:generateContent");
    expect(urls.join()).not.toContain("AIza");
  });

  it("a stored model list survives a restart", async () => {
    const fetchMock = modelsFetch({});
    h = await bootApp({ fetchMock: fetchMock as never });
    await h.app.setGeminiKey(KEY);
    await h.app.refreshGeminiModels();
    const dir = path.join(h.dir, "config");
    const { App } = await import("../../src/server/app");
    const { MemorySecretStore } = await import("../../src/config/secrets");
    const again = new App({ configDir: dir, secrets: new MemorySecretStore(), installs: [], personaNames: [] });
    await again.init();
    expect(again.geminiModels().models).toHaveLength(4);
    expect(again.geminiModels().live).toBe(false); // only "last known" until Google answers again
    await again.close();
  });

  it("serves the list and test endpoints over the authenticated API", async () => {
    h = await bootWeb({ fetchMock: modelsFetch({}) as never });
    const web = h as WebHarness;
    const api = (p: string, init: RequestInit = {}) =>
      fetch(web.base + p, { ...init, headers: { "x-cs2t-token": web.token, "content-type": "application/json" } });
    await api("/api/secrets/gemini", { method: "PUT", body: JSON.stringify({ apiKey: KEY }) });
    const refreshed = (await (await api("/api/gemini/models/refresh", { method: "POST", body: "{}" })).json()) as { ok: boolean };
    expect(refreshed.ok).toBe(true);
    const listed = await (await api("/api/gemini/models")).text();
    expect(listed).toContain("gemini-3.5-flash-lite");
    expect(listed).not.toContain(KEY);
    const tested = (await (await api("/api/secrets/gemini/test", { method: "POST", body: JSON.stringify({ model: "gemini-3.1-flash-lite" }) })).json()) as { ok: boolean };
    expect(tested.ok).toBe(true);
    expect((await api("/api/secrets/gemini/test", { method: "POST", body: JSON.stringify({ model: "bad model!" }) })).status).toBe(400);
    expect((await fetch(web.base + "/api/gemini/models")).status).toBe(401);
  });
});

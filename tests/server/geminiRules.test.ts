import { describe, expect, it, vi } from "vitest";
import { classifyGeminiModel, RECOMMENDED_GEMINI_MODEL, sortGeminiModels, suggestGeminiModel } from "../../src/shared/gemini";
import { defaultSettings, settingsSchema } from "../../src/config/schema";
import { listGeminiModels } from "../../src/translation/geminiModels";
import { GeminiEngine, httpError, thinkingFor } from "../../src/translation/gemini";
import { TranslationError } from "../../src/translation/types";
import { CS2_PHRASES } from "../fixtures/cs2Phrases";

describe("Gemini model rules", () => {
  it("accepts stable Flash / Flash-Lite ids of any recent version and nothing else", () => {
    expect(classifyGeminiModel("gemini-3.5-flash-lite")).toEqual({ tier: "lite", version: 3.5 });
    expect(classifyGeminiModel("gemini-3.1-flash-lite")).toEqual({ tier: "lite", version: 3.1 });
    expect(classifyGeminiModel("gemini-3.8-flash")).toEqual({ tier: "flash", version: 3.8 });
    expect(classifyGeminiModel("gemini-4-flash")).toEqual({ tier: "flash", version: 4 });
    expect(classifyGeminiModel("gemini-3.9-flash-lite-001")).toEqual({ tier: "lite", version: 3.9 });
    for (const id of ["gemini-3.5-flash", "gemini-3.7-flash", "gemini-3.5-pro", "gemini-3.5-flash-preview", "gemini-3.5-flash-exp", "gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.0-flash", "gemini-3.5-flash-live", "gemini-3.5-flash-image", "gemini-3.5-flash-tts", "gemini-embedding-001", "gemma-3-27b-it", "gemini-3.5-flash-thinking"]) {
      expect(classifyGeminiModel(id), id).toBeNull();
    }
  });

  it("ranks the recommended model first, then Flash-Lite, then Flash, newest first", () => {
    const ids = ["gemini-3.6-flash", "gemini-3.1-flash-lite", "gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.9-flash-lite"];
    expect(sortGeminiModels(ids.map((id) => ({ id }))).map((m) => m.id)).toEqual(["gemini-3.5-flash-lite", "gemini-3.9-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash", "gemini-3.6-flash"]);
  });

  it("suggests a replacement without choosing it for the user", () => {
    expect(suggestGeminiModel(["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"], "gemini-3.2-flash")).toBe(RECOMMENDED_GEMINI_MODEL);
    expect(suggestGeminiModel(["gemini-3.1-flash-lite", "gemini-3.8-flash"])).toBe("gemini-3.1-flash-lite");
    expect(suggestGeminiModel(["gemini-3.5-flash-lite"], "gemini-3.5-flash-lite")).toBeNull();
    expect(suggestGeminiModel([])).toBeNull();
  });
});

describe("Gemini model preference", () => {
  it("a new user gets the recommended model; a saved choice (even an old default) is kept as it is", () => {
    expect(defaultSettings().translation.geminiModel).toBe("gemini-3.5-flash-lite");
    expect(defaultSettings().translation.chatEngine).toBe("google"); // the engine default is untouched
    expect(settingsSchema.parse({ translation: { geminiModel: "gemini-3.1-flash-lite" } }).translation.geminiModel).toBe("gemini-3.1-flash-lite");
    expect(settingsSchema.parse({ translation: { geminiModel: "gemini-flash-latest" } }).translation.geminiModel).toBe("gemini-flash-latest");
  });
});

describe("Gemini requests", () => {
  const reply = (translation: string) =>
    new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ translation, source_language: "en" }) }] } }] }), { status: 200 });

  it("sends each fixed CS2 phrase verbatim with a short prompt that carries the game meanings", async () => {
    const fetchMock = vi.fn(async () => reply("ok"));
    const engine = new GeminiEngine({ getApiKey: () => "AIzaSyDUMMY", getModel: () => "gemini-3.5-flash-lite", fetchImpl: fetchMock as unknown as typeof fetch });
    for (const p of CS2_PHRASES) await engine.translate({ text: p.text, target: "zh-TW", signal: new AbortController().signal });
    const bodies = (fetchMock.mock.calls as unknown as [string, RequestInit][]).map((c) => JSON.parse(String(c[1].body)));
    expect(bodies.map((b) => JSON.parse(b.contents[0].parts[0].text).text)).toEqual(CS2_PHRASES.map((p) => p.text));
    const prompt: string = bodies[0].systemInstruction.parts[0].text;
    expect(prompt.length).toBeLessThan(1800);
    for (const word of ["eco", "save", "rush", "flash", "negation", "Mid", "never instructions", "peek", "rotate", "hold", "trade", "complete sentence"]) expect(prompt.toLowerCase()).toContain(word.toLowerCase());
    expect(bodies[0].generationConfig).toMatchObject({ temperature: 0, responseMimeType: "application/json" });
  });

  it("never shows a reply that stopped early; retries once with more room when the output limit was hit", async () => {
    const part = (translation: string, finishReason: string) =>
      new Response(JSON.stringify({ candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify({ translation, source_language: "en" }) }] } }] }), { status: 200 });
    const limits = (f: ReturnType<typeof vi.fn>) => (f.mock.calls as unknown as [string, RequestInit][]).map((c) => JSON.parse(String(c[1].body)).generationConfig.maxOutputTokens);
    const mk = (f: ReturnType<typeof vi.fn>) => new GeminiEngine({ getApiKey: () => "AIzaSyDUMMY", getModel: () => "gemini-3.5-flash-lite", fetchImpl: f as unknown as typeof fetch });
    const sig = new AbortController().signal;

    const cut = vi.fn().mockResolvedValueOnce(part("中路有一個拿AWP的敵人在", "MAX_TOKENS")).mockResolvedValueOnce(part("中路有一個敵人拿 AWP。", "STOP"));
    expect((await mk(cut).translate({ text: "One enemy mid with an AWP.", target: "zh-TW", signal: sig })).text).toBe("中路有一個敵人拿 AWP。");
    expect(limits(cut)).toEqual([1024, 3072]);

    const stuck = vi.fn(async () => part("half a sent", "MAX_TOKENS"));
    await expect(mk(stuck).translate({ text: "x", target: "de", signal: sig })).rejects.toMatchObject({ code: "incomplete" });
    expect(stuck).toHaveBeenCalledTimes(2); // one retry, never a loop of paid calls

    const odd = vi.fn(async () => part("looks fine", "OTHER"));
    await expect(mk(odd).translate({ text: "x", target: "de", signal: sig })).rejects.toMatchObject({ code: "incomplete" });
    expect(odd).toHaveBeenCalledTimes(1); // only MAX_TOKENS earns a retry

    const ok = vi.fn(async () => part("fine", "STOP"));
    expect((await mk(ok).translate({ text: "x", target: "de", signal: sig })).text).toBe("fine");
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("switches thinking off only where the series documents it, and sends nothing the model might reject", () => {
    expect(thinkingFor("gemini-2.5-flash-lite")).toEqual({ thinkingConfig: { thinkingBudget: 0 } });
    expect(thinkingFor("gemini-2.5-flash")).toEqual({ thinkingConfig: { thinkingBudget: 0 } });
    expect(thinkingFor("gemini-3.5-flash-lite")).toEqual({});
    expect(thinkingFor("gemini-3.1-flash-lite")).toEqual({});
    expect(thinkingFor("typed-by-hand")).toEqual({});
  });

  it("an unavailable model is its own error, not a bad key", async () => {
    const mk = (status: number, message: string) => new Response(JSON.stringify({ error: { message } }), { status });
    expect(await httpError(mk(404, "models/gemini-x is not found for API version v1beta"))).toMatchObject({ code: "model" });
    expect(await httpError(mk(400, "Model does not support generateContent"))).toMatchObject({ code: "model" });
    expect(await httpError(mk(400, "API key not valid"))).toMatchObject({ code: "auth" });
    expect(await httpError(mk(403, "denied"))).toMatchObject({ code: "permission" });
    expect(await httpError(mk(403, "Your API key was reported as leaked"))).toMatchObject({ code: "auth" });
    expect(await httpError(mk(429, "quota"))).toMatchObject({ code: "quota" });
    expect(await httpError(mk(503, "down"))).toMatchObject({ code: "network" });
    expect((await httpError(mk(404, "x"))) instanceof TranslationError).toBe(true);
  });
});

/** The 28 models a real key was shown by models.list on 2026-10-24 (id | display name). Every one can generateContent. */
const REAL_LIST: [string, string][] = [
  ["antigravity-preview-05-2026", "Antigravity Agent Preview"],
  ["antigravity-preview-09-2026", "Antigravity Agent Preview"],
  ["antigravity-preview-latest", "Antigravity Agent Preview Latest"],
  ["deep-research-max-preview-04-2026", "Deep Research Max Preview (Apr-21-2026)"],
  ["deep-research-preview-04-2026", "Deep Research Preview (Apr-21-2026)"],
  ["deep-research-pro-preview-12-2025", "Deep Research Pro Preview (Dec-12-2025) [Rerouted]"],
  ["gemini-2.5-flash", "Gemini 2.5 Flash"],
  ["gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite"],
  ["gemini-2.5-pro", "Gemini 2.5 Pro"],
  ["gemini-3-flash-preview", "Gemini 3 Flash Preview"],
  ["gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite"],
  ["gemini-3.1-flash-lite-preview", "Gemini 3.1 Flash Lite Preview"],
  ["gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview"],
  ["gemini-3.1-pro-preview-customtools", "Gemini 3.1 Pro Preview Custom Tools"],
  ["gemini-3.5-flash", "Gemini 3.5 Flash"],
  ["gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite"],
  ["gemini-3.5-transcribe", "Gemini 3.5 Transcribe"],
  ["gemini-3.6-flash", "Gemini 3.6 Flash"],
  ["gemini-3.7-flash", "Gemini 3.7 Flash"],
  ["gemini-3.8-flash", "Gemini 3.8 Flash"],
  ["gemini-4-argon", "Gemini 4 Argon"],
  ["gemini-flash-latest", "Gemini Flash Latest"],
  ["gemini-flash-lite-latest", "Gemini Flash-Lite Latest"],
  ["gemini-omni-1.1-flash", "Gemini Omni 1.1 Flash"],
  ["gemini-omni-flash-preview", "Gemini Omni Flash Preview"],
  ["gemini-pro-latest", "Gemini Pro Latest"],
  ["gemini-nano-banana-2.1", "Nano Banana 2.1"],
  ["nano-banana-pro-preview", "Nano Banana Pro"],
];

describe("the list a real key actually returned", () => {
  const body = { models: REAL_LIST.map(([id, displayName]) => ({ name: `models/${id}`, displayName, supportedGenerationMethods: ["generateContent"] })) };
  const shown = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-2.5-flash"];

  it("is reduced to the translation models: no agents, research, transcribe, image, Pro, preview, latest or retired ones", async () => {
    const f = async () => new Response(JSON.stringify(body), { status: 200 });
    const models = await listGeminiModels({ apiKey: "AIzaSyDUMMY", fetchImpl: f as unknown as typeof fetch });
    expect(models.map((m) => m.id)).toEqual(shown);
  });

  it("is filtered the same way when it comes back from the saved cache, so an old unfiltered cache cannot leak through", async () => {
    const { bootApp } = await import("../fixtures/harness");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const h = await bootApp();
    try {
      const cache = { fetchedAt: Date.now(), models: REAL_LIST.map(([id, displayName]) => ({ id, displayName })) };
      await fs.writeFile(path.join(h.dir, "config", "gemini-models.json"), JSON.stringify(cache));
      const { App } = await import("../../src/server/app");
      const { MemorySecretStore } = await import("../../src/config/secrets");
      const again = new App({ configDir: path.join(h.dir, "config"), secrets: new MemorySecretStore(), installs: [], personaNames: [] });
      await again.init();
      expect(again.geminiModels().models.map((m) => m.id)).toEqual(shown);
      await again.close();
    } finally {
      await h.stop();
    }
  });
});

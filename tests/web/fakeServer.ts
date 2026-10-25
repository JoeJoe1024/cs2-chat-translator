import { vi } from "vitest";
import { defaultSettings } from "../../src/config/schema";
import type { AppState, ChatEntry, ServerEvent } from "../../src/shared/protocol";

export function makeState(over: Partial<AppState> = {}): AppState {
  return {
    version: "test",
    settings: { ...defaultSettings(), secrets: { geminiKeyConfigured: false, geminiKeyState: "missing" } },
    watcher: { state: "watching", logPath: "C:/cs2/console.log" },
    format: {
      mode: "auto",
      activeLanguages: ["tchinese", "english"],
      detectedLanguage: "tchinese",
      evidence: [{ language: "tchinese", source: "console-log", detail: "x" }],
      templateSource: "game-files",
      matched: [],
      unrecognized: [],
    },
    paths: {
      mode: "auto",
      logPath: "C:/cs2/console.log",
      logExists: true,
      logNameUnusual: false,
      cfgDir: "C:/cs2/cfg",
      cfgDirExists: true,
      cfgDirWritable: true,
      steamRoot: "C:/Steam",
      candidates: [{ gameDir: "C:/cs2", logPath: "C:/cs2/console.log", logExists: true, logModifiedAt: 1_700_000_000_000, selected: true }],
      needsChoice: false,
      canBrowse: true,
    },
    runtime: { paused: false, queued: 0, stats: { waiting: 0, running: 0, avgLatencyMs: null, local: 0, cacheHits: 0, cacheLookups: 0, filtered: 0, stale: 0, completed: 0, failed: 0 } },
    secureStorage: "dpapi",
    prepared: null,
    identity: { authorized: ["Me"], manual: ["Me"], logConfirmed: null, steam: "Me", suggestSteam: false },
    history: [],
    ...over,
  };
}

export function entry(over: Partial<ChatEntry> & { id: string }): ChatEntry {
  return {
    at: Date.parse("2026-10-24T12:00:00Z"),
    channel: "all",
    sender: "Alice",
    dead: false,
    text: "hola",
    isSelf: false,
    formatId: "english:Cstrike_Chat_All",
    translation: { id: over.id, status: "done", text: "hello", sourceLanguage: "es", engine: "google" },
    ...over,
  };
}

/** Stands in for the local service: answers /api calls and lets a test push SSE events. */
export type Override = (call: { method: string; path: string; body: unknown }) => Response | undefined | Promise<Response | undefined>;

export function installFakeServer(state: AppState, override?: { current: Override | undefined }) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let push: (e: ServerEvent) => void = () => undefined;
  const encoder = new TextEncoder();
  let current = state;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const custom = await override?.current?.({ method, path, body });
    if (custom) return custom;
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

    if (path === "/api/events") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (e) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (path === "/api/state") return json(current);
    if (path === "/api/gemini/models") return json({ models: [], fetchedAt: null, selectedAvailable: null });
    if (path === "/api/settings" && method === "PUT") {
      const patch = body as { appearance?: Partial<AppState["settings"]["appearance"]>; cs2?: Record<string, unknown>; general?: Record<string, unknown>; translation?: Record<string, unknown>; dictionary?: Record<string, unknown>; quick?: Record<string, unknown> };
      if (patch.appearance) current = { ...current, settings: { ...current.settings, appearance: { ...current.settings.appearance, ...patch.appearance } } };
      current = {
        ...current,
        settings: {
          ...current.settings,
          general: { ...current.settings.general, ...patch.general },
          translation: { ...current.settings.translation, ...patch.translation },
          cs2: { ...current.settings.cs2, ...patch.cs2 },
          dictionary: { ...current.settings.dictionary, ...patch.dictionary },
          quick: { ...current.settings.quick, ...patch.quick },
        },
      } as AppState;
      return json({ settings: current.settings });
    }
    if (path === "/api/translate") return json({ status: "done", text: "Hallo Welt", target: "de", engine: "google", engineUsed: "google", sourceLanguage: "en" });
    if (path === "/api/cfg") {
      const b = body as { message: string; channel: "all" | "team"; mode: "translated" | "direct"; clickedAt: number; original?: string };
      const prepared = {
        id: `p${calls.length}`,
        mode: b.mode,
        channel: b.channel,
        lines: [b.message],
        ...(b.original !== undefined ? { original: b.original } : {}),
        file: "C:/cs2/cfg/chat_reader.cfg",
        truncated: false,
        preparedAt: b.clickedAt,
        clickedAt: b.clickedAt,
        bindCommand: `bind "${current.settings.cs2.bindKey}" "exec ${current.settings.cs2.cfgFileName}"`,
      };
      current = { ...current, prepared };
      return json({ prepared });
    }
    if (path === "/api/cfg/clear") {
      current = { ...current, prepared: null };
      return json({ ok: true });
    }
    return json({ ok: true });
  });

  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    emit: (e: ServerEvent) => push(e),
    setState: (s: AppState) => (current = s),
  };
}

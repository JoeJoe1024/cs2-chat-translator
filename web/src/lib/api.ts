import type { SettingsPatch } from "../../../src/config/schema";
import type { AppState, CfgPrepared, PublicSettings, RuntimeStatus, ServerEvent, TranslationUpdate } from "@shared/protocol";

export interface GeminiModel {
  id: string;
  displayName: string;
  description?: string;
}

export interface GeminiModelsView {
  models: GeminiModel[];
  fetchedAt: number | null;
  selectedAvailable: boolean | null;
  /** Google answered during this run (otherwise the list is only the last known one). */
  live: boolean;
}

const token = () => document.querySelector<HTMLMetaElement>('meta[name="cs2t-token"]')?.content ?? "";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: { path: string; message: string }[],
  ) {
    super(code);
  }
}

async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method,
    signal,
    headers: { "x-cs2t-token": token(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; detail?: { path: string; message: string }[] };
  if (!res.ok) throw new ApiError(res.status, data.error ?? "request-failed", data.detail);
  return data as T;
}

export type TranslateResponse =
  | { status: "done"; text: string; sourceLanguage?: string; target: string; engine: string; engineUsed: "google" | "gemini" }
  | { status: "skipped"; reason: string; text: string; engineUsed: "google" | "gemini" };

export const api = {
  state: () => call<AppState>("GET", "/api/state"),
  updateSettings: (patch: SettingsPatch) => call<{ settings: PublicSettings }>("PUT", "/api/settings", patch),
  setGeminiKey: (apiKey: string) => call<{ configured: boolean }>("PUT", "/api/secrets/gemini", { apiKey }),
  clearGeminiKey: () => call<{ configured: boolean }>("DELETE", "/api/secrets/gemini"),
  testGeminiKey: (apiKey?: string, model?: string) =>
    call<{ ok: boolean; code?: string }>("POST", "/api/secrets/gemini/test", { ...(apiKey ? { apiKey } : {}), ...(model ? { model } : {}) }),
  geminiModels: () => call<GeminiModelsView>("GET", "/api/gemini/models"),
  refreshGeminiModels: () => call<GeminiModelsView & { ok: boolean; code?: string }>("POST", "/api/gemini/models/refresh", {}),
  pick: (kind: "log" | "cfg", title: string) =>
    call<{ path: string | null; warning?: "not-console-log" | "not-a-folder" }>("POST", "/api/pick", { kind, title }),
  redetect: () => call<{ ok: true }>("POST", "/api/paths/redetect", {}),
  translate: (text: string, target: string) => call<TranslateResponse>("POST", "/api/translate", { text, target }),
  /** `clickedAt` orders preparations: the server rejects (409 superseded) one whose click is older than a prepared one. */
  prepareCfg: (message: string, channel: "all" | "team", mode: "translated" | "direct", clickedAt: number, original?: string) =>
    call<{ prepared: CfgPrepared }>("POST", "/api/cfg", { message, channel, mode, clickedAt, ...(original !== undefined ? { original } : {}) }),
  clearPrepared: () => call<{ ok: true }>("POST", "/api/cfg/clear", {}),
  translateMessage: (id: string) => call<{ update: TranslationUpdate }>("POST", "/api/chat/translate", { id }),
  clearChat: () => call<{ ok: true }>("POST", "/api/chat/clear", {}),
  setPaused: (paused: boolean) => call<{ runtime: RuntimeStatus }>("PUT", "/api/runtime", { paused }),
  restartWatcher: () => call<{ ok: true }>("POST", "/api/watcher/restart", {}),
};

/**
 * Server-Sent Events over fetch (EventSource cannot send the auth header).
 * Reconnects with a small delay; `onOpen` fires after every (re)connect so the caller can resync.
 */
export function connectEvents(handlers: {
  onEvent: (e: ServerEvent) => void;
  onOpen: () => void;
  onClose: () => void;
}): () => void {
  const ctl = new AbortController();
  let stopped = false;

  const run = async () => {
    while (!stopped) {
      try {
        const res = await fetch("/api/events", { headers: { "x-cs2t-token": token() }, signal: ctl.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        handlers.onOpen();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const data = frame
              .split("\n")
              .filter((l) => l.startsWith("data: "))
              .map((l) => l.slice(6))
              .join("\n");
            if (data) {
              try {
                handlers.onEvent(JSON.parse(data) as ServerEvent);
              } catch {
                /* ignore malformed frame */
              }
            }
          }
        }
      } catch {
        if (stopped) return;
      }
      handlers.onClose();
      if (!stopped) await new Promise((r) => setTimeout(r, 1500));
    }
  };
  void run();
  return () => {
    stopped = true;
    ctl.abort();
  };
}

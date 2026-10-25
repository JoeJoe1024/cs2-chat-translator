// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../../src/shared/protocol";
import { App } from "../../web/src/App";
import { installFakeServer, makeState, type Override } from "./fakeServer";

beforeEach(() => {
  document.head.innerHTML = '<meta name="cs2t-token" content="test-token">';
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }),
  });
  Object.defineProperty(navigator, "language", { value: "en-US", configurable: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-theme");
  localStorage.clear();
});

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

async function open(tab: "General" | "Translation" | "CS2" | "Appearance", state: AppState = makeState(), override?: Override) {
  const ref = { current: override };
  const server = installFakeServer(state, ref);
  render(<App />);
  await screen.findByRole("log");
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.click(screen.getByRole("tab", { name: tab }));
  return { server, ref };
}

const settingsCalls = (calls: { method: string; path: string; body: unknown }[]) => calls.filter((c) => c.path === "/api/settings" && c.method === "PUT").map((c) => c.body);

describe("Gemini: key guide and model list", () => {
  const stateWithKey = () => {
    const s = makeState();
    s.settings.secrets = { geminiKeyConfigured: true, geminiKeyState: "configured" };
    return s;
  };
  const models = {
    models: [
      { id: "gemini-3.5-flash-lite", displayName: "Gemini 3.5 Flash-Lite" },
      { id: "gemini-3.1-flash-lite", displayName: "Gemini 3.1 Flash-Lite" },
      { id: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash" },
      { id: "gemini-3.6-flash", displayName: "gemini-3.6-flash" },
    ],
    fetchedAt: Date.parse("2026-10-24T10:00:00Z"),
    selectedAvailable: true,
    live: true,
  };

  it("links to Google AI Studio in a new tab, with safe link attributes and the privacy warnings", async () => {
    await open("Translation");
    const link = screen.getByRole("link", { name: /Open Google AI Studio/ });
    expect(link.getAttribute("href")).toBe("https://aistudio.google.com/app/apikey");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
    expect(screen.getByText(/never into any other website/)).toBeTruthy();
    expect(screen.getByText(/Keep your API key private/)).toBeTruthy();
    expect(screen.getByText(/require billing or have usage limits/)).toBeTruthy();
  });

  it("shows the guide in Traditional Chinese too", async () => {
    Object.defineProperty(navigator, "language", { value: "zh-TW", configurable: true });
    const server = installFakeServer(makeState());
    void server;
    render(<App />);
    await screen.findByRole("log");
    fireEvent.click(screen.getByRole("button", { name: "設定" }));
    fireEvent.click(screen.getByRole("tab", { name: "翻譯" }));
    expect(screen.getByRole("link", { name: /不知道如何取得 API Key\?前往 Google AI Studio/ })).toBeTruthy();
    expect(screen.getByText(/不要貼到其他任何網站/)).toBeTruthy();
  });

  it("without a key it asks for one instead of offering an empty list", async () => {
    await open("Translation");
    expect(screen.getByText("Save an API key to load the model list.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Refresh models" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Test model" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists friendly names with ids, saves the chosen model, and can test that model", async () => {
    const { server } = await open("Translation", stateWithKey(), ({ path, method }) => {
      if (path === "/api/gemini/models" && method === "GET") return json(models);
      if (path === "/api/secrets/gemini/test") return json({ ok: true });
      return undefined;
    });
    const select = (await screen.findByLabelText("Gemini model")) as HTMLSelectElement;
    await waitFor(() => expect(within(select).getAllByRole("option").length).toBeGreaterThanOrEqual(4));
    const labels = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(labels).toEqual([
      "Gemini 3.5 Flash-Lite — Recommended · best value",
      "Gemini 3.1 Flash-Lite — Economy",
      "Gemini 3.8 Flash — Advanced",
      "gemini-3.6-flash — Advanced", // the id is shown once when there is no friendlier name
    ]);
    expect(screen.getByText(/4 translation models/)).toBeTruthy();

    fireEvent.change(select, { target: { value: "gemini-3.1-flash-lite" } });
    await waitFor(() => expect(settingsCalls(server.calls)).toContainEqual({ translation: { geminiModel: "gemini-3.1-flash-lite" } }));

    fireEvent.click(screen.getByRole("button", { name: "Test model" }));
    expect(await screen.findByText("Model works with your key.")).toBeTruthy();
    expect(server.calls.find((c) => c.path === "/api/secrets/gemini/test")?.body).toEqual({ model: "gemini-3.1-flash-lite" }); // tests the model that is selected now
  });

  it("when the refresh fails it says why and keeps the last good list and the selected model", async () => {
    let refreshing = false;
    await open("Translation", stateWithKey(), ({ path, method }) => {
      if (path === "/api/gemini/models" && method === "GET") return json(models);
      if (path === "/api/gemini/models/refresh") {
        refreshing = true;
        return json({ ...models, ok: false, code: "quota" });
      }
      return undefined;
    });
    const select = (await screen.findByLabelText("Gemini model")) as HTMLSelectElement;
    await waitFor(() => expect(within(select).getAllByRole("option").length).toBeGreaterThanOrEqual(3));
    fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Could not refresh the list \(Rate limit or quota reached; try again shortly\)\. Showing the last saved list\./);
    expect(refreshing).toBe(true);
    expect(within(select).getAllByRole("option").length).toBeGreaterThanOrEqual(3);
    expect(select.value).toBe("gemini-3.5-flash-lite");
  });

  it("warns, without switching, when the selected model is gone from Google's list", async () => {
    const state = stateWithKey();
    state.settings.translation.geminiModel = "gemini-3.3-flash-lite";
    const { server } = await open("Translation", state, ({ path, method }) => (path === "/api/gemini/models" && method === "GET" ? json({ ...models, selectedAvailable: false }) : undefined));
    expect((await screen.findByText(/“gemini-3.3-flash-lite” is no longer in Google’s list/)).textContent).toContain("choose another model");
    const select = screen.getByLabelText("Gemini model") as HTMLSelectElement;
    expect(select.value).toBe("gemini-3.3-flash-lite");
    expect(within(select).getByRole("option", { name: "gemini-3.3-flash-lite (not in the list)" })).toBeTruthy();
    expect(settingsCalls(server.calls)).toEqual([]); // nothing was changed behind the user's back
    // a replacement is offered, and only applied when clicked
    fireEvent.click(screen.getByRole("button", { name: "Use gemini-3.5-flash-lite" }));
    await waitFor(() => expect(settingsCalls(server.calls)).toEqual([{ translation: { geminiModel: "gemini-3.5-flash-lite" } }]));
  });

  it("tells a list that was only saved earlier from one Google confirmed now", async () => {
    await open("Translation", stateWithKey(), ({ path, method }) => (path === "/api/gemini/models" && method === "GET" ? json({ ...models, live: false }) : undefined));
    expect(await screen.findByText(/Last known list: 4 models/)).toBeTruthy();
    expect(screen.queryByText(/4 translation models/)).toBeNull();
  });

  it("says so when the recommended model is not available for this key", async () => {
    const without = { ...models, models: models.models.slice(1) };
    await open("Translation", stateWithKey(), ({ path, method }) => (path === "/api/gemini/models" && method === "GET" ? json({ ...without, selectedAvailable: false }) : undefined));
    expect(await screen.findByText(/“gemini-3.5-flash-lite” is no longer in Google’s list/)).toBeTruthy();
  });

  it("never shows the key after saving", async () => {
    const { server } = await open("Translation", makeState(), ({ path, method }) => (path === "/api/secrets/gemini" && method === "PUT" ? json({ configured: true }) : undefined));
    const input = screen.getByPlaceholderText("Paste your API key") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: "AIzaSyDUMMY_KEY_FOR_TESTS_0123456789" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() => expect(server.calls.some((c) => c.path === "/api/secrets/gemini" && c.method === "PUT")).toBe(true));
    await waitFor(() => expect(input.value).toBe(""));
    expect(document.body.innerHTML).not.toContain("AIzaSyDUMMY");
  });
});

describe("Chat filtering and performance", () => {
  it("toggles the filter and cache, saves the freshness window in ms, and shows real counters", async () => {
    const state = makeState();
    state.runtime.stats = { waiting: 2, running: 1, avgLatencyMs: 340, local: 4, cacheHits: 7, cacheLookups: 20, filtered: 5, stale: 3, completed: 12, failed: 1 };
    const { server } = await open("Translation", state);
    expect(screen.getByText(/Working — 2 waiting, 1 in progress/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Skip meaningless messages (numbers, symbols, emoji)"));
    await waitFor(() => expect(settingsCalls(server.calls)).toContainEqual({ general: { smartFilter: false } }));
    fireEvent.click(screen.getByLabelText("Reuse earlier translations (cache)"));
    await waitFor(() => expect(settingsCalls(server.calls)).toContainEqual({ general: { translationCache: false } }));

    const stats = screen.getByText("Average translation time").closest("dl")!;
    expect(stats.textContent).toContain("340 ms");
    expect(stats.textContent).toMatch(/7\s*\/\s*20/);
    const expected: [string, string][] = [["Skipped by filter", "5"], ["Skipped (too old)", "3"], ["Failed", "1"], ["Translated", "12"]];
    for (const [label, value] of expected) {
      expect(within(stats).getByText(label).nextElementSibling?.textContent).toBe(value);
    }

    const stale = screen.getByLabelText(/Skip translations that waited longer than/) as HTMLInputElement;
    expect(stale.value).toBe("5");
    fireEvent.change(stale, { target: { value: "8" } });
    fireEvent.blur(stale);
    await waitFor(() => expect(settingsCalls(server.calls)).toContainEqual({ translation: { staleAfterMs: 8000 } }));
  });

  it("shows idle status and 'no data yet' instead of invented numbers", async () => {
    await open("Translation");
    expect(screen.getByText(/Idle — nothing waiting/)).toBeTruthy();
    expect(screen.getByText("no data yet")).toBeTruthy();
  });

  it("surfaces a validation error from the server for the freshness window", async () => {
    await open("Translation", makeState(), ({ path, method }) =>
      path === "/api/settings" && method === "PUT" ? json({ error: "validation-failed", detail: [{ path: "translation.staleAfterMs", message: "Use 0 or 1000-60000 ms" }] }, 400) : undefined,
    );
    const stale = screen.getByLabelText(/Skip translations that waited longer than/);
    fireEvent.change(stale, { target: { value: "0.2" } });
    fireEvent.blur(stale);
    expect(await screen.findByText("Use 0 or 1000-60000 ms")).toBeTruthy();
  });
});

describe("CS2 location", () => {
  const twoInstalls = (needsChoice: boolean): AppState => {
    const s = makeState();
    s.paths.candidates = [
      { gameDir: "D:/Steam/steamapps/common/Counter-Strike Global Offensive/game/csgo", logPath: "D:/Steam/x/console.log", logExists: true, logModifiedAt: Date.parse("2026-10-24T09:00:00Z"), selected: true },
      { gameDir: "E:/SteamLibrary/steamapps/common/Counter-Strike Global Offensive/game/csgo", logPath: "E:/Lib/x/console.log", logExists: false, logModifiedAt: null, selected: false },
    ];
    s.paths.needsChoice = needsChoice;
    return s;
  };

  it("defaults to automatic detection and shows the detected paths with clear status", async () => {
    await open("CS2");
    expect((screen.getByLabelText("Automatic (recommended)") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("C:/cs2/console.log")).toBeTruthy();
    expect(screen.getByText("C:/cs2/cfg")).toBeTruthy();
    expect(screen.getByText(/File found/)).toBeTruthy();
    expect(screen.getByText(/Folder is writable/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Browse for console.log/ })).toBeNull();
  });

  it("says plainly when something is missing", async () => {
    const s = makeState();
    s.paths = { ...s.paths, logExists: false, cfgDirExists: false, cfgDirWritable: false, candidates: [] };
    await open("CS2", s);
    expect(screen.getByText(/File not found yet/)).toBeTruthy();
    expect(screen.getByText(/Not found/)).toBeTruthy();
    expect(screen.getByText(/CS2 was not found in any Steam library/)).toBeTruthy();
  });

  it("lets the user choose between several installs instead of silently using the first", async () => {
    const { server } = await open("CS2", twoInstalls(true));
    expect(screen.getByText("Several CS2 installs were found")).toBeTruthy();
    expect(screen.getByText(/No install was chosen yet/)).toBeTruthy();
    const radios = screen.getAllByRole("radio").filter((r) => (r as HTMLInputElement).name === "install") as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect(radios.every((r) => !r.checked)).toBe(true); // nothing is presented as "chosen" until the user picks
    fireEvent.click(radios[1]!);
    await waitFor(() => expect(settingsCalls(server.calls)).toContainEqual({ cs2: { installDir: "E:/SteamLibrary/steamapps/common/Counter-Strike Global Offensive/game/csgo" } }));
  });

  it("re-detects on demand", async () => {
    const { server } = await open("CS2");
    fireEvent.click(screen.getByRole("button", { name: "Detect again" }));
    await waitFor(() => expect(server.calls.some((c) => c.path === "/api/paths/redetect" && c.method === "POST")).toBe(true));
    await waitFor(() => expect(server.calls.filter((c) => c.path === "/api/state").length).toBeGreaterThanOrEqual(2));
  });

  it("manual mode: browses with the native dialog, keeps the choice, and warns about an unusual file", async () => {
    const s = makeState();
    s.paths.mode = "manual";
    s.settings.cs2.pathMode = "manual";
    const { server } = await open("CS2", s, ({ path, body }) => {
      if (path === "/api/pick") {
        return (body as { kind: string }).kind === "log" ? json({ path: "D:/My Games/CS2/notes.txt", warning: "not-console-log" }) : json({ path: "D:/My Games/CS2/cfg" });
      }
      return undefined;
    });
    fireEvent.click(screen.getByRole("button", { name: "Browse for console.log…" }));
    await waitFor(() => expect(settingsCalls(server.calls)).toContainEqual({ cs2: { pathMode: "manual", logPath: "D:/My Games/CS2/notes.txt" } }));
    expect(await screen.findByText(/This file is not named console.log/)).toBeTruthy();
    expect(server.calls.find((c) => c.path === "/api/pick")?.body).toEqual({ kind: "log", title: "Select CS2 console.log" });

    fireEvent.click(screen.getByRole("button", { name: "Choose cfg folder…" }));
    await waitFor(() => expect(settingsCalls(server.calls)).toContainEqual({ cs2: { pathMode: "manual", cfgDir: "D:/My Games/CS2/cfg" } }));
  });

  it("manual mode: a cancelled dialog changes nothing, and dialog errors are explained", async () => {
    const s = makeState();
    s.paths.mode = "manual";
    let answer: Response = json({ path: null });
    const { server } = await open("CS2", s, ({ path }) => (path === "/api/pick" ? answer : undefined));
    fireEvent.click(screen.getByRole("button", { name: "Browse for console.log…" }));
    await waitFor(() => expect(server.calls.some((c) => c.path === "/api/pick")).toBe(true));
    expect(settingsCalls(server.calls)).toEqual([]);

    answer = json({ error: "dialog-open" }, 409);
    fireEvent.click(screen.getByRole("button", { name: "Browse for console.log…" }));
    expect(await screen.findByText(/A file dialog is already open/)).toBeTruthy();
    answer = json({ error: "internal-error" }, 500);
    fireEvent.click(screen.getByRole("button", { name: "Choose cfg folder…" }));
    expect(await screen.findByText(/Could not open the file dialog/)).toBeTruthy();
  });

  it("manual mode keeps typing a path as an advanced fallback, and disables browsing where dialogs do not exist", async () => {
    const s = makeState();
    s.paths.mode = "manual";
    s.paths.canBrowse = false;
    const { server } = await open("CS2", s);
    expect((screen.getByRole("button", { name: "Browse for console.log…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/File dialogs are only available on Windows/)).toBeTruthy();
    const typed = screen.getAllByLabelText("console.log file").find((el) => el.tagName === "INPUT")!;
    fireEvent.change(typed, { target: { value: "D:/typed/console.log" } });
    fireEvent.blur(typed);
    await waitFor(() => expect(settingsCalls(server.calls)).toContainEqual({ cs2: { pathMode: "manual", logPath: "D:/typed/console.log" } }));
  });

  it("switching to manual keeps the paths currently in use instead of blanking them", async () => {
    const { server } = await open("CS2");
    fireEvent.click(screen.getByLabelText("Choose manually"));
    await waitFor(() => expect(settingsCalls(server.calls)).toContainEqual({ cs2: { pathMode: "manual", logPath: "C:/cs2/console.log", cfgDir: "C:/cs2/cfg" } }));
  });

  it("puts the cfg file name under Advanced", async () => {
    await open("CS2");
    const field = screen.getByLabelText("cfg file name");
    expect(field.closest("details")).not.toBeNull();
    expect(field.closest("details")!.hasAttribute("open")).toBe(false);
  });
});

describe("My in-game name", () => {
  it("offers the Steam name as an unconfirmed suggestion and authorises it only on click", async () => {
    const s = makeState();
    s.identity = { authorized: [], manual: [], logConfirmed: null, steam: "Joe", suggestSteam: true };
    const { server } = await open("CS2", s);
    expect(screen.getByText(/From Steam: Joe\. Not confirmed/)).toBeTruthy();
    expect(settingsCalls(server.calls)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Use this name" }));
    await waitFor(() => expect(settingsCalls(server.calls)).toContainEqual({ cs2: { selfNames: ["Joe"] } }));
  });

  it("distinguishes a name confirmed by the game's log from the Steam name", async () => {
    const s = makeState();
    s.identity = { authorized: ["咕咕嘎嘎"], manual: [], logConfirmed: "咕咕嘎嘎", steam: "Joe", suggestSteam: false };
    await open("CS2", s);
    expect(screen.getByText(/Confirmed by the CS2 log: 咕咕嘎嘎/)).toBeTruthy();
    expect(screen.queryByText(/From Steam/)).toBeNull();
  });

  it("states that no name means your own messages are not recognised, and explains why a name proves nothing", async () => {
    const s = makeState();
    s.identity = { authorized: [], manual: [], logConfirmed: null, steam: null, suggestSteam: false };
    await open("CS2", s);
    expect(screen.getByText(/No name set, so your own messages cannot be recognised/)).toBeTruthy();
    expect(screen.getByText(/anyone can use the same name/)).toBeTruthy();
  });

  it("saves several manually entered names", async () => {
    const { server } = await open("CS2");
    const input = screen.getByLabelText("Names that count as me");
    fireEvent.change(input, { target: { value: "Old Name,  New Name ,, " } });
    fireEvent.blur(input);
    await waitFor(() => expect(settingsCalls(server.calls)).toContainEqual({ cs2: { selfNames: ["Old Name", "New Name"] } }));
  });
});

describe("a saved model that no longer passes the rules", () => {
  it("stays selected but is marked not recommended, is not offered as a candidate, and offers the recommended one", async () => {
    const state = makeState();
    state.settings.secrets = { geminiKeyConfigured: true, geminiKeyState: "configured" };
    state.settings.translation.geminiModel = "gemini-3.1-flash-lite-preview";
    // an old, unfiltered server list: the UI must still show only the filtered models, and count those
    const dirty = {
      models: [
        { id: "antigravity-preview-05-2026", displayName: "Antigravity Agent Preview" },
        { id: "gemini-3.5-flash-lite", displayName: "Gemini 3.5 Flash-Lite" },
        { id: "gemini-3.1-flash-lite-preview", displayName: "Gemini 3.1 Flash Lite Preview" },
        { id: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
        { id: "gemini-3.7-flash", displayName: "Gemini 3.7 Flash" },
        { id: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash" },
      ],
      fetchedAt: Date.parse("2026-10-24T10:00:00Z"),
      selectedAvailable: true,
      live: true,
    };
    const { server } = await open("Translation", state, ({ path, method }) => (path === "/api/gemini/models" && method === "GET" ? json(dirty) : undefined));
    const select = (await screen.findByLabelText("Gemini model")) as HTMLSelectElement;
    await screen.findByText(/2 translation models/);
    const labels = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(labels).toEqual(["gemini-3.1-flash-lite-preview (not recommended)", "Gemini 3.5 Flash-Lite — Recommended · best value", "Gemini 3.8 Flash — Advanced"]);
    expect(select.value).toBe("gemini-3.1-flash-lite-preview");
    expect(screen.getByText(/not a recommended model for chat translation/)).toBeTruthy();
    expect(settingsCalls(server.calls)).toEqual([]); // never switched in the background
    fireEvent.click(screen.getByRole("button", { name: "Use gemini-3.5-flash-lite" }));
    await waitFor(() => expect(settingsCalls(server.calls)).toEqual([{ translation: { geminiModel: "gemini-3.5-flash-lite" } }]));
  });
});

describe("settings window layout", () => {
  it("opens every tab at its top, inside a frame whose height does not depend on the tab", async () => {
    await open("Translation");
    const panel = document.querySelector(".tabpanel") as HTMLElement;
    panel.scrollTop = 400;
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));
    expect((document.querySelector(".tabpanel") as HTMLElement).scrollTop).toBe(0);
    // the cause of the jumping frame was a content-sized dialog: the height must be fixed in the stylesheet
    const css = (await import("node:fs")).readFileSync("web/src/styles/components.css", "utf8");
    const dialog = /\.dialog \{([^}]*)\}/.exec(css)![1]!;
    expect(dialog).toMatch(/\n\s*height: min\(680px, calc\(100vh - 24px\)\);/);
    expect(dialog).toMatch(/max-height: calc\(100dvh - 24px\);/);
    expect(/\.dialog-body \{([^}]*)\}/.exec(css)![1]!).toContain("height: 100%");
  });
});

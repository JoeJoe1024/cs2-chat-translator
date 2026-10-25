// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../web/src/App";
import { entry, installFakeServer, makeState } from "./fakeServer";

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

async function boot(state = makeState()) {
  const server = installFakeServer(state);
  render(<App />);
  await screen.findByRole("log");
  return server;
}

describe("App", () => {
  it("renders history with original and translation, team labels and the watcher status", async () => {
    await boot(
      makeState({
        history: [
          entry({ id: "m1", channel: "ct", sender: "Bob", text: "rush b", translation: { id: "m1", status: "done", text: "衝 B", sourceLanguage: "en", engine: "google" } }),
          entry({ id: "m2", channel: "t", sender: "Eve", dead: true, text: "oops", translation: { id: "m2", status: "failed", reason: "quota" } }),
        ],
      }),
    );
    const log = screen.getByRole("log");
    expect(within(log).getByText("rush b")).toBeTruthy();
    expect(within(log).getByText("衝 B")).toBeTruthy();
    expect(within(log).getByText("CT")).toBeTruthy();
    expect(within(log).getByText("Dead")).toBeTruthy();
    expect(within(log).getByText(/Rate limit or quota reached/)).toBeTruthy();
    expect(screen.getByText("Watching CS2 chat")).toBeTruthy();
  });

  it("shows live chat pushed over SSE and fills in the translation", async () => {
    const server = await boot();
    await act(async () => {
      server.emit({ type: "chat", message: { id: "m5", at: Date.now(), channel: "all", sender: "Zed", dead: false, text: "gg", isSelf: false, formatId: "f" } });
    });
    expect(await screen.findByText("Translating…")).toBeTruthy();
    await act(async () => {
      server.emit({ type: "translation", update: { id: "m5", status: "done", text: "good game", engine: "gemini", sourceLanguage: "en" } });
    });
    expect(await screen.findByText("good game")).toBeTruthy();
    expect(screen.getByText(/via Gemini/)).toBeTruthy();
  });

  it("renders hostile chat as inert text (no HTML injection)", async () => {
    await boot(
      makeState({
        history: [
          entry({
            id: "m1",
            sender: "<img src=x onerror=alert(1)>",
            text: "<script>window.__pwned=1</script><b>bold</b>",
            translation: { id: "m1", status: "done", text: '<iframe src="javascript:alert(1)"></iframe>' },
          }),
        ],
      }),
    );
    const log = screen.getByRole("log");
    expect(log.querySelector("img, script, b, iframe")).toBeNull();
    expect(log.textContent).toContain("<script>window.__pwned=1</script>");
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("translates and prepares a message, then says it is READY, not sent", async () => {
    const server = await boot();
    fireEvent.change(screen.getByPlaceholderText("Type a message to translate…"), { target: { value: "Hello world" } });
    fireEvent.click(screen.getByRole("button", { name: "Translate & prepare" }));
    expect(await screen.findByText(/Message prepared/)).toBeTruthy();
    expect(screen.getByText(/Not sent to the game yet/)).toBeTruthy();
    expect(screen.getAllByText("Hallo Welt").length).toBeGreaterThan(0);
    expect(screen.getByTestId("prepared-card").textContent).toContain("Translated");
    expect(server.calls.find((c) => c.path === "/api/translate")?.body).toEqual({ text: "Hello world", target: "en" });
    expect(server.calls.find((c) => c.path === "/api/cfg")?.body).toMatchObject({ message: "Hallo Welt", channel: "all", mode: "translated", original: "Hello world" });
  });

  it("sends to team chat when selected and surfaces API errors in the user's language", async () => {
    const server = await boot();
    fireEvent.click(screen.getByLabelText("Team chat"));
    fireEvent.change(screen.getByPlaceholderText("Type a message to translate…"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Translate & prepare" }));
    await screen.findByText(/Message prepared/);
    expect(server.calls.find((c) => c.path === "/api/cfg")?.body).toMatchObject({ channel: "team" });

    vi.mocked(fetch).mockImplementationOnce(async () => new Response(JSON.stringify({ error: "translation-quota" }), { status: 429 }));
    fireEvent.click(screen.getByRole("button", { name: "Translate & prepare" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Rate limit or quota reached/);
  });

  it("uses Traditional Chinese when the browser prefers it", async () => {
    Object.defineProperty(navigator, "language", { value: "zh-TW", configurable: true });
    await boot();
    expect(await screen.findByText("聊天紀錄")).toBeTruthy();
    expect(document.documentElement.lang).toBe("zh-TW");
  });

  it("applies the saved theme and switches live without a reload", async () => {
    const state = makeState();
    state.settings.appearance.theme = "dark";
    const server = await boot(state);
    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("dark"));

    // header quick toggle cycles dark → system
    fireEvent.click(screen.getByRole("button", { name: /Theme: Dark/ }));
    await waitFor(() => expect(server.calls.find((c) => c.path === "/api/settings")?.body).toEqual({ appearance: { theme: "system" } }));
    await waitFor(() => expect(document.documentElement.hasAttribute("data-theme")).toBe(false));
  });

  it("changes the theme from the Appearance tab (light, dark, system)", async () => {
    await boot();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));
    for (const [label, attr] of [["Light", "light"], ["Dark", "dark"]] as const) {
      fireEvent.click(screen.getByLabelText(label));
      await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe(attr));
    }
    fireEvent.click(screen.getByLabelText("Follow system"));
    await waitFor(() => expect(document.documentElement.hasAttribute("data-theme")).toBe(false));
  });

  it("shows automatic chat-format detection by default and hides the tag inputs", async () => {
    await boot();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("tab", { name: "CS2" }));
    expect(screen.getByText("Automatic detection (recommended)")).toBeTruthy();
    expect(screen.getAllByText(/tchinese/).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Counter-Terrorist tag")).toBeNull();
  });

  it("never renders the Gemini key and reports validation errors from the server", async () => {
    const state = makeState();
    state.settings.secrets = { geminiKeyConfigured: true, geminiKeyState: "configured" };
    await boot(state);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("tab", { name: "Translation" }));
    expect(screen.getByText(/A key is saved on this PC/)).toBeTruthy();
    expect(document.body.innerHTML).not.toMatch(/AIza/);

    fireEvent.click(screen.getByRole("tab", { name: "CS2" }));
    vi.mocked(fetch).mockImplementationOnce(
      async () => new Response(JSON.stringify({ error: "validation-failed", detail: [{ path: "cs2.cfgFileName", message: "Use letters, digits, _ or -" }] }), { status: 400 }),
    );
    const input = screen.getByLabelText("cfg file name");
    fireEvent.change(input, { target: { value: "../bad.cfg" } });
    fireEvent.blur(input);
    expect(await screen.findByText("Use letters, digits, _ or -")).toBeTruthy();
  });

  const newChat = (id: string, text = "fresh") => ({ type: "chat" as const, message: { id, at: Date.now(), channel: "all" as const, sender: "N", dead: false, text, isSelf: false, formatId: "f" } });
  const fakeSizes = (list: HTMLElement, scrollHeight = 2000, clientHeight = 400) => {
    Object.defineProperty(list, "scrollHeight", { value: scrollHeight, configurable: true });
    Object.defineProperty(list, "clientHeight", { value: clientHeight, configurable: true });
  };
  const bootMany = () => boot(makeState({ history: Array.from({ length: 30 }, (_, i) => entry({ id: `m${i}`, text: `msg ${i}` })) }));

  it("follows new messages and late translations while the reader is at the bottom", async () => {
    const server = await bootMany();
    const list = screen.getByRole("log");
    fakeSizes(list);
    await act(async () => {
      server.emit(newChat("n1"));
    });
    expect(list.scrollTop).toBe(1600); // scrollHeight - clientHeight
    fakeSizes(list, 2300); // the translation arrives and the last row grows
    await act(async () => {
      server.emit({ type: "translation", update: { id: "n1", status: "done", text: "frisch", sourceLanguage: "en", engine: "google" } });
    });
    expect(list.scrollTop).toBe(1900);
    expect(screen.queryByRole("button", { name: /Back to latest/ })).toBeNull();
  });

  it("scrolling up pauses following; new lines and translations never move the reader, and the button resumes", async () => {
    const server = await bootMany();
    const list = screen.getByRole("log");
    fakeSizes(list);
    await act(async () => {
      server.emit(newChat("n1"));
    });
    list.scrollTop = 100; // the reader scrolls up on purpose
    fireEvent.scroll(list);
    await act(async () => {
      server.emit(newChat("n2"));
      server.emit(newChat("n3"));
      server.emit({ type: "translation", update: { id: "n1", status: "done", text: "x", sourceLanguage: "en", engine: "google" } });
    });
    expect(list.scrollTop).toBe(100);
    expect((await screen.findByRole("button", { name: /Back to latest/ })).textContent).toContain("2 new");
    fireEvent.click(screen.getByRole("button", { name: /Back to latest/ }));
    expect(list.scrollTop).toBe(1600);
    expect(screen.queryByRole("button", { name: /Back to latest/ })).toBeNull();
    await act(async () => {
      server.emit(newChat("n4"));
    });
    expect(list.scrollTop).toBe(1600); // following again
  });

  it("scrolling back to the bottom by hand resumes following, within a few pixels of tolerance", async () => {
    const server = await bootMany();
    const list = screen.getByRole("log");
    fakeSizes(list);
    await act(async () => {
      server.emit(newChat("n1"));
    });
    list.scrollTop = 100;
    fireEvent.scroll(list);
    expect(await screen.findByRole("button", { name: /Back to latest/ })).toBeTruthy();
    list.scrollTop = 1595; // 5px short of the bottom still counts as the bottom
    fireEvent.scroll(list);
    await waitFor(() => expect(screen.queryByRole("button", { name: /Back to latest/ })).toBeNull());
  });

  it("each side of the split view keeps its own scroll position and follow state", async () => {
    const server = await bootMany();
    fireEvent.change(screen.getByLabelText("Display"), { target: { value: "split" } });
    const logs = await waitFor(() => {
      const l = screen.getAllByRole("log");
      expect(l).toHaveLength(2);
      return l;
    });
    const [team, all] = logs as [HTMLElement, HTMLElement];
    fakeSizes(team);
    fakeSizes(all);
    await act(async () => {
      server.emit(newChat("a1"));
    });
    expect(all.scrollTop).toBe(1600);
    all.scrollTop = 50;
    fireEvent.scroll(all); // only the all-chat side is paused
    await act(async () => {
      server.emit(newChat("a2"));
      server.emit({ type: "chat", message: { id: "t1", at: Date.now(), channel: "ct", sender: "T", dead: false, text: "team line", isSelf: false, formatId: "f" } });
    });
    expect(all.scrollTop).toBe(50);
    expect(team.scrollTop).toBe(1600); // the team side kept following
  });
});

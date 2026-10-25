// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../../src/shared/protocol";
import type { CustomEntry } from "../../src/shared/glossary";
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
  localStorage.clear();
});

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

async function open(tab: "General" | "Translation" | "CS2", state: AppState = makeState(), override?: Override) {
  const server = installFakeServer(state, { current: override });
  render(<App />);
  await screen.findByRole("log");
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.click(screen.getByRole("tab", { name: tab }));
  return server;
}

const puts = (calls: { method: string; path: string; body: unknown }[]) => calls.filter((c) => c.path === "/api/settings" && c.method === "PUT").map((c) => c.body as Record<string, any>); // eslint-disable-line @typescript-eslint/no-explicit-any
const entry = (term: string, translation: string, lang = "*", id = `c-${term}`): CustomEntry => ({ id, term, translation, lang });
const withTarget = (target: string, custom: CustomEntry[] = [], extra: Partial<AppState["settings"]["dictionary"]> = {}) => {
  const s = makeState();
  s.settings.translation.chatTargetLanguage = target;
  s.settings.dictionary = { enabled: true, disabled: [], custom, ...extra };
  return s;
};
const customList = () => document.querySelector("ul.dict-list:not(.dict-list--builtin)") as HTMLElement;
const builtinList = () => document.querySelector("ul.dict-list--builtin") as HTMLElement;
const tryBox = () => screen.getByLabelText("Try a phrase") as HTMLInputElement;
const tryIt = (text: string) => fireEvent.change(tryBox(), { target: { value: text } });

describe("game-term dictionary settings", () => {
  it("is on by default, and the master switch is saved", async () => {
    const server = await open("Translation");
    const toggle = screen.getByLabelText(/Translate common CS2 shorthand locally/) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(puts(server.calls)).toContainEqual({ dictionary: { enabled: false } }));
  });

  it("lets you try a phrase and shows exactly what would happen", async () => {
    await open("Translation", withTarget("zh-TW"));
    tryIt("gg wp");
    expect(screen.getByText("Translated locally: 好局，打得好")).toBeTruthy();
    tryIt("GG");
    expect(screen.getByText("Translated locally: 好局")).toBeTruthy();
    tryIt("nice eco next round");
    expect(screen.getByText("Sent to the translator as: nice economy round next round")).toBeTruthy();
    tryIt("completely ordinary sentence");
    expect(screen.getByText("Sent to the translator unchanged")).toBeTruthy();
    tryIt("nc clutch"); // ambiguous term inside a sentence is not expanded
    expect(screen.getByText("Sent to the translator unchanged")).toBeTruthy();
    tryIt("");
    expect(screen.queryByText(/Sent to the translator/)).toBeNull();
  });

  it("explains shorthand that English readers already know, and a language without built-in wording", async () => {
    await open("Translation", withTarget("en"));
    tryIt("gg");
    expect(screen.getByText(/Common shorthand, shown as written/)).toBeTruthy();
    cleanup();
    await open("Translation", withTarget("th"));
    tryIt("gg");
    expect(screen.getByText(/No wording for Thai yet: the translator is used/)).toBeTruthy();
  });

  it("adds your own wording, which takes effect in the preview straight away", async () => {
    const server = await open("Translation", withTarget("zh-TW"));
    fireEvent.change(screen.getByLabelText("Term"), { target: { value: "nc" } });
    fireEvent.change(screen.getByLabelText("Translation", { selector: "input" }), { target: { value: "漂亮的一槍" } });
    fireEvent.change(screen.getByLabelText("Applies to"), { target: { value: "zh-TW" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(puts(server.calls)).toHaveLength(1));
    const sent = puts(server.calls)[0]!.dictionary.custom as CustomEntry[];
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ term: "nc", translation: "漂亮的一槍", lang: "zh-TW" });
    expect(sent[0]!.id).toMatch(/^c[a-z0-9]+$/);
    tryIt("nc");
    expect(await screen.findByText("Translated locally: 漂亮的一槍")).toBeTruthy();
    expect((screen.getByLabelText("Term") as HTMLInputElement).value).toBe(""); // form reset after saving
  });

  it("re-entering the same term and language replaces the old wording instead of adding a second one", async () => {
    const server = await open("Translation", withTarget("zh-TW", [entry("nc", "舊的", "zh-TW", "cold")]));
    fireEvent.change(screen.getByLabelText("Term"), { target: { value: "NC" } });
    fireEvent.change(screen.getByLabelText("Translation", { selector: "input" }), { target: { value: "新的" } });
    fireEvent.change(screen.getByLabelText("Applies to"), { target: { value: "zh-TW" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(puts(server.calls)).toHaveLength(1));
    const sent = puts(server.calls)[0]!.dictionary.custom as CustomEntry[];
    expect(sent.map((c) => [c.term, c.translation])).toEqual([["NC", "新的"]]);
  });

  it("edits and deletes your entries", async () => {
    const server = await open("Translation", withTarget("zh-TW", [entry("jump spot", "跳點", "*", "c1"), entry("nc", "漂亮", "zh-TW", "c2")]));
    expect(within(customList()).getByText("跳點")).toBeTruthy();
    const row = within(customList()).getByText("跳點").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    expect((screen.getByLabelText("Term") as HTMLInputElement).value).toBe("jump spot");
    fireEvent.change(screen.getByLabelText("Translation", { selector: "input" }), { target: { value: "跳點位置" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts(server.calls)).toHaveLength(1));
    expect(puts(server.calls)[0]!.dictionary.custom).toEqual([entry("nc", "漂亮", "zh-TW", "c2"), entry("jump spot", "跳點位置", "*", "c1")]);

    const ncRow = (await within(customList()).findByText("漂亮")).closest("li")!;
    fireEvent.click(within(ncRow).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(puts(server.calls)).toHaveLength(2));
    expect((puts(server.calls)[1]!.dictionary.custom as CustomEntry[]).map((c) => c.id)).toEqual(["c1"]);
  });

  it("validates input before saving anything", async () => {
    const server = await open("Translation", withTarget("zh-TW"));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Enter a term.");
    fireEvent.change(screen.getByLabelText("Term"), { target: { value: "nc" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Enter a translation.");
    fireEvent.change(screen.getByLabelText("Term"), { target: { value: "!!!" } });
    fireEvent.change(screen.getByLabelText("Translation", { selector: "input" }), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The term needs at least one letter or digit.");
    expect(puts(server.calls)).toEqual([]);
  });

  it("switches built-in terms off and on, one by one", async () => {
    const server = await open("Translation", withTarget("zh-TW"));
    const gg = screen.getByLabelText("On: gg") as HTMLInputElement;
    expect(gg.checked).toBe(true);
    fireEvent.click(gg);
    await waitFor(() => expect(puts(server.calls)).toContainEqual({ dictionary: { disabled: ["gg"] } }));
    expect((screen.getByLabelText("On: gg") as HTMLInputElement).checked).toBe(false);
    tryIt("gg");
    expect(screen.getByText("Sent to the translator unchanged")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("On: gg"));
    await waitFor(() => expect(puts(server.calls).at(-1)).toEqual({ dictionary: { disabled: [] } }));
  });

  it("lists the built-in vocabulary in the user's target language, flags ambiguous terms, and can be searched", async () => {
    await open("Translation", withTarget("ja"));
    const list = builtinList();
    expect(within(list).getByText("gg").closest("li")!.textContent).toContain("いい試合");
    const nc = within(list).getByText("nc").closest("li")!;
    expect(within(nc).getByTitle(/Several meanings/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Search terms…"), { target: { value: "rush" } });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.querySelector("code")?.textContent)).toEqual(["rush a", "rush b", "rush mid"]);
  });

  it("'Use my own wording' pre-fills the form with the current wording for your language", async () => {
    await open("Translation", withTarget("zh-TW"));
    const row = within(builtinList()).getByText("gg").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Use my own wording" }));
    expect((screen.getByLabelText("Term") as HTMLInputElement).value).toBe("gg");
    expect((screen.getByLabelText("Translation", { selector: "input" }) as HTMLInputElement).value).toBe("好局");
    expect((screen.getByLabelText("Applies to") as HTMLSelectElement).value).toBe("zh-TW");
  });

  it("is available in Traditional Chinese", async () => {
    Object.defineProperty(navigator, "language", { value: "zh-TW", configurable: true });
    installFakeServer(withTarget("zh-TW"));
    render(<App />);
    await screen.findByRole("log");
    fireEvent.click(screen.getByRole("button", { name: "設定" }));
    fireEvent.click(screen.getByRole("tab", { name: "翻譯" }));
    expect(screen.getByText("遊戲術語詞典")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("試試看"), { target: { value: "gg wp" } });
    expect(screen.getByText("本機直接翻譯:好局，打得好")).toBeTruthy();
  });

  it("chat rows say when a translation came from the local dictionary", async () => {
    const s = makeState();
    s.history = [
      { id: "m1", at: 1, channel: "all", sender: "Alice", dead: false, text: "gg wp", isSelf: false, formatId: "f", translation: { id: "m1", status: "done", text: "好局，打得好", engine: "local" } },
    ];
    installFakeServer(s);
    render(<App />);
    await screen.findByRole("log");
    expect(within(screen.getByRole("log")).getByText("好局，打得好")).toBeTruthy();
    expect(within(screen.getByRole("log")).getByText(/via Local dictionary/)).toBeTruthy();
  });

  it("shows the number of dictionary answers among the real statistics", async () => {
    const s = makeState();
    s.runtime.stats.local = 12;
    await open("Translation", s);
    const stats = screen.getByText("Answered by the dictionary").closest("dl")!;
    expect(within(stats).getByText("Answered by the dictionary").nextElementSibling?.textContent).toBe("12");
  });
});

describe("first-time setup commands", () => {
  const copies = () => screen.getAllByRole("button", { name: "Copy" });

  async function setup(state: AppState = makeState()) {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void writes.push(t) } });
    const server = await open("CS2", state);
    return { server, writes };
  }

  it("shows the three commands with their own copy button, separating Steam from the CS2 console", async () => {
    const { writes } = await setup();
    const section = screen.getByText("First-time setup", { selector: "h3" }).closest("section")!;
    expect(within(section).getByText("Step 1 · Steam launch option")).toBeTruthy();
    expect(within(section).getByText("Step 2 · CS2 console command")).toBeTruthy();
    expect(within(section).getByText(/Optional · test the file/)).toBeTruthy();
    const codes = within(section).getAllByText((_, el) => el?.tagName === "CODE").map((e) => e.textContent);
    expect(codes).toEqual(["-condebug", 'bind "kp_plus" "exec chat_reader.cfg"', "exec chat_reader.cfg"]);
    const buttons = within(section).getAllByRole("button", { name: "Copy" });
    expect(buttons).toHaveLength(3);
    for (const b of buttons) fireEvent.click(b);
    await waitFor(() => expect(writes).toHaveLength(3));
    expect(writes).toEqual(["-condebug", 'bind "kp_plus" "exec chat_reader.cfg"', "exec chat_reader.cfg"]); // each button copies only its own line
    expect(within(section).getByText(/In Steam: Library/)).toBeTruthy();
    expect(within(section).getByText(/If nothing is prepared, nothing is sent/)).toBeTruthy();
    expect(within(section).getByText(/this app never changes your Steam or CS2 settings by itself/i)).toBeTruthy();
  });

  it("follows the send key and the cfg file name as soon as they change", async () => {
    await setup();
    const section = () => screen.getByText("First-time setup", { selector: "h3" }).closest("section")!;
    const texts = () => within(section()).getAllByText((_, el) => el?.tagName === "CODE").map((e) => e.textContent);

    fireEvent.change(screen.getByLabelText("Or choose from a list"), { target: { value: "f8" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this key" }));
    await waitFor(() => expect(texts()[1]).toBe('bind "f8" "exec chat_reader.cfg"'));

    const file = screen.getByLabelText("cfg file name");
    fireEvent.change(file, { target: { value: "my_chat.cfg" } });
    fireEvent.blur(file);
    await waitFor(() => expect(texts()).toEqual(["-condebug", 'bind "f8" "exec my_chat.cfg"', "exec my_chat.cfg"]));
    expect(copies().length).toBeGreaterThanOrEqual(3);
  });

  it("is in Traditional Chinese, and the extra help is collapsed by default", async () => {
    Object.defineProperty(navigator, "language", { value: "zh-TW", configurable: true });
    installFakeServer(makeState());
    render(<App />);
    await screen.findByRole("log");
    fireEvent.click(screen.getByRole("button", { name: "設定" }));
    fireEvent.click(screen.getByRole("tab", { name: "CS2" }));
    expect(screen.getByText("步驟 1 · Steam 啟動選項")).toBeTruthy();
    expect(screen.getByText("步驟 2 · CS2 控制台指令")).toBeTruthy();
    const more = screen.getByText("更多說明").closest("details")!;
    expect(more.hasAttribute("open")).toBe(false);
  });
});

describe("Gemini key states", () => {
  const stateWith = (geminiKeyState: "configured" | "missing" | "reenter") => {
    const s = makeState();
    s.settings.secrets = { geminiKeyConfigured: geminiKeyState === "configured", geminiKeyState };
    return s;
  };

  it("asks for the key again, in plain words, when the saved key cannot be used on this PC or account", async () => {
    const server = await open("Translation", stateWith("reenter"), ({ path, method }) => (path === "/api/secrets/gemini" && method === "PUT" ? json({ configured: true }) : undefined));
    const alert = screen.getByText("This key can’t be used in the current Windows environment. Please enter it again.");
    expect(alert).toBeTruthy();
    expect(screen.getByText(/saved on another computer or Windows account/)).toBeTruthy();
    expect(screen.queryByText(/A key is saved on this PC/)).toBeNull();
    expect(screen.getByPlaceholderText("New API key")).toBeTruthy();
    const replace = screen.getByRole("button", { name: "Replace key" }) as HTMLButtonElement;
    expect((screen.getByRole("button", { name: "Remove" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Refresh models" }) as HTMLButtonElement).disabled).toBe(true); // no usable key yet
    fireEvent.change(screen.getByPlaceholderText("New API key"), { target: { value: "AIzaSyDUMMY_KEY_FOR_TESTS_0123456789" } });
    fireEvent.click(replace);
    await waitFor(() => expect(server.calls.some((c) => c.path === "/api/secrets/gemini" && c.method === "PUT")).toBe(true));
    expect(document.body.innerHTML).not.toContain("AIzaSyDUMMY");
  });

  it("shows 'saved' for a working key with a replace / remove choice, and 'not saved' otherwise", async () => {
    await open("Translation", stateWith("configured"));
    expect(screen.getByText(/A key is saved on this PC/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Replace key" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Remove" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/Sharing the program folder does not share it/)).toBeTruthy();
    cleanup();
    await open("Translation", stateWith("missing"));
    expect(screen.getByText("No key saved.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save key" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Remove" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("states the re-enter message in Traditional Chinese", async () => {
    Object.defineProperty(navigator, "language", { value: "zh-TW", configurable: true });
    installFakeServer(stateWith("reenter"));
    render(<App />);
    await screen.findByRole("log");
    fireEvent.click(screen.getByRole("button", { name: "設定" }));
    fireEvent.click(screen.getByRole("tab", { name: "翻譯" }));
    expect(screen.getByText("此金鑰無法在目前的 Windows 環境使用,請重新輸入。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "更換金鑰" })).toBeTruthy();
  });
});

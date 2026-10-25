// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../web/src/App";
import { entry, installFakeServer, makeState, type Override } from "./fakeServer";

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
const history = [entry({ id: "me", sender: "Me", text: "my own line" }), entry({ id: "al", sender: "Alice", text: "alice line" })];

async function boot(override?: Override) {
  const ref = { current: override };
  const server = installFakeServer(makeState({ history }), ref);
  render(<App />);
  await screen.findAllByRole("log");
  return server;
}
const cfgCalls = (calls: { path: string; body: unknown }[]) => calls.filter((c) => c.path === "/api/cfg").map((c) => c.body as { message: string; channel: string; original?: string; clickedAt: number });
const settingsCalls = (calls: { path: string; body: unknown }[]) => calls.filter((c) => c.path === "/api/settings").map((c) => c.body as Record<string, Record<string, unknown>>);
const box = () => screen.getByPlaceholderText("Type a message to translate…") as HTMLTextAreaElement;

describe("own messages in the chat log", () => {
  it("hiding is independent of skipping translation, applies to every layout, and keeps the history", async () => {
    const server = await boot();
    fireEvent.click(screen.getByText("Options"));
    const skip = screen.getByLabelText("Don’t translate my messages") as HTMLInputElement;
    const hide = screen.getByLabelText("Hide my messages") as HTMLInputElement;
    expect([skip.checked, hide.checked]).toEqual([false, false]); // defaults: both unchecked
    expect(screen.getByText("my own line")).toBeTruthy();

    fireEvent.click(hide);
    await waitFor(() => expect(screen.queryByText("my own line")).toBeNull());
    expect(settingsCalls(server.calls).at(-1)).toEqual({ general: { hideOwnMessages: true } });
    expect((screen.getByLabelText("Don’t translate my messages") as HTMLInputElement).checked).toBe(false); // untouched
    expect(screen.getByText("alice line")).toBeTruthy();
    expect(screen.getByText(/1 of your own message/)).toBeTruthy();

    for (const v of ["team", "all", "split", "mixed"]) {
      fireEvent.change(screen.getByLabelText("Display"), { target: { value: v } });
      await waitFor(() => expect((screen.getByLabelText("Display") as HTMLSelectElement).value).toBe(v));
      expect(screen.queryByText("my own line")).toBeNull();
    }
    fireEvent.click(screen.getByLabelText("Hide my messages"));
    await waitFor(() => expect(screen.getByText("my own line")).toBeTruthy()); // history was never removed

    fireEvent.click(screen.getByLabelText("Don’t translate my messages"));
    await waitFor(() => expect(settingsCalls(server.calls).at(-1)).toEqual({ general: { translateOwnMessages: false } }));
  });
});

describe("quick talk", () => {
  it("a phrase is translated and prepared with the chosen channel, and never touches the typed draft", async () => {
    const server = await boot();
    fireEvent.change(box(), { target: { value: "my unfinished draft" } });
    fireEvent.click(screen.getByRole("radio", { name: "Team chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Rush B!" }));
    await waitFor(() => expect(cfgCalls(server.calls)).toHaveLength(1));
    expect(server.calls.find((c) => c.path === "/api/translate")?.body).toEqual({ text: "Rush B!", target: "en" });
    expect(cfgCalls(server.calls)[0]).toMatchObject({ message: "Hallo Welt", channel: "team", original: "Rush B!" });
    expect(box().value).toBe("my unfinished draft");
    expect((await screen.findByTestId("prepared-card")).textContent).toContain("Hallo Welt");
  });

  it("the last pick wins when translations finish out of order, and a failed translation prepares nothing", async () => {
    const gates: Record<string, () => void> = {};
    const server = await boot(async ({ path, body }) => {
      if (path !== "/api/translate") return undefined;
      const text = (body as { text: string }).text;
      if (text === "Need backup!") return json({ error: "translation-network" }, 502);
      await new Promise<void>((r) => (gates[text] = r));
      return json({ status: "done", text: `T(${text})`, target: "en", engine: "google", engineUsed: "google" });
    });
    fireEvent.click(screen.getByRole("button", { name: "Rush B!" }));
    fireEvent.click(screen.getByRole("button", { name: "Many enemies mid!" }));
    await waitFor(() => expect(gates["Many enemies mid!"]).toBeTruthy());
    await act(async () => {
      gates["Many enemies mid!"]!();
    });
    await waitFor(() => expect(cfgCalls(server.calls)).toHaveLength(1));
    await act(async () => {
      gates["Rush B!"]!(); // the older, slower one finishes last
    });
    expect(cfgCalls(server.calls)).toHaveLength(1);
    expect(cfgCalls(server.calls)[0]!.message).toBe("T(Many enemies mid!)");

    fireEvent.click(screen.getByRole("button", { name: "Need backup!" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(cfgCalls(server.calls)).toHaveLength(1); // nothing untranslated was written
  });

  it("language chips switch the send language, stay in sync with the dropdown, and are saved", async () => {
    const server = await boot();
    fireEvent.click(screen.getByRole("tab", { name: "Languages" }));
    fireEvent.click(screen.getByRole("button", { name: "Japanese" }));
    await waitFor(() => expect((screen.getByLabelText("Translate to") as HTMLSelectElement).value).toBe("ja"));
    expect(settingsCalls(server.calls).at(-1)).toEqual({ translation: { sendTargetLanguage: "ja" } });
    expect(JSON.stringify(settingsCalls(server.calls))).not.toContain("chatTargetLanguage"); // receiving language untouched
    fireEvent.change(screen.getByLabelText("Translate to"), { target: { value: "ko" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Korean" }).getAttribute("aria-pressed")).toBe("true"));
  });

  it("custom phrases and favourite languages are saved through settings (max 6 languages)", async () => {
    const server = await boot();
    const quick = screen.getByRole("region", { name: "Quick talk" });
    fireEvent.click(within(quick).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(quick).getByPlaceholderText("New phrase"), { target: { value: "ecoing this round" } });
    fireEvent.click(within(quick).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(settingsCalls(server.calls).at(-1)?.quick?.phrases).toBeTruthy());
    const phrases = settingsCalls(server.calls).at(-1)!.quick!.phrases as { text: string }[];
    expect(phrases.at(-1)!.text).toBe("ecoing this round");
    expect(phrases).toHaveLength(25); // all 24 built-ins became an editable stored list, plus the new one
    expect(phrases[0]!.text).toBe("Many enemies at A!");
    fireEvent.click(within(quick).getAllByRole("button", { name: "Delete" })[0]!);
    await waitFor(() => expect((settingsCalls(server.calls).at(-1)!.quick!.phrases as unknown[]).length).toBe(phrases.length - 1));

    fireEvent.click(within(quick).getByRole("tab", { name: "Languages" }));
    expect(within(quick).getByText("Up to 6 languages.")).toBeTruthy(); // six defaults: full
    fireEvent.click(within(quick).getByRole("button", { name: "Remove: Spanish" }));
    await waitFor(() => expect(settingsCalls(server.calls).at(-1)?.quick?.languages).toEqual(["en", "zh-TW", "ja", "ko", "ru"]));
  });
});

describe("quick phrase categories", () => {
  const chips = (quick: HTMLElement) => within(quick).getAllByRole("button").filter((b) => b.classList.contains("chipbtn"));

  it("opens on the 8 common phrases; other categories show their own, nothing is picked just by switching", async () => {
    const server = await boot();
    const quick = screen.getByRole("region", { name: "Quick talk" });
    expect(chips(quick)).toHaveLength(8);
    expect(within(quick).queryByRole("button", { name: "Hold A!" })).toBeNull();
    fireEvent.click(within(quick).getByRole("button", { name: "Defend" }));
    expect(chips(quick).map((b) => b.textContent)).toEqual(["Need backup!", "Hold A!", "Hold B!", "Cover me!", "Don’t peek!", "I’m defusing!"]);
    fireEvent.click(within(quick).getByRole("button", { name: "Economy" }));
    expect(server.calls.some((c) => c.path === "/api/translate" || c.path === "/api/cfg")).toBe(false);
    fireEvent.click(within(quick).getByRole("button", { name: "Full buy next round!" }));
    await waitFor(() => expect(cfgCalls(server.calls)).toHaveLength(1));
  });

  it("an older saved list keeps the user's phrases; restoring built-ins never deletes them", async () => {
    const base = makeState({ history });
    const state = makeState({ history, settings: { ...base.settings, quick: { ...base.settings.quick, phrases: [{ id: "def1", text: "Old rush" }, { id: "mine1", text: "my own call" }] } } });
    const server = installFakeServer(state);
    render(<App />);
    await screen.findAllByRole("log");
    const quick = screen.getByRole("region", { name: "Quick talk" });
    expect(within(quick).getByRole("button", { name: "my own call" })).toBeTruthy(); // user phrases live under "common"
    expect(within(quick).getByRole("button", { name: "Old rush" })).toBeTruthy();
    fireEvent.click(within(quick).getByRole("button", { name: "Edit" }));
    fireEvent.click(within(quick).getByRole("button", { name: "Restore defaults" }));
    await waitFor(() => expect(settingsCalls(server.calls).at(-1)?.quick?.phrases).toBeTruthy());
    const list = settingsCalls(server.calls).at(-1)!.quick!.phrases as { id: string; text: string }[];
    expect(list).toHaveLength(25);
    expect(list.at(-1)).toEqual({ id: "mine1", text: "my own call" });
    expect(list.some((p) => p.id === "def1")).toBe(false); // the old built-in was replaced by the new set
  });
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  localStorage.clear();
});

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

async function boot(state: AppState = makeState(), override?: Override) {
  const ref = { current: override };
  const server = installFakeServer(state, ref);
  render(<App />);
  await screen.findByRole("log");
  return { server, ref };
}

const translateBox = () => screen.getByPlaceholderText("Type a message to translate…") as HTMLTextAreaElement;
const directBox = () => screen.getByPlaceholderText("Type exactly what you want to say in CS2 chat…") as HTMLTextAreaElement;
const modeDirect = () => fireEvent.click(screen.getByLabelText("Send as typed"));
const modeTranslate = () => fireEvent.click(screen.getByLabelText("Translate, then send"));
const cfgCalls = (calls: { method: string; path: string; body: unknown }[]) => calls.filter((c) => c.path === "/api/cfg").map((c) => c.body as Record<string, unknown>);
const card = () => screen.getByTestId("prepared-card");

describe("two modes, one send key", () => {
  it("starts with nothing prepared and says the key does nothing", async () => {
    await boot();
    expect(screen.queryByTestId("prepared-card")).toBeNull();
    expect(screen.queryByTestId("prepared-card")).toBeNull();
  });

  it("keeps a separate draft per mode and never clears one when switching", async () => {
    await boot();
    fireEvent.change(translateBox(), { target: { value: "Hello world" } });
    modeDirect();
    expect(directBox().value).toBe("");
    fireEvent.change(directBox(), { target: { value: "rush b now" } });
    modeTranslate();
    expect(translateBox().value).toBe("Hello world");
    modeDirect();
    expect(directBox().value).toBe("rush b now");
    modeTranslate();
    modeDirect();
    modeTranslate();
    expect(translateBox().value).toBe("Hello world");
  });

  it("direct mode: no translation request at all, a live preview, and a clear 'prepared' card", async () => {
    const { server } = await boot();
    modeDirect();
    expect(screen.queryByText("Translate to")).toBeNull(); // no target language in this mode
    expect(screen.queryByRole("button", { name: /Engine:/ })).toBeNull();
    expect(screen.queryByTestId("direct-preview")).toBeNull();
    expect((screen.getByRole("button", { name: "Prepare to send" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(directBox(), { target: { value: 'say "hi"; quit  now' } });
    const preview = screen.getByTestId("direct-preview");
    expect(preview.textContent).toBe("say \u201dhi\u201d； quit now"); // the SAME safe encoding the server will write
    fireEvent.click(screen.getByLabelText("Team chat"));
    fireEvent.click(screen.getByRole("button", { name: "Prepare to send" }));

    await waitFor(() => expect(cfgCalls(server.calls)).toHaveLength(1));
    const body = cfgCalls(server.calls)[0]!;
    expect(body).toMatchObject({ message: 'say "hi"; quit  now'.trim(), channel: "team", mode: "direct" });
    expect(typeof body.clickedAt).toBe("number");
    expect(body.original).toBeUndefined();
    expect(server.calls.some((c) => c.path === "/api/translate")).toBe(false);

    const c = await screen.findByTestId("prepared-card");
    expect(c.textContent).toContain("Message prepared");
    expect(c.textContent).toContain("As typed");
    expect(c.textContent).toContain("Team chat");
    expect(c.textContent).toContain("Not sent to the game yet");
  });

  it("shows how long text will be split before it is prepared", async () => {
    await boot();
    modeDirect();
    fireEvent.change(directBox(), { target: { value: "word ".repeat(100) } });
    expect(screen.getByTestId("direct-preview").querySelectorAll("li").length).toBe(3);
    expect(screen.getByText(/Too long: only the first 3 lines were prepared\./)).toBeTruthy();
  });

  it("translate mode: the card says 'Translated' and keeps what you typed", async () => {
    await boot();
    fireEvent.change(translateBox(), { target: { value: "Hello world" } });
    fireEvent.click(screen.getByRole("button", { name: "Translate & prepare" }));
    const c = await screen.findByTestId("prepared-card");
    expect(c.textContent).toContain("Translated");
    expect(c.textContent).toContain("Hallo Welt");
  });

  it("alternating modes always shows only the latest prepared message and its mode", async () => {
    const { server } = await boot();
    fireEvent.change(translateBox(), { target: { value: "first" } });
    fireEvent.click(screen.getByRole("button", { name: "Translate & prepare" }));
    await waitFor(() => expect(card().textContent).toContain("Translated"));
    modeDirect();
    fireEvent.change(directBox(), { target: { value: "second typed" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare to send" }));
    await waitFor(() => expect(card().textContent).toContain("As typed"));
    expect(card().textContent).toContain("second typed");
    expect(card().textContent).not.toContain("Hallo Welt");
    modeTranslate();
    fireEvent.click(screen.getByRole("button", { name: "Translate & prepare" }));
    await waitFor(() => expect(card().textContent).toContain("Translated"));
    expect(card().textContent).not.toContain("second typed");
    const clicks = cfgCalls(server.calls).map((b) => b.clickedAt as number);
    expect(clicks).toHaveLength(3);
    expect(clicks[0]! < clicks[1]! && clicks[1]! < clicks[2]!).toBe(true); // strictly increasing click times
  });

  it("a failed write is reported and never shown as prepared; the previous message stays", async () => {
    let fail = false;
    const { server } = await boot(makeState(), ({ path }) => (path === "/api/cfg" && fail ? json({ error: "cfg-write-failed" }, 500) : undefined));
    modeDirect();
    fireEvent.change(directBox(), { target: { value: "this one works" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare to send" }));
    await waitFor(() => expect(card().textContent).toContain("this one works"));

    fail = true;
    fireEvent.change(directBox(), { target: { value: "this one fails" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare to send" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Could not write the cfg file/);
    expect(card().textContent).toContain("this one works");
    expect(card().textContent).not.toContain("this one fails");
    expect(cfgCalls(server.calls)).toHaveLength(2);
  });

  it("when nothing was ever prepared, a failure leaves the 'nothing prepared' state", async () => {
    await boot(makeState(), ({ path }) => (path === "/api/cfg" ? json({ error: "cfg-dir-missing" }, 500) : undefined));
    modeDirect();
    fireEvent.change(directBox(), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare to send" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/cfg folder was not found/);
    expect(screen.queryByTestId("prepared-card")).toBeNull();
    expect(screen.queryByTestId("prepared-card")).toBeNull();
  });

  it("a slow translation clicked first cannot replace a typed message clicked after it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let lastAccepted = 0;
    const { server } = await boot(makeState(), async ({ path, body }) => {
      if (path === "/api/translate") {
        await gate;
        return json({ status: "done", text: "SLOW TRANSLATION", target: "de", engine: "google", engineUsed: "google" });
      }
      if (path === "/api/cfg") {
        // behave like the real server: an older click than an accepted one is rejected
        const b = body as { clickedAt: number; message: string; mode: string; channel: "all" | "team"; original?: string };
        if (b.clickedAt < lastAccepted) return json({ error: "superseded" }, 409);
        lastAccepted = b.clickedAt;
        return undefined; // let the default handler build the prepared message
      }
      return undefined;
    });

    fireEvent.change(translateBox(), { target: { value: "translate me slowly" } });
    fireEvent.click(screen.getByRole("button", { name: "Translate & prepare" })); // click #1 (waits for the translation)
    modeDirect();
    fireEvent.change(directBox(), { target: { value: "typed quickly" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare to send" })); // click #2
    await waitFor(() => expect(card().textContent).toContain("typed quickly"));

    await act(async () => {
      release();
    });
    await waitFor(() => expect(cfgCalls(server.calls)).toHaveLength(2));
    const [direct, translated] = cfgCalls(server.calls) as [Record<string, number>, Record<string, number>];
    expect(translated!.clickedAt! < direct!.clickedAt!).toBe(true); // the slow one kept its original click time
    expect((await screen.findByRole("alert")).textContent).toMatch(/A newer message was prepared in the meantime/);
    expect(card().textContent).toContain("typed quickly");
    expect(card().textContent).not.toContain("SLOW TRANSLATION");
  });

  it("finished background translations, new chat and edits never change the prepared card", async () => {
    const { server } = await boot();
    modeDirect();
    fireEvent.change(directBox(), { target: { value: "keep me" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare to send" }));
    await waitFor(() => expect(card().textContent).toContain("keep me"));
    const before = card().textContent;

    await act(async () => {
      server.emit({ type: "chat", message: { id: "m1", at: Date.now(), channel: "all", sender: "Zed", dead: false, text: "hola", isSelf: false, formatId: "f" } });
      server.emit({ type: "translation", update: { id: "m1", status: "done", text: "hello", engine: "google" } });
    });
    fireEvent.change(directBox(), { target: { value: "a new draft that is not prepared" } });
    modeTranslate();
    fireEvent.change(translateBox(), { target: { value: "another draft" } });
    expect(card().textContent).toBe(before);
    expect(cfgCalls(server.calls)).toHaveLength(1);
  });

  it("'clear' withdraws the prepared message", async () => {
    const { server } = await boot();
    modeDirect();
    fireEvent.change(directBox(), { target: { value: "to be withdrawn" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare to send" }));
    await waitFor(() => expect(card().textContent).toContain("to be withdrawn"));
    fireEvent.click(within(card()).getByRole("button", { name: "Clear prepared message" }));
    await waitFor(() => expect(screen.queryByTestId("prepared-card")).toBeNull());
    expect(server.calls.some((c) => c.path === "/api/cfg/clear" && c.method === "POST")).toBe(true);
    expect(screen.queryByTestId("prepared-card")).toBeNull();
  });

  it("restores the prepared message from the server after a reload or reconnect", async () => {
    const state = makeState({ prepared: { id: "p1", mode: "direct", channel: "all", lines: ["still waiting"], file: "C:/cs2/cfg/chat_reader.cfg", truncated: false, preparedAt: 1, clickedAt: 1, bindCommand: "b" } });
    await boot(state);
    expect(card().textContent).toContain("still waiting");
    expect(card().textContent).toContain("As typed");
  });

  it("Enter prepares in the current mode (never sends); Shift+Enter is a new line; empty drafts cannot be prepared", async () => {
    const { server } = await boot();
    modeDirect();
    fireEvent.keyDown(directBox(), { key: "Enter" });
    expect(cfgCalls(server.calls)).toHaveLength(0);
    fireEvent.change(directBox(), { target: { value: "via keyboard" } });
    const shift = fireEvent.keyDown(directBox(), { key: "Enter", shiftKey: true });
    expect(shift).toBe(true); // not prevented: the browser inserts the line break
    expect(cfgCalls(server.calls)).toHaveLength(0);
    const plain = fireEvent.keyDown(directBox(), { key: "Enter" });
    expect(plain).toBe(false); // prevented: no stray newline in the draft
    await waitFor(() => expect(card().textContent).toContain("via keyboard"));
  });

  it("Enter in translate mode runs the translate-and-prepare flow once, even when pressed repeatedly", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { server } = await boot(makeState(), async ({ path }) => {
      if (path === "/api/translate") {
        await gate;
        return json({ status: "done", text: "Hallo", target: "de", engine: "google", engineUsed: "google" });
      }
      return undefined;
    });
    fireEvent.change(translateBox(), { target: { value: "hello" } });
    fireEvent.keyDown(translateBox(), { key: "Enter" });
    fireEvent.keyDown(translateBox(), { key: "Enter" });
    fireEvent.keyDown(translateBox(), { key: "Enter" });
    await act(async () => {
      release();
    });
    await waitFor(() => expect(card().textContent).toContain("Hallo"));
    expect(server.calls.filter((c) => c.path === "/api/translate")).toHaveLength(1);
    expect(cfgCalls(server.calls)).toHaveLength(1);
  });

  it("Enter that confirms an IME composition (Chinese / Japanese / Korean) does not prepare anything", async () => {
    const { server } = await boot();
    modeDirect();
    fireEvent.change(directBox(), { target: { value: "ni hao" } });
    fireEvent.keyDown(directBox(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(directBox(), { key: "Process", keyCode: 229 });
    fireEvent.keyDown(directBox(), { key: "Enter", keyCode: 229 });
    expect(cfgCalls(server.calls)).toHaveLength(0);
    expect(directBox().value).toBe("ni hao");
  });

  it("a failed translation withdraws the old prepared message instead of leaving it armed", async () => {
    let fail = false;
    const { server } = await boot(makeState(), ({ path }) => (path === "/api/translate" && fail ? json({ error: "translation-network" }, 502) : undefined));
    fireEvent.change(translateBox(), { target: { value: "first" } });
    fireEvent.keyDown(translateBox(), { key: "Enter" });
    await waitFor(() => expect(card().textContent).toContain("Hallo Welt"));
    fail = true;
    fireEvent.change(translateBox(), { target: { value: "second" } });
    fireEvent.keyDown(translateBox(), { key: "Enter" });
    expect(await screen.findByRole("alert")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("prepared-card")).toBeNull());
    expect(server.calls.some((c) => c.path === "/api/cfg/clear")).toBe(true);
    expect(cfgCalls(server.calls)).toHaveLength(1); // nothing untranslated was written
  });

  it("the original translate-and-prepare flow is unchanged", async () => {
    const { server } = await boot();
    fireEvent.change(translateBox(), { target: { value: "Hello world" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByDisplayValue("Hallo Welt")).toBeTruthy();
    expect(cfgCalls(server.calls)).toHaveLength(0); // a preview prepares nothing
    fireEvent.change(screen.getByDisplayValue("Hallo Welt"), { target: { value: "Hallo Welt!" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare this text" }));
    await waitFor(() => expect(card().textContent).toContain("Hallo Welt!"));
    expect(cfgCalls(server.calls)[0]).toMatchObject({ message: "Hallo Welt!", mode: "translated", original: "Hello world" });
  });
});

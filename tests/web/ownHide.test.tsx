// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../web/src/App";
import { defaultSettings } from "../../src/config/schema";
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
  localStorage.clear();
});

const LRM = "‎";
const history = [
  entry({ id: "1", channel: "all", sender: "Joe", text: "777" }),
  entry({ id: "2", channel: "all", sender: `Joe${LRM}`, text: "888-with-mark" }),
  entry({ id: "3", channel: "ct", sender: `Joe${LRM}`, location: "CT 起始地點", text: "team-888" }),
  entry({ id: "4", channel: "all", sender: "Joe2", text: "other-joe2" }),
  entry({ id: "5", channel: "all", sender: "NotJoe", text: "other-notjoe" }),
];

async function boot(opts: { authorized: string[]; hide: boolean; view: "mixed" | "team" | "all" | "split" }) {
  const base = makeState({ history });
  installFakeServer({
    ...base,
    settings: {
      ...base.settings,
      general: { ...defaultSettings().general, hideOwnMessages: opts.hide, translateOwnMessages: false },
      appearance: { ...base.settings.appearance, chatView: opts.view },
    },
    identity: { authorized: opts.authorized, manual: opts.authorized, logConfirmed: null, steam: null, suggestSteam: false },
  });
  render(<App />);
  await screen.findAllByRole("log");
}

const mine = ["777", "888-with-mark", "team-888"];
const others = ["other-joe2", "other-notjoe"];

describe("options dropdown", () => {
  const menu = () => screen.getByText("Options").closest("details") as HTMLDetailsElement;
  async function bootMenu() {
    installFakeServer(makeState({ history }));
    render(<App />);
    await screen.findAllByRole("log");
  }

  it("opens, closes on an outside press, on Esc and on a second click, and stays open while ticking boxes", async () => {
    await bootMenu();
    expect(menu().open).toBe(false);
    fireEvent.click(screen.getByText("Options"));
    expect(menu().open).toBe(true);

    fireEvent.click(screen.getByLabelText("Hide my messages"));
    await waitFor(() => expect((screen.getByLabelText("Hide my messages") as HTMLInputElement).checked).toBe(true));
    fireEvent.pointerDown(screen.getByLabelText("Don’t translate my messages"));
    expect(menu().open).toBe(true); // inside presses never close it

    fireEvent.pointerDown(document.body);
    expect(menu().open).toBe(false);
    expect((screen.getByLabelText("Hide my messages") as HTMLInputElement).checked).toBe(true); // the choice stays

    fireEvent.click(screen.getByText("Options"));
    expect(menu().open).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(menu().open).toBe(false);
    expect(document.activeElement).toBe(screen.getByText("Options"));

    fireEvent.click(screen.getByText("Options"));
    expect(menu().open).toBe(true);
    fireEvent.click(screen.getByText("Options"));
    expect(menu().open).toBe(false);
  });

  it("pressing another control closes it without blocking that control", async () => {
    await bootMenu();
    fireEvent.click(screen.getByText("Options"));
    const clear = screen.getByRole("button", { name: /clear/i });
    fireEvent.pointerDown(clear);
    expect(menu().open).toBe(false);
    expect(clear.hasAttribute("disabled")).toBe(false);
  });
});

describe("hide my messages", () => {
  for (const view of ["mixed", "team", "all", "split"] as const) {
    it(`hides only my lines in the ${view} layout, even with an invisible mark after the name`, async () => {
      await boot({ authorized: ["Joe"], hide: true, view });
      for (const m of mine) expect(screen.queryByText(m)).toBeNull();
      if (view === "mixed" || view === "all" || view === "split") for (const o of others) expect(screen.getByText(o)).toBeTruthy();
    });
  }

  it("shows everything again when the option is off (nothing was deleted)", async () => {
    await boot({ authorized: ["Joe"], hide: false, view: "mixed" });
    for (const m of [...mine, ...others]) expect(screen.getByText(m)).toBeTruthy();
  });

  it("an unconfirmed name hides nothing and tells the user why", async () => {
    await boot({ authorized: [], hide: true, view: "mixed" });
    for (const m of [...mine, ...others]) expect(screen.getByText(m)).toBeTruthy();
    expect(screen.getAllByText(/isn.t confirmed yet/).length).toBeGreaterThan(0);
  });

  it("both option boxes start unchecked by default and map to the right settings", async () => {
    const server = installFakeServer(makeState({ history }));
    render(<App />);
    await screen.findAllByRole("log");
    const skip = screen.getByLabelText("Don’t translate my messages") as HTMLInputElement;
    const hide = screen.getByLabelText("Hide my messages") as HTMLInputElement;
    expect(skip.checked).toBe(false);
    expect(hide.checked).toBe(false);
    fireEvent.click(skip);
    await waitFor(() => expect(skip.checked).toBe(true));
    const calls = server.calls.filter((c) => c.path === "/api/settings").map((c) => c.body);
    expect(calls.at(-1)).toEqual({ general: { translateOwnMessages: false } });
  });

  it("toggling the checkbox re-filters the current list at once", async () => {
    await boot({ authorized: ["Joe"], hide: false, view: "mixed" });
    expect(screen.getByText("777")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Hide my messages"));
    await waitFor(() => expect(screen.queryByText("777")).toBeNull());
    fireEvent.click(screen.getByLabelText("Hide my messages"));
    await waitFor(() => expect(screen.getByText("777")).toBeTruthy());
  });
});

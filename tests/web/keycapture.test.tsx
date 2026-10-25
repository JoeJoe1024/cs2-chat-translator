// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../web/src/App";
import { installFakeServer, makeState } from "./fakeServer";

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

async function openKeys(bindKey = "kp_plus") {
  const state = makeState();
  state.settings.cs2.bindKey = bindKey;
  const server = installFakeServer(state);
  render(<App />);
  await screen.findByRole("log");
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.click(screen.getByRole("tab", { name: "CS2" }));
  return server;
}

const press = (code: string, key = "") => fireEvent.keyDown(window, { code, key });
const startCapture = () => fireEvent.click(screen.getByRole("button", { name: "Change key" }));
const bindCalls = (calls: { method: string; path: string; body: unknown }[]) =>
  calls.filter((c) => c.path === "/api/settings" && c.method === "PUT" && (c.body as { cs2?: { bindKey?: string } }).cs2?.bindKey).map((c) => (c.body as { cs2: { bindKey: string } }).cs2.bindKey);

describe("send key capture", () => {
  it("shows the current key with its friendly name, CS2 name and a copyable bind command", async () => {
    await openKeys();
    expect(screen.getByText("Numpad + · CS2 name: kp_plus")).toBeTruthy();
    expect(screen.getByText('bind "kp_plus" "exec chat_reader.cfg"')).toBeTruthy();
    expect(screen.getByText("After the message is prepared, press this key in CS2 to send it.")).toBeTruthy();
  });

  it("captures a keypress, translates it to the CS2 name, and only saves after confirmation", async () => {
    const server = await openKeys();
    startCapture();
    expect(screen.getByText("Press the key you want to use… (Esc to cancel)")).toBeTruthy();
    press("Numpad1", "End"); // Num Lock off: the browser says "End", the physical key is still keypad 1
    expect(screen.getByText("Numpad 1 · CS2 name: kp_end")).toBeTruthy();
    expect(screen.queryByText("Press the key you want to use… (Esc to cancel)")).toBeNull();
    expect(screen.getByText(/Num Lock on or off/)).toBeTruthy();
    expect(bindCalls(server.calls)).toEqual([]); // nothing saved yet

    fireEvent.click(screen.getByRole("button", { name: "Use this key" }));
    await waitFor(() => expect(bindCalls(server.calls)).toEqual(["kp_end"]));
    // the bind command and the unbind hint follow the new key
    expect(await screen.findByText('bind "kp_end" "exec chat_reader.cfg"')).toBeTruthy();
    expect(screen.getByText('unbind "kp_plus"')).toBeTruthy();
    expect(screen.getByText(/CS2 keeps the old binding kp_plus until you remove it/)).toBeTruthy();
    expect(screen.getByText("Numpad 1 · CS2 name: kp_end")).toBeTruthy();
  });

  it("Esc cancels without changing anything", async () => {
    const server = await openKeys();
    startCapture();
    press("Escape", "Escape");
    expect(screen.queryByText("Press the key you want to use… (Esc to cancel)")).toBeNull();
    expect(screen.getByText("Numpad + · CS2 name: kp_plus")).toBeTruthy();
    expect(bindCalls(server.calls)).toEqual([]);
    // and the keyboard is no longer being swallowed
    const event = new KeyboardEvent("keydown", { code: "KeyA", key: "a", cancelable: true, bubbles: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("explains keys it cannot use and keeps listening", async () => {
    await openKeys();
    startCapture();
    press("Backquote", "`");
    expect((await screen.findByRole("alert")).textContent).toMatch(/opens the CS2 console/);
    press("ShiftLeft", "Shift");
    expect((await screen.findByRole("alert")).textContent).toMatch(/Shift, Ctrl, Alt and Windows keys can’t be used on their own/);
    press("Semicolon", ";");
    expect((await screen.findByRole("alert")).textContent).toMatch(/Punctuation keys can’t be identified reliably/);
    press("PrintScreen", "PrintScreen");
    expect((await screen.findByRole("alert")).textContent).toMatch(/reserved by Windows/);
    expect(screen.getByText("Press the key you want to use… (Esc to cancel)")).toBeTruthy(); // still listening
    press("F8", "F8");
    expect(screen.getByText("F8 · CS2 name: f8")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("warns when the key is normally used by CS2, but still lets the user decide", async () => {
    const server = await openKeys();
    startCapture();
    press("KeyW", "w");
    expect(screen.getByText(/W is normally used in CS2 for: movement/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(bindCalls(server.calls)).toEqual([]);

    startCapture();
    press("KeyE", "e");
    expect(screen.getByText(/E is normally used in CS2 for: use/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use this key" }));
    await waitFor(() => expect(bindCalls(server.calls)).toEqual(["e"]));
  });

  it("does not warn for keys CS2 leaves free", async () => {
    await openKeys();
    startCapture();
    press("F9", "F9");
    expect(screen.queryByText(/normally used in CS2/)).toBeNull();
  });

  it("mentions the CS2 name when the keyboard layout reports a different letter", async () => {
    await openKeys();
    startCapture();
    press("KeyQ", "a"); // AZERTY
    expect(screen.getByText("A · CS2 name: a")).toBeTruthy();
    expect(screen.getByText(/Your keyboard layout reports this key as “a”/)).toBeTruthy();
  });

  it("recognises side mouse buttons and stops the browser from navigating back / forward", async () => {
    const server = await openKeys();
    startCapture();
    const down = new MouseEvent("mousedown", { button: 3, cancelable: true, bubbles: true });
    act(() => {
      window.dispatchEvent(down);
    });
    expect(down.defaultPrevented).toBe(true);
    expect(screen.getByText("Mouse side button 4 (back) · CS2 name: mouse4")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use this key" }));
    await waitFor(() => expect(bindCalls(server.calls)).toEqual(["mouse4"]));
  });

  it("ignores left and right clicks while capturing (the UI stays usable)", async () => {
    await openKeys();
    startCapture();
    fireEvent.mouseDown(window, { button: 0 });
    fireEvent.mouseDown(window, { button: 2 });
    expect(screen.getByText("Press the key you want to use… (Esc to cancel)")).toBeTruthy();
    fireEvent.mouseDown(window, { button: 4 });
    expect(screen.getByText(/CS2 name: mouse5/)).toBeTruthy();
  });

  it("can capture the mouse wheel", async () => {
    await openKeys();
    startCapture();
    fireEvent.wheel(window, { deltaY: -100 });
    expect(screen.getByText(/CS2 name: mwheelup/)).toBeTruthy();
  });

  it("offers a list as a fallback, grouped by kind", async () => {
    const server = await openKeys();
    const list = screen.getByLabelText("Or choose from a list") as HTMLSelectElement;
    expect(list.querySelectorAll("optgroup").length).toBe(6);
    fireEvent.change(list, { target: { value: "f8" } });
    expect(screen.getByText("F8 · CS2 name: f8")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use this key" }));
    await waitFor(() => expect(bindCalls(server.calls)).toEqual(["f8"]));
  });

  it("flags an old hand-typed key name that cannot be verified, without breaking it", async () => {
    await openKeys("scancode42");
    expect(screen.getByText(/“scancode42” is a custom key name that can’t be verified/)).toBeTruthy();
    expect(screen.getByText('bind "scancode42" "exec chat_reader.cfg"')).toBeTruthy();
  });

  it("stops listening when the dialog content is left (no stray key capture)", async () => {
    await openKeys();
    startCapture();
    fireEvent.click(screen.getByRole("tab", { name: "General" }));
    const event = new KeyboardEvent("keydown", { code: "KeyZ", key: "z", cancelable: true, bubbles: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

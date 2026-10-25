// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function boot(appearance: Record<string, unknown> = {}) {
  const base = makeState({ history: [entry({ id: "a", sender: "Alice", text: "keep this line" })] });
  const state = makeState({ history: base.history, settings: { ...base.settings, appearance: { ...base.settings.appearance, ...appearance } } });
  const server = installFakeServer(state);
  render(<App />);
  await screen.findAllByRole("log");
  return server;
}
const sep = () => screen.getByRole("separator");
const root = () => document.querySelector("main.workspace") as HTMLElement;
const saved = (calls: { path: string; body: unknown }[]) => calls.filter((c) => c.path === "/api/settings").map((c) => c.body as { appearance?: Record<string, unknown> });

/** jsdom has no layout: give the workspace 1000px and let the right column take what the variable says. */
function fakeLayout() {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const pct = parseFloat(root().style.getPropertyValue("--right-pct")) || 30;
    const w = this.classList.contains("workspace") ? 1000 : this.classList.contains("side") ? pct * 10 : 0;
    return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: 0, width: w, height: 0, toJSON: () => ({}) } as DOMRect;
  });
}

describe("resizable workspace", () => {
  it("starts at 70/30 when nothing is saved, keeps a saved width, and resets to 70/30 on double-click", async () => {
    const fresh = await boot();
    expect(root().style.getPropertyValue("--right-pct")).toBe("30%");
    expect(sep().getAttribute("aria-valuenow")).toBe("30");
    expect(saved(fresh.calls)).toHaveLength(0); // nothing is written just by opening the app
    cleanup();
    const server = await boot({ rightPct: 33 });
    expect(sep().getAttribute("aria-orientation")).toBe("vertical");
    expect(sep().getAttribute("aria-label")).toBe("Resize panels");
    expect(sep().getAttribute("aria-valuenow")).toBe("33");
    expect(root().style.getPropertyValue("--right-pct")).toBe("33%");
    fireEvent.doubleClick(sep());
    await waitFor(() => expect(saved(server.calls).at(-1)).toEqual({ appearance: { rightPct: null } }));
    expect(root().style.getPropertyValue("--right-pct")).toMatch(/^30(.00)?%$/);
  });

  it("the keyboard resizes within 25-55% and saves once after the last key", async () => {
    fakeLayout();
    const server = await boot();
    fireEvent.keyDown(sep(), { key: "ArrowLeft" });
    fireEvent.keyDown(sep(), { key: "ArrowLeft", shiftKey: true });
    expect(root().style.getPropertyValue("--right-pct")).toBe("37.00%");
    expect(saved(server.calls)).toHaveLength(0); // nothing saved while keys are still coming
    await waitFor(() => expect(saved(server.calls).at(-1)).toEqual({ appearance: { rightPct: 37 } }));
    expect(saved(server.calls)).toHaveLength(1);
    fireEvent.keyDown(sep(), { key: "Home" });
    expect(root().style.getPropertyValue("--right-pct")).toBe("55.00%");
    fireEvent.keyDown(sep(), { key: "End" });
    expect(root().style.getPropertyValue("--right-pct")).toBe("25.00%");
  });

  it("dragging changes the width live without saving, clamps it, and saves when released", async () => {
    fakeLayout();
    const server = await boot();
    fireEvent.pointerDown(sep(), { button: 0, pointerId: 1, clientX: 600 });
    expect(root().classList.contains("workspace--dragging")).toBe(true);
    fireEvent.pointerMove(sep(), { pointerId: 1, clientX: 700 }); // right edge 1000 => 30% to the right
    expect(root().style.getPropertyValue("--right-pct")).toBe("30.00%");
    fireEvent.pointerMove(sep(), { pointerId: 1, clientX: 100 }); // far too wide => capped
    expect(root().style.getPropertyValue("--right-pct")).toBe("55.00%");
    fireEvent.pointerMove(sep(), { pointerId: 1, clientX: 990 }); // far too narrow => floor
    expect(root().style.getPropertyValue("--right-pct")).toBe("25.00%");
    expect(saved(server.calls)).toHaveLength(0);
    fireEvent.pointerMove(sep(), { pointerId: 1, clientX: 650 });
    fireEvent.pointerUp(sep(), { pointerId: 1 });
    expect(root().classList.contains("workspace--dragging")).toBe(false);
    await waitFor(() => expect(saved(server.calls)).toHaveLength(1));
    expect(saved(server.calls)[0]).toEqual({ appearance: { rightPct: 35 } });
  });
});

describe("collapsible right panel", () => {
  it("collapses and expands without losing chat, the draft or the prepared message, and remembers the state", async () => {
    const server = await boot();
    fireEvent.change(screen.getByPlaceholderText("Type a message to translate…"), { target: { value: "unfinished draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Rush B!" }));
    await screen.findByTestId("prepared-card");

    fireEvent.click(screen.getByRole("button", { name: "Collapse the right panel" }));
    await waitFor(() => expect(root().classList.contains("workspace--collapsed")).toBe(true));
    expect(saved(server.calls).at(-1)).toEqual({ appearance: { rightCollapsed: true } });
    expect(screen.getByText("keep this line")).toBeTruthy();
    expect(document.querySelector(".side")?.hasAttribute("inert")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Show the right panel" }));
    await waitFor(() => expect(root().classList.contains("workspace--collapsed")).toBe(false));
    expect((screen.getByPlaceholderText("Type a message to translate…") as HTMLTextAreaElement).value).toBe("unfinished draft");
    expect(screen.getByTestId("prepared-card")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show the right panel" })).toBeNull();
  });

  it("starts collapsed when saved that way, and the divider keeps the width for later", async () => {
    await boot({ rightCollapsed: true, rightPct: 47 });
    expect(root().classList.contains("workspace--collapsed")).toBe(true);
    expect(root().style.getPropertyValue("--right-pct")).toBe("47%");
    expect(screen.getByRole("button", { name: "Show the right panel" })).toBeTruthy();
  });
});

describe("JoeLucky brand link", () => {
  it("opens the official site in a new tab, safely, with an accessible name and both logo variants", async () => {
    await boot();
    const link = screen.getByRole("link", { name: "Visit the JoeLucky website" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://joelucky.io");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.title).toBe("Visit the JoeLucky website");
    expect([...link.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual(["/brand/joelucky-logo-light.png", "/brand/joelucky-logo-dark.png"]);
  });
});

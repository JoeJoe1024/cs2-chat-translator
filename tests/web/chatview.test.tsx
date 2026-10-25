// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  localStorage.clear();
});

const history = [
  entry({ id: "a", channel: "all", sender: "Al", text: "all-msg" }),
  entry({ id: "c", channel: "ct", sender: "Cy", text: "ct-msg" }),
  entry({ id: "t", channel: "t", sender: "Ty", text: "t-msg" }),
  entry({ id: "s", channel: "spec", sender: "Sp", text: "spec-msg" }),
];

async function boot() {
  const server = installFakeServer(makeState({ history }));
  render(<App />);
  await screen.findAllByRole("log");
  return server;
}
const view = () => screen.getByLabelText("Display") as HTMLSelectElement;
const chooseView = async (v: string) => {
  fireEvent.change(view(), { target: { value: v } });
  await waitFor(() => expect(view().value).toBe(v));
};

describe("chat layouts", () => {
  it("mixed shows everything; team and all never mix channels; nothing is lost when switching back", async () => {
    await boot();
    expect(screen.getByText("spec-msg")).toBeTruthy();

    await chooseView("team");
    expect(screen.getByText("ct-msg")).toBeTruthy();
    expect(screen.getByText("t-msg")).toBeTruthy();
    expect(screen.queryByText("all-msg")).toBeNull();
    expect(screen.queryByText("spec-msg")).toBeNull();
    expect(screen.getByText(/1 message\(s\) from other channels/)).toBeTruthy();

    await chooseView("all");
    expect(screen.getByText("all-msg")).toBeTruthy();
    expect(screen.queryByText("ct-msg")).toBeNull();

    await chooseView("mixed");
    for (const m of ["all-msg", "ct-msg", "t-msg", "spec-msg"]) expect(screen.getByText(m)).toBeTruthy();
  });

  it("split puts team on the left, all on the right, and surfaces other channels separately", async () => {
    await boot();
    await chooseView("split");
    const logs = screen.getAllByRole("log");
    expect(logs).toHaveLength(2);
    expect(within(logs[0]!).getByText("ct-msg")).toBeTruthy();
    expect(within(logs[0]!).getByText("t-msg")).toBeTruthy();
    expect(within(logs[0]!).queryByText("all-msg")).toBeNull();
    expect(within(logs[1]!).getByText("all-msg")).toBeTruthy();
    expect(screen.queryByText("spec-msg")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Other channels \(1\)/ }));
    expect(screen.getByText("spec-msg")).toBeTruthy();
  });

  it("A+/A- change one shared size, saved through settings, within 12-24", async () => {
    const server = await boot();
    const chat = screen.getByRole("region", { name: "Chat" });
    expect(chat.style.getPropertyValue("--chat-fs")).toBe("15px");
    fireEvent.click(screen.getByRole("button", { name: "Larger chat text" }));
    await waitFor(() => expect(chat.style.getPropertyValue("--chat-fs")).toBe("16px"));
    expect(server.calls.find((c) => c.path === "/api/settings")?.body).toEqual({ appearance: { chatFontSize: 16 } });
    await chooseView("split");
    expect(chat.style.getPropertyValue("--chat-fs")).toBe("16px");
  });
});

describe("quick translation settings stay in sync with the settings window", () => {
  it("changing the chat engine in the toolbar updates the settings dialog, and warns when Gemini has no key", async () => {
    const server = await boot();
    fireEvent.change(screen.getByLabelText("Engine for incoming chat"), { target: { value: "gemini" } });
    await waitFor(() => expect((screen.getByLabelText("Engine for incoming chat") as HTMLSelectElement).value).toBe("gemini"));
    expect(server.calls.find((c) => c.path === "/api/settings")?.body).toEqual({ translation: { chatEngine: "gemini" } });
    expect(screen.getAllByText(/Gemini needs an API key/).length).toBeGreaterThan(0);
    // chat history is untouched
    expect(screen.getByText("all-msg")).toBeTruthy();
  });
});

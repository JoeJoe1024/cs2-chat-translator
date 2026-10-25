// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_LOCALES } from "../../src/shared/uiLocales";
import { App } from "../../web/src/App";
import { installFakeServer, makeState } from "./fakeServer";

function setup(languages: string[]) {
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
  Object.defineProperty(navigator, "language", { value: languages[0], configurable: true });
  Object.defineProperty(navigator, "languages", { value: languages, configurable: true });
}
beforeEach(() => setup(["en-US"]));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function boot(uiLanguage: string = "auto") {
  const base = makeState();
  const state = makeState({ settings: { ...base.settings, general: { ...base.settings.general, uiLanguage: uiLanguage as never } } });
  const server = installFakeServer(state);
  render(<App />);
  await screen.findAllByRole("log");
  return server;
}
const settingsCalls = (calls: { path: string; body: unknown }[]) => calls.filter((c) => c.path === "/api/settings").map((c) => c.body as Record<string, Record<string, unknown>>);

describe("interface language: automatic first start", () => {
  it.each([
    [["de-DE", "en-US"], "Übersetzen & senden"],
    [["zh-TW", "en"], "翻譯並送出"],
    [["zh-CN"], "翻译并发送"],
    [["ja-JP"], "翻訳して送信"],
    [["pt-PT"], "Traduzir e enviar"],
    [["sv-SE", "ru-RU"], "Перевод и отправка"],
    [["sv-SE"], "Translate & send"],
  ])("%j shows the matching interface", async (languages, title) => {
    setup(languages as string[]);
    await boot("auto");
    expect(screen.getByRole("heading", { name: title })).toBeTruthy();
  });

  it("follows a change of the system language while on automatic", async () => {
    setup(["en-US"]);
    await boot("auto");
    expect(screen.getByRole("heading", { name: "Translate & send" })).toBeTruthy();
    Object.defineProperty(navigator, "language", { value: "fr-FR", configurable: true });
    Object.defineProperty(navigator, "languages", { value: ["fr-FR"], configurable: true });
    await act(async () => {
      window.dispatchEvent(new Event("languagechange"));
    });
    expect(await screen.findByRole("heading", { name: "Traduire et envoyer" })).toBeTruthy();
  });

  it("a manual choice beats the system language and ignores later system changes", async () => {
    setup(["de-DE"]);
    await boot("ko");
    expect(screen.getByRole("heading", { name: "번역하고 보내기" })).toBeTruthy();
    Object.defineProperty(navigator, "languages", { value: ["fr-FR"], configurable: true });
    await act(async () => {
      window.dispatchEvent(new Event("languagechange"));
    });
    expect(screen.getByRole("heading", { name: "번역하고 보내기" })).toBeTruthy();
  });
});

describe("interface language: the selector", () => {
  async function openGeneral(name: string) {
    fireEvent.click(await screen.findByRole("button", { name }));
    return screen.getByLabelText(/Interface language|介面語言|界面语言|Interface/) as HTMLSelectElement;
  }

  it("offers automatic plus all 13 languages, named in the current interface language", async () => {
    await boot("en");
    const select = await openGeneral("Settings");
    const options = [...select.options];
    expect(options.map((o) => o.value)).toEqual(["auto", ...UI_LOCALES]);
    expect(options.find((o) => o.value === "ja")!.textContent).toBe("Japanese — 日本語");
    expect(options.find((o) => o.value === "en")!.textContent).toBe("English");
  });

  it("names them in Traditional Chinese when that is the interface language", async () => {
    await boot("zh-TW");
    const select = await openGeneral("設定");
    expect(select.options.length).toBe(14);
    expect([...select.options].find((o) => o.value === "de")!.textContent).toBe("德文 — Deutsch");
    expect([...select.options].find((o) => o.value === "zh-CN")!.textContent).toBe("簡體中文 — 简体中文");
  });

  it("switching language changes only the text: draft, prepared message, chat language and quick phrases stay", async () => {
    const server = await boot("en");
    const box = screen.getByPlaceholderText("Type a message to translate…") as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole("radio", { name: "Send as typed" }));
    const direct = screen.getByPlaceholderText("Type exactly what you want to say in CS2 chat…") as HTMLTextAreaElement;
    fireEvent.change(direct, { target: { value: "ready to go" } });
    fireEvent.keyDown(direct, { key: "Enter" });
    await screen.findByTestId("prepared-card");
    fireEvent.click(screen.getByRole("radio", { name: "Translate, then send" }));
    fireEvent.change(box, { target: { value: "unfinished draft" } });

    const select = await openGeneral("Settings");
    fireEvent.change(select, { target: { value: "ru" } });
    await waitFor(() => expect(settingsCalls(server.calls).at(-1)).toEqual({ general: { uiLanguage: "ru" } }));
    await screen.findByRole("heading", { name: "Перевод и отправка" });
    expect((screen.getByDisplayValue("unfinished draft") as HTMLTextAreaElement).value).toBe("unfinished draft");
    expect(screen.getByTestId("prepared-card").textContent).toContain("ready to go");
    expect(JSON.stringify(settingsCalls(server.calls))).not.toMatch(/TargetLanguage|apiKey|quick|bindKey/);
  });
});

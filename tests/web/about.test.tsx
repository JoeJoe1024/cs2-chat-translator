// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_VERSION } from "../../src/shared/version";
import { App } from "../../web/src/App";
import { installFakeServer, makeState } from "./fakeServer";

function setup(lang: string) {
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
  Object.defineProperty(navigator, "language", { value: lang, configurable: true });
}
beforeEach(() => setup("en-US"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function openAbout(openName: string, tabName: string) {
  installFakeServer(makeState());
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: openName }));
  fireEvent.click(screen.getByRole("tab", { name: tabName }));
}

describe("About tab", () => {
  it("English: version from the project, developer, story, planned-policy wording and the two links", async () => {
    await openAbout("Settings", "About");
    const panel = document.getElementById("panel-about")!;
    expect(panel.textContent).toContain(`Version ${APP_VERSION}`);
    expect(panel.textContent).toContain("Joe (JoeJoe1024)");
    expect(panel.textContent).toContain("I’m a Counter-Strike 2 player who often encounters language barriers");
    expect(panel.textContent).toContain("Free to use");
    expect(panel.textContent).not.toMatch(/source-available/i);
    expect(panel.textContent).toContain("No unauthorised commercial use");
    expect(panel.textContent).toContain("PolyForm Noncommercial License 1.0.0");
    expect(panel.textContent).toContain("Streamers may use it free of charge");
    expect(panel.textContent).not.toMatch(/planned policy|not been decided/i);
    expect((screen.getByRole("link", { name: "LICENSE" }) as HTMLAnchorElement).href).toBe("https://github.com/JoeJoe1024/cs2-chat-translator/blob/main/LICENSE");
    expect((screen.getByRole("link", { name: "STREAMING_PERMISSION" }) as HTMLAnchorElement).href).toBe("https://github.com/JoeJoe1024/cs2-chat-translator/blob/main/STREAMING_PERMISSION.md");
    expect(panel.textContent).not.toMatch(/open source|MIT|GPL/i);
    const gh = screen.getByRole("link", { name: "GitHub" }) as HTMLAnchorElement;
    const jl = screen.getByRole("link", { name: "Explore my other project: JoeLucky" }) as HTMLAnchorElement;
    expect(gh.href).toBe("https://github.com/JoeJoe1024/cs2-chat-translator");
    expect(jl.href).toBe("https://joelucky.io/");
    for (const a of [gh, jl]) {
      expect(a.target).toBe("_blank");
      expect(a.rel).toBe("noopener noreferrer");
    }
    expect(panel.textContent).not.toContain("private");
    const mail = screen.getByRole("link", { name: "support@joelucky.io" }) as HTMLAnchorElement;
    expect(mail.getAttribute("href")).toBe("mailto:support@joelucky.io");
    expect(panel.textContent).toContain("Contact the developer");
    expect(panel.textContent).toContain("commercial licence enquiries");
    expect(panel.textContent).not.toMatch(/gmail/i);
    expect(panel.textContent).toContain("Enjoying CS2 Chat Translator?");
    expect(panel.textContent).toContain("appreciate a ⭐ Star on GitHub");
    expect(screen.getByRole("link", { name: "Open GitHub" }).getAttribute("href")).toBe("https://github.com/JoeJoe1024/cs2-chat-translator");
  });

  it("Traditional Chinese wording", async () => {
    setup("zh-TW");
    await openAbout("設定", "關於");
    const panel = document.getElementById("panel-about")!;
    expect(panel.textContent).toContain("Joe(JoeJoe1024)");
    expect(panel.textContent).toContain("我是一位喜歡 Counter-Strike 2 的玩家");
    expect(panel.textContent).toContain("免費使用");
    expect(panel.textContent).toContain("禁止未經授權的商業使用");
    expect(panel.textContent).not.toContain("Source-available");
    expect(panel.textContent).toContain("依 PolyForm Noncommercial License 1.0.0 授權");
    expect(panel.textContent).not.toContain("尚未確定");
    expect(panel.textContent).toContain("喜歡這個工具嗎?");
    expect(panel.textContent).toContain("歡迎到 GitHub 幫我點一顆 ⭐ Star");
    expect(panel.textContent).not.toContain("私人")
    expect(screen.getByRole("link", { name: "探索我的另一個專案:JoeLucky" })).toBeTruthy();
  });
});

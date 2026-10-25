import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pub = (f: string) => `web/public/${f}`;

describe("CS2 Chat Translator logo", () => {
  it("ships the vector, the PNG sizes and an ICO with the usual sizes", () => {
    const svg = readFileSync(pub("cs2-chat-translator-logo.svg"), "utf8");
    expect(svg).toContain('viewBox="0 0 128 128"');
    expect(svg).not.toContain("<image"); // real vector, no embedded bitmap
    const png = (f: string) => readFileSync(pub(f)).readUInt32BE(16); // width from the IHDR chunk
    expect([png("logo-256.png"), png("logo-512.png")]).toEqual([256, 512]);
    const ico = readFileSync(pub("favicon.ico"));
    expect(ico.readUInt16LE(4)).toBe(4);
    const sizes = Array.from({ length: 4 }, (_, i) => ico[6 + i * 16] || 256).sort((a, b) => a - b);
    expect(sizes).toEqual([16, 32, 48, 256]);
  });

  it("is linked as the favicon, shown in the header, and the old icon is gone", () => {
    const html = readFileSync("web/index.html", "utf8");
    expect(html).toContain('href="/cs2-chat-translator-logo.svg"');
    expect(html).toContain('href="/favicon.ico"');
    expect(existsSync(pub("favicon.svg"))).toBe(false);
    const header = readFileSync("web/src/components/Header.tsx", "utf8");
    expect(header).toContain('src="/cs2-chat-translator-logo.svg"');
    expect(header).toContain("/brand/joelucky-logo-light.png"); // the JoeLucky mark in the middle is untouched
    expect(statSync("logo/code.html").size).toBeGreaterThan(0); // the original material stays
  });

  it("both READMEs show the logo from a path that exists", () => {
    for (const f of ["README.md", "README.zh-TW.md"]) {
      const m = /<img src="([^"]+logo-256\.png)"/.exec(readFileSync(f, "utf8"));
      expect(m, f).not.toBeNull();
      expect(existsSync(m![1]!)).toBe(true);
    }
  });
});

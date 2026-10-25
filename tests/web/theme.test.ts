// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { applyTheme, effectiveTheme } from "../../web/src/lib/theme";
import { contrast, loadTokens, mix, type Scheme } from "./contrast";

const tokens = loadTokens();
const schemes: Scheme[] = ["light", "dark"];

describe("design tokens (WCAG contrast, both themes)", () => {
  it("defines every token for both themes", () => {
    for (const name of ["bg", "surface", "surface-2", "surface-3", "border", "text", "text-muted", "accent", "on-accent", "accent-text", "ct", "t", "all", "ok", "warn", "danger", "focus"]) {
      expect(tokens.light[name], `light --${name}`).toBeDefined();
      expect(tokens.dark[name], `dark --${name}`).toBeDefined();
    }
  });

  const ratio = (s: Scheme, fg: string, bg: string) => contrast(tokens[s][fg]!, tokens[s][bg]!);

  describe.each(schemes)("%s theme", (s) => {
    const t = tokens[s];
    it.each([
      ["text", "bg"], ["text", "surface"], ["text", "surface-2"], ["text", "surface-3"],
      ["text-muted", "bg"], ["text-muted", "surface"], ["text-muted", "surface-2"], ["text-muted", "surface-3"],
      ["accent-text", "surface"], ["accent-text", "surface-2"],
      ["on-accent", "accent"],
      ["ct", "surface"], ["ct", "surface-2"], ["t", "surface"], ["t", "surface-2"], ["all", "surface"], ["all", "surface-2"],
      ["ok", "surface"], ["warn", "surface"], ["danger", "surface"], ["ok", "surface-2"], ["warn", "surface-2"], ["danger", "surface-2"],
    ])("%s on %s has ≥ 4.5:1 (AA text)", (fg, bg) => {
      expect(ratio(s, fg, bg)).toBeGreaterThanOrEqual(4.5);
    });

    it.each([
      ["border", "surface"], ["border", "bg"], ["focus", "surface"], ["focus", "bg"], ["accent", "surface"],
    ])("%s against %s has ≥ 3:1 (AA non-text)", (fg, bg) => {
      expect(ratio(s, fg, bg)).toBeGreaterThanOrEqual(3);
    });

    it("team chips stay readable on their own tinted background", () => {
      for (const c of ["ct", "t", "all"]) {
        const tint = mix(t[c]!, t["surface-2"]!, 12);
        expect(contrast(t[c]!, tint), `${c} chip`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it("CT, T and ALL are distinguishable from each other", () => {
      const pairs: [string, string][] = [["ct", "t"], ["ct", "all"], ["t", "all"]];
      for (const [a, b] of pairs) {
        const [x, y] = [t[a]!, t[b]!];
        const dist = Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
        expect(dist, `${a} vs ${b}`).toBeGreaterThan(70);
      }
    });

    it("tinted surfaces keep text readable (own message, ready card)", () => {
      expect(contrast(t.text!, mix(t.accent!, t["surface-2"]!, 10))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.ok!, mix(t.ok!, t.surface!, 9))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t["text-muted"]!, mix(t.ok!, t.surface!, 9))).toBeGreaterThanOrEqual(4.5);
    });
  });

  it("uses only var(--token) colours in component styles (no hard-coded text colours)", () => {
    const css = fs.readFileSync(path.resolve("web/src/styles/components.css"), "utf8") + fs.readFileSync(path.resolve("web/src/styles/base.css"), "utf8");
    const hardCoded = [...css.matchAll(/(?<!-)\b(color|background|border-color)\s*:\s*#[0-9a-f]{3,8}\b/gi)].map((m) => m[0]);
    expect(hardCoded).toEqual([]);
  });

  it("the theme swatches are the only hex colours outside tokens.css", () => {
    const css = fs.readFileSync(path.resolve("web/src/styles/components.css"), "utf8");
    const lines = css.split("\n").filter((l) => /#[0-9a-f]{6}/i.test(l));
    expect(lines.every((l) => l.includes("gradient"))).toBe(true);
  });
});

describe("theme switching", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
    localStorage.clear();
  });

  it("system leaves the attribute off so CSS follows the OS", () => {
    applyTheme("dark");
    applyTheme("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem("cs2t-theme")).toBeNull();
  });

  it("light / dark set the attribute and remember it for the next first paint", () => {
    applyTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("cs2t-theme")).toBe("light");
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("works when storage is blocked", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(() => applyTheme("dark")).not.toThrow();
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    } finally {
      Storage.prototype.setItem = original;
    }
  });

  it("resolves the displayed theme", () => {
    expect(effectiveTheme("system", true)).toBe("dark");
    expect(effectiveTheme("system", false)).toBe("light");
    expect(effectiveTheme("light", true)).toBe("light");
  });

  it("theme-init.js applies the remembered theme before paint", () => {
    localStorage.setItem("cs2t-theme", "dark");
    new Function(fs.readFileSync(path.resolve("web/public/theme-init.js"), "utf8"))();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    document.documentElement.removeAttribute("data-theme");
    localStorage.setItem("cs2t-theme", "garbage");
    new Function(fs.readFileSync(path.resolve("web/public/theme-init.js"), "utf8"))();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});

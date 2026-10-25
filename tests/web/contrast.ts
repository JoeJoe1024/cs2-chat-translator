/** WCAG 2.x contrast helpers + a tiny parser for the light-dark() design tokens. */
import fs from "node:fs";
import path from "node:path";

export type Scheme = "light" | "dark";
export type Rgb = [number, number, number];

export function parseHex(hex: string): Rgb {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const lin = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

export const luminance = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `fg` at `percent`% over `bg` — what `color-mix(in srgb, fg P%, bg)` renders. */
export function mix(fg: Rgb, bg: Rgb, percent: number): Rgb {
  const p = percent / 100;
  return [0, 1, 2].map((i) => Math.round(fg[i]! * p + bg[i]! * (1 - p))) as Rgb;
}

export function loadTokens(): Record<Scheme, Record<string, Rgb>> {
  const css = fs.readFileSync(path.resolve("web/src/styles/tokens.css"), "utf8");
  const out: Record<Scheme, Record<string, Rgb>> = { light: {}, dark: {} };
  for (const m of css.matchAll(/--([a-z0-9-]+):\s*light-dark\(\s*(#[0-9a-f]{6})\s*,\s*(#[0-9a-f]{6})\s*\)\s*;/gi)) {
    out.light[m[1]!] = parseHex(m[2]!);
    out.dark[m[1]!] = parseHex(m[3]!);
  }
  for (const m of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    out.light[m[1]!] = parseHex(m[2]!);
    out.dark[m[1]!] = parseHex(m[2]!);
  }
  return out;
}

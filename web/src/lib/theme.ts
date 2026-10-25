import type { ThemePreference } from "../../../src/config/schema";

const STORAGE_KEY = "cs2t-theme";

/** `system` leaves the attribute off so CSS follows `prefers-color-scheme` live; no JS listener needed. */
export function applyTheme(pref: ThemePreference, root: HTMLElement = document.documentElement): void {
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
  try {
    if (pref === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    /* storage may be unavailable; the server setting still persists the choice */
  }
}

/** The theme actually shown, for labels such as "System (dark)". */
export function effectiveTheme(pref: ThemePreference, systemDark: boolean): "light" | "dark" {
  return pref === "system" ? (systemDark ? "dark" : "light") : pref;
}

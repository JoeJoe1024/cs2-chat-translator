/**
 * Maps browser key events to the key names CS2's `bind` command understands.
 * Browser names are NOT CS2 names (`Numpad1` → `kp_end`, `ArrowUp` → `uparrow`, `Semicolon` → ?), so every
 * supported key is listed explicitly. Anything not listed is reported as unsupported instead of guessed:
 * a wrong name would produce a bind that silently does nothing.
 */

export type KeyGroup = "letter" | "digit" | "function" | "numpad" | "navigation" | "mouse" | "other";

export interface Cs2Key {
  /** Name used in `bind <name> "..."`. */
  bind: string;
  /** Friendly label shown to the user. */
  label: string;
  group: KeyGroup;
}

export type CaptureResult =
  | { status: "ok"; key: Cs2Key; /** The layout produced a different letter than the physical QWERTY position. */ layoutNote?: boolean }
  | { status: "cancel" }
  | { status: "unsupported"; reason: "console" | "modifier" | "punctuation" | "system" | "unknown" };

const NUMPAD: Record<string, [string, string]> = {
  Numpad0: ["kp_ins", "Numpad 0"],
  Numpad1: ["kp_end", "Numpad 1"],
  Numpad2: ["kp_downarrow", "Numpad 2"],
  Numpad3: ["kp_pgdn", "Numpad 3"],
  Numpad4: ["kp_leftarrow", "Numpad 4"],
  Numpad5: ["kp_5", "Numpad 5"],
  Numpad6: ["kp_rightarrow", "Numpad 6"],
  Numpad7: ["kp_home", "Numpad 7"],
  Numpad8: ["kp_uparrow", "Numpad 8"],
  Numpad9: ["kp_pgup", "Numpad 9"],
  NumpadDecimal: ["kp_del", "Numpad ."],
  NumpadDivide: ["kp_slash", "Numpad /"],
  NumpadMultiply: ["kp_multiply", "Numpad *"],
  NumpadSubtract: ["kp_minus", "Numpad -"],
  NumpadAdd: ["kp_plus", "Numpad +"],
  NumpadEnter: ["kp_enter", "Numpad Enter"],
};

const NAVIGATION: Record<string, [string, string]> = {
  ArrowUp: ["uparrow", "↑"],
  ArrowDown: ["downarrow", "↓"],
  ArrowLeft: ["leftarrow", "←"],
  ArrowRight: ["rightarrow", "→"],
  Home: ["home", "Home"],
  End: ["end", "End"],
  PageUp: ["pgup", "Page Up"],
  PageDown: ["pgdn", "Page Down"],
  Insert: ["ins", "Insert"],
  Delete: ["del", "Delete"],
  Space: ["space", "Space"],
  Enter: ["enter", "Enter"],
  Tab: ["tab", "Tab"],
  Backspace: ["backspace", "Backspace"],
  CapsLock: ["capslock", "Caps Lock"],
};

const MODIFIER_CODES = new Set(["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight", "ContextMenu"]);
const CONSOLE_CODES = new Set(["Backquote", "IntlBackslash"]);
const PUNCTUATION_CODES = new Set(["Minus", "Equal", "BracketLeft", "BracketRight", "Semicolon", "Quote", "Comma", "Period", "Slash", "Backslash", "IntlRo", "IntlYen"]);

const MOUSE: Record<string, Cs2Key> = {
  mouse3: { bind: "mouse3", label: "Mouse middle button", group: "mouse" },
  mouse4: { bind: "mouse4", label: "Mouse side button 4 (back)", group: "mouse" },
  mouse5: { bind: "mouse5", label: "Mouse side button 5 (forward)", group: "mouse" },
  mwheelup: { bind: "mwheelup", label: "Mouse wheel up", group: "mouse" },
  mwheeldown: { bind: "mwheeldown", label: "Mouse wheel down", group: "mouse" },
};

/** Translates one `keydown`. `event.key` is used for letters so non-QWERTY layouts match what CS2 calls the key. */
export function captureKeyboard(e: { code: string; key: string }): CaptureResult {
  const { code, key } = e;
  if (code === "Escape") return { status: "cancel" };
  if (CONSOLE_CODES.has(code)) return { status: "unsupported", reason: "console" };
  if (MODIFIER_CODES.has(code)) return { status: "unsupported", reason: "modifier" };
  if (PUNCTUATION_CODES.has(code)) return { status: "unsupported", reason: "punctuation" };

  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  if (letter) {
    const typed = key.length === 1 && /[a-z]/i.test(key) ? key.toLowerCase() : null;
    const bind = typed ?? letter.toLowerCase();
    return { status: "ok", key: { bind, label: bind.toUpperCase(), group: "letter" }, ...(typed && typed !== letter.toLowerCase() ? { layoutNote: true } : {}) };
  }
  const digit = /^Digit([0-9])$/.exec(code)?.[1];
  if (digit) return { status: "ok", key: { bind: digit, label: digit, group: "digit" } };
  const fn = /^F([1-9]|1[0-2])$/.exec(code)?.[1];
  if (fn) return { status: "ok", key: { bind: `f${fn}`, label: `F${fn}`, group: "function" } };
  const pad = NUMPAD[code];
  if (pad) return { status: "ok", key: { bind: pad[0], label: pad[1], group: "numpad" } };
  const nav = NAVIGATION[code];
  if (nav) return { status: "ok", key: { bind: nav[0], label: nav[1], group: "navigation" } };

  if (/^(F\d+|Print|Pause|Scroll|NumLock|Media|Audio|Browser|Launch|Lang|Convert|NonConvert|KanaMode|Fn|Power|Sleep|WakeUp|Eject)/.test(code)) {
    return { status: "unsupported", reason: "system" };
  }
  return { status: "unsupported", reason: "unknown" };
}

/** Mouse buttons use `MouseEvent.button`: 1 = middle, 3 = back, 4 = forward. Left / right are never offered. */
export function captureMouseButton(button: number): CaptureResult {
  const bind = button === 1 ? "mouse3" : button === 3 ? "mouse4" : button === 4 ? "mouse5" : null;
  return bind ? { status: "ok", key: MOUSE[bind]! } : { status: "unsupported", reason: "unknown" };
}

export function captureWheel(deltaY: number): CaptureResult {
  if (deltaY === 0) return { status: "unsupported", reason: "unknown" };
  return { status: "ok", key: MOUSE[deltaY < 0 ? "mwheelup" : "mwheeldown"]! };
}

/** Every key the capture can produce, for the "pick from a list" fallback. */
export function allBindableKeys(): Cs2Key[] {
  const keys: Cs2Key[] = [];
  for (const c of "abcdefghijklmnopqrstuvwxyz") keys.push({ bind: c, label: c.toUpperCase(), group: "letter" });
  for (let d = 0; d <= 9; d++) keys.push({ bind: String(d), label: String(d), group: "digit" });
  for (let f = 1; f <= 12; f++) keys.push({ bind: `f${f}`, label: `F${f}`, group: "function" });
  for (const [bind, label] of Object.values(NUMPAD)) keys.push({ bind, label, group: "numpad" });
  for (const [bind, label] of Object.values(NAVIGATION)) keys.push({ bind, label, group: "navigation" });
  keys.push(...Object.values(MOUSE));
  return keys;
}

const BY_BIND = new Map(allBindableKeys().map((k) => [k.bind, k]));

/** Friendly info for a bind name, or null when it is not one we can verify (e.g. typed by hand in an old setting). */
export function describeBind(bind: string): Cs2Key | null {
  return BY_BIND.get(bind.toLowerCase()) ?? null;
}

/**
 * Keys that CS2 commonly uses by default. Shown as a warning when the user picks one; the real bindings depend on
 * their own config, so this is advice, not a guarantee. Values are ids resolved by the UI's translations.
 */
export const COMMON_DEFAULT_USES: Readonly<Record<string, string>> = {
  w: "move", a: "move", s: "move", d: "move",
  space: "jump", e: "use", r: "reload", f: "inspect", g: "drop", q: "lastweapon", b: "buy", tab: "scoreboard",
  y: "chat", u: "teamchat", m: "teammenu", z: "radio", x: "radio", c: "radio", v: "voice",
  "1": "weapon", "2": "weapon", "3": "weapon", "4": "weapon", "5": "weapon",
  mouse3: "unbound-mouse", mwheelup: "weapon", mwheeldown: "weapon",
};

export function defaultUseOf(bind: string): string | null {
  const use = COMMON_DEFAULT_USES[bind.toLowerCase()];
  return use && use !== "unbound-mouse" ? use : null;
}

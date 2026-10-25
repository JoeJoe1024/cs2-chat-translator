import { describe, expect, it } from "vitest";
import {
  allBindableKeys,
  captureKeyboard,
  captureMouseButton,
  captureWheel,
  defaultUseOf,
  describeBind,
} from "../../src/shared/cs2keys";

const ok = (code: string, key = "") => {
  const r = captureKeyboard({ code, key });
  if (r.status !== "ok") throw new Error(`${code} → ${r.status}`);
  return r;
};

describe("CS2 key capture", () => {
  it("maps every numeric-keypad key to its CS2 name, independent of Num Lock", () => {
    const expected: Record<string, string> = {
      Numpad0: "kp_ins", Numpad1: "kp_end", Numpad2: "kp_downarrow", Numpad3: "kp_pgdn", Numpad4: "kp_leftarrow",
      Numpad5: "kp_5", Numpad6: "kp_rightarrow", Numpad7: "kp_home", Numpad8: "kp_uparrow", Numpad9: "kp_pgup",
      NumpadDecimal: "kp_del", NumpadDivide: "kp_slash", NumpadMultiply: "kp_multiply", NumpadSubtract: "kp_minus",
      NumpadAdd: "kp_plus", NumpadEnter: "kp_enter",
    };
    for (const [code, bind] of Object.entries(expected)) {
      // With Num Lock off the browser reports key "End", "ArrowDown"… but the physical key (code) is what matters.
      for (const key of ["1", "End", "ArrowDown", "Unidentified"]) {
        expect(ok(code, key).key.bind, `${code}/${key}`).toBe(bind);
      }
      expect(ok(code).key.group).toBe("numpad");
    }
  });

  it("keeps the numeric keypad separate from the main keyboard", () => {
    expect(ok("Digit1", "1").key.bind).toBe("1");
    expect(ok("Numpad1", "1").key.bind).toBe("kp_end");
    expect(captureKeyboard({ code: "NumpadAdd", key: "+" })).toMatchObject({ status: "ok", key: { bind: "kp_plus" } });
    expect(captureKeyboard({ code: "Equal", key: "+" }).status).toBe("unsupported");
  });

  it("supports letters, digits, F1–F12, arrows and navigation keys", () => {
    expect(ok("KeyL", "l").key).toMatchObject({ bind: "l", label: "L", group: "letter" });
    expect(ok("Digit7", "7").key.bind).toBe("7");
    for (let i = 1; i <= 12; i++) expect(ok(`F${i}`, `F${i}`).key.bind).toBe(`f${i}`);
    const nav: Record<string, string> = {
      ArrowUp: "uparrow", ArrowDown: "downarrow", ArrowLeft: "leftarrow", ArrowRight: "rightarrow", Home: "home", End: "end",
      PageUp: "pgup", PageDown: "pgdn", Insert: "ins", Delete: "del", Space: "space", Enter: "enter", Tab: "tab", Backspace: "backspace", CapsLock: "capslock",
    };
    for (const [code, bind] of Object.entries(nav)) expect(ok(code).key.bind, code).toBe(bind);
  });

  it("uses the letter the layout produces, and flags it when it differs from the QWERTY position", () => {
    // AZERTY: the physical Q position types "a"
    const r = ok("KeyQ", "a");
    expect(r.key.bind).toBe("a");
    expect(r.layoutNote).toBe(true);
    expect(ok("KeyQ", "q").layoutNote).toBeUndefined();
    // Shift / Caps Lock produce capitals
    expect(ok("KeyK", "K").key.bind).toBe("k");
    // Non-Latin layout (Russian): fall back to the physical letter instead of inventing a name
    expect(ok("KeyF", "а").key.bind).toBe("f");
  });

  it("cancels on Escape", () => {
    expect(captureKeyboard({ code: "Escape", key: "Escape" })).toEqual({ status: "cancel" });
  });

  it("refuses keys it cannot name reliably instead of producing a wrong bind", () => {
    const reason = (code: string) => {
      const r = captureKeyboard({ code, key: "" });
      return r.status === "unsupported" ? r.reason : r.status;
    };
    expect(reason("Backquote")).toBe("console");
    for (const c of ["ShiftLeft", "ShiftRight", "ControlLeft", "AltRight", "MetaLeft", "ContextMenu"]) expect(reason(c)).toBe("modifier");
    for (const c of ["Minus", "Equal", "BracketLeft", "Semicolon", "Quote", "Comma", "Period", "Slash", "Backslash"]) expect(reason(c)).toBe("punctuation");
    for (const c of ["PrintScreen", "Pause", "ScrollLock", "NumLock", "F13", "F24", "MediaPlayPause", "AudioVolumeUp", "BrowserBack"]) expect(reason(c)).toBe("system");
    expect(reason("SomethingNew")).toBe("unknown");
  });

  it("recognises the middle and side mouse buttons and the wheel, never left / right", () => {
    expect(captureMouseButton(1)).toMatchObject({ status: "ok", key: { bind: "mouse3" } });
    expect(captureMouseButton(3)).toMatchObject({ status: "ok", key: { bind: "mouse4" } });
    expect(captureMouseButton(4)).toMatchObject({ status: "ok", key: { bind: "mouse5" } });
    expect(captureMouseButton(0).status).toBe("unsupported");
    expect(captureMouseButton(2).status).toBe("unsupported");
    expect(captureWheel(-120)).toMatchObject({ status: "ok", key: { bind: "mwheelup" } });
    expect(captureWheel(120)).toMatchObject({ status: "ok", key: { bind: "mwheeldown" } });
    expect(captureWheel(0).status).toBe("unsupported");
  });

  it("offers a duplicate-free key list where every entry round-trips and is safe to put in a bind", () => {
    const keys = allBindableKeys();
    const binds = keys.map((k) => k.bind);
    expect(new Set(binds).size).toBe(binds.length);
    for (const k of keys) {
      expect(k.bind).toMatch(/^[a-z0-9_]{1,24}$/);
      expect(describeBind(k.bind)).toEqual(k);
    }
    expect(binds).toEqual(expect.arrayContaining(["kp_plus", "f8", "mouse4", "uparrow", "a", "9", "space"]));
    expect(describeBind("KP_PLUS")?.label).toBe("Numpad +");
    expect(describeBind("totally_custom")).toBeNull();
  });

  it("knows which keys CS2 commonly uses so it can warn", () => {
    expect(defaultUseOf("w")).toBe("move");
    expect(defaultUseOf("E")).toBe("use");
    expect(defaultUseOf("kp_plus")).toBeNull();
    expect(defaultUseOf("f8")).toBeNull();
    expect(defaultUseOf("mouse3")).toBeNull();
  });
});

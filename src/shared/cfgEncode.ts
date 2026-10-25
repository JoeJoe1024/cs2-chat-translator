/** Pure text encoding for cfg `say` lines. Shared by the server (writing) and the settings page (preview). */
/** Safe default; verify in game. Source chat is limited by bytes, so we split instead of silently cutting. */
export const CHAT_LINE_MAX_BYTES = 120;
export const MAX_CHAT_LINES = 3;

export interface EncodedMessage {
  lines: string[];
  truncated: boolean;
}

const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).length;

/**
 * Makes arbitrary text safe to place inside a cfg `say "..."` string.
 *  - Source's console has no usable escape for `"`, so quotes become typographic quotes;
 *  - `;` would end the command, `//` starts a comment even inside quotes, `\` and control
 *    characters (including CR/LF, which would start a NEW command line) are neutralised.
 * The output can therefore never contain a second command, however hostile the input.
 */
const cp = (...codes: number[]) => String.fromCharCode(...codes);
/** C0/C1 controls (CR, LF, TAB…), line/paragraph separators, zero-width and bidi-override characters. */
const UNSAFE_CHARS = new RegExp(
  `[${cp(0)}-${cp(0x1f)}${cp(0x7f)}-${cp(0x9f)}${cp(0x2028)}-${cp(0x2029)}${cp(0x200b)}-${cp(0x200f)}${cp(0x202a)}-${cp(0x202e)}${cp(0x2066)}-${cp(0x2069)}${cp(0xfeff)}]+`,
  "g",
);
const RIGHT_DOUBLE_QUOTE = cp(0x201d);
const FULLWIDTH_SEMICOLON = cp(0xff1b);

export function sanitizeForCfg(input: string): string {
  return input
    .normalize("NFC")
    .replace(UNSAFE_CHARS, " ")
    .replace(/"/g, RIGHT_DOUBLE_QUOTE)
    .replace(/;/g, FULLWIDTH_SEMICOLON)
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, (m) => m.split("").join(" "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Splits text at word/character boundaries so every chunk is at most `maxBytes` UTF-8 bytes. */
export function splitByBytes(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = "";
  const push = () => {
    const t = current.trim();
    if (t) chunks.push(t);
    current = "";
  };
  for (const word of text.split(" ")) {
    const candidate = current ? `${current} ${word}` : word;
    if (byteLength(candidate) <= maxBytes) {
      current = candidate;
      continue;
    }
    push();
    if (byteLength(word) <= maxBytes) {
      current = word;
      continue;
    }
    // A single token longer than a line (CJK without spaces): cut by code point.
    for (const ch of word) {
      if (byteLength(current + ch) > maxBytes) push();
      current += ch;
    }
  }
  push();
  return chunks;
}

export function encodeMessage(text: string, maxBytes = CHAT_LINE_MAX_BYTES, maxLines = MAX_CHAT_LINES): EncodedMessage {
  const clean = sanitizeForCfg(text);
  if (!clean) return { lines: [], truncated: false };
  const all = splitByBytes(clean, maxBytes);
  return { lines: all.slice(0, maxLines), truncated: all.length > maxLines };
}


/** The console command that makes `key` run the prepared cfg. Both parts are quoted, as CS2 itself writes binds. */
export function bindCommand(key: string, fileName: string): string {
  return `bind "${key}" "exec ${fileName}"`;
}

export function unbindCommand(key: string): string {
  return `unbind "${key}"`;
}

/** Runs the prepared cfg once by hand (a no-op when nothing is prepared). */
export function execCommand(fileName: string): string {
  return `exec ${fileName}`;
}

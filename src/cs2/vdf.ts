export type VdfValue = string | VdfObject;
export interface VdfObject {
  [key: string]: VdfValue;
}

/** Minimal Valve KeyValues (text VDF) parser: quoted keys/values, nested braces, `//` comments. */
export function parseVdf(text: string): VdfObject {
  let i = 0;

  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i]!)) i++;
      if (text.startsWith("//", i)) {
        while (i < text.length && text[i] !== "\n") i++;
      } else break;
    }
  };

  const readToken = (): string | null => {
    skip();
    if (i >= text.length) return null;
    const c = text[i]!;
    if (c === "{" || c === "}") return null;
    if (c === '"') {
      i++;
      let out = "";
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length) {
          const n = text[i + 1]!;
          out += n === "n" ? "\n" : n === "t" ? "\t" : n;
          i += 2;
        } else out += text[i++];
      }
      i++;
      return out;
    }
    const start = i;
    while (i < text.length && !/[\s{}"]/.test(text[i]!)) i++;
    return text.slice(start, i);
  };

  const readObject = (): VdfObject => {
    const obj: VdfObject = {};
    for (;;) {
      skip();
      if (i >= text.length) return obj;
      if (text[i] === "}") {
        i++;
        return obj;
      }
      const key = readToken();
      if (key === null) {
        i++;
        continue;
      }
      skip();
      if (text[i] === "{") {
        i++;
        obj[key] = readObject();
      } else {
        const value = readToken();
        if (value !== null) obj[key] = value;
      }
    }
  };

  return readObject();
}

/** Case-insensitive nested lookup. */
export function vdfGet(obj: VdfValue | undefined, ...keys: string[]): VdfValue | undefined {
  let cur: VdfValue | undefined = obj;
  for (const key of keys) {
    if (cur === undefined || typeof cur === "string") return undefined;
    const found: string | undefined = Object.keys(cur).find((k) => k.toLowerCase() === key.toLowerCase());
    cur = found === undefined ? undefined : cur[found];
  }
  return cur;
}

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHAT_LINE_MAX_BYTES,
  CfgError,
  bindCommand,
  encodeMessage,
  renderCfg,
  sanitizeForCfg,
  splitByBytes,
  writeChatCfg,
} from "../../src/cs2/cfgWriter";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "cs2t-cfg-"));

/** The invariant that matters: the file can only ever contain comment lines and say/say_team lines. */
function assertSafeCfg(content: string): void {
  const lines = content.split(/\r\n|\n|\r/);
  for (const line of lines) {
    if (line === "") continue;
    if (line.startsWith("// ")) continue;
    expect(line, `unsafe cfg line: ${JSON.stringify(line)}`).toMatch(/^say(_team)? "[^"\\;]*"$/);
    const payload = line.slice(line.indexOf('"') + 1, -1);
    expect(payload).not.toContain("//");
    // eslint-disable-next-line no-control-regex
    expect(payload).not.toMatch(/[\u0000-\u001f]/);
  }
}

describe("cfg sanitising", () => {
  const hostile = [
    'hi"; quit; say "pwned',
    "line1\nquit",
    "line1\r\nexec evil.cfg",
    "a\u2028quit\u2029b",
    "http://example.com/path",
    "back\\slash\\\\",
    '";bind w "+back"',
    "a\0b\x07c\x1bd",
    "\u202egnp.exe",
    "say \"x\" ; disconnect",
    "// comment injection",
    "wait; wait; wait",
  ];

  it.each(hostile)("neutralises %j", (input) => {
    const { lines } = encodeMessage(input);
    assertSafeCfg(renderCfg(lines, "all"));
    assertSafeCfg(renderCfg(lines, "team"));
  });

  it("survives 3000 random hostile strings", () => {
    const alphabet = ['"', ";", "\n", "\r", "/", "\\", " ", "a", "é", "你", "😀", "\u2028", "\0", "$", "%", "{", "}"];
    let seed = 1234567;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 3000; i++) {
      const len = Math.floor(rnd() * 60);
      let s = "";
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      assertSafeCfg(renderCfg(encodeMessage(s).lines, i % 2 ? "all" : "team"));
    }
  });

  it("keeps ordinary text, CJK and emoji intact", () => {
    expect(sanitizeForCfg("Rush B 現在 😀 gg")).toBe("Rush B 現在 😀 gg");
  });

  it("returns no lines for empty / whitespace-only input", () => {
    expect(encodeMessage("   \n\t ").lines).toEqual([]);
  });
});

describe("byte-length splitting", () => {
  it("never exceeds the byte limit, for ASCII and CJK", () => {
    for (const text of ["word ".repeat(80).trim(), "你好".repeat(80), "a".repeat(500), "😀".repeat(60)]) {
      for (const chunk of splitByBytes(text, CHAT_LINE_MAX_BYTES)) {
        expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(CHAT_LINE_MAX_BYTES);
      }
    }
  });

  it("flags truncation when the message needs more than the allowed lines", () => {
    const r = encodeMessage("word ".repeat(200));
    expect(r.lines.length).toBe(3);
    expect(r.truncated).toBe(true);
  });

  it("does not split short messages", () => {
    expect(encodeMessage("good luck")).toEqual({ lines: ["good luck"], truncated: false });
  });
});

describe("writeChatCfg", () => {
  it("writes say / say_team files atomically", async () => {
    const dir = await tmp();
    const r = await writeChatCfg({ cfgDir: dir, fileName: "chat_reader.cfg", text: "Hello team", channel: "team" });
    const content = await fs.readFile(r.file, "utf8");
    expect(content).toContain('say_team "Hello team"');
    assertSafeCfg(content);
    const left = (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"));
    expect(left).toEqual([]);
  });

  it("overwrites the previous message", async () => {
    const dir = await tmp();
    await writeChatCfg({ cfgDir: dir, fileName: "a.cfg", text: "first", channel: "all" });
    const r = await writeChatCfg({ cfgDir: dir, fileName: "a.cfg", text: "second", channel: "all" });
    expect(await fs.readFile(r.file, "utf8")).not.toContain("first");
  });

  it("rejects path traversal in the file name", async () => {
    const dir = await tmp();
    await expect(writeChatCfg({ cfgDir: dir, fileName: "../evil.cfg", text: "x", channel: "all" })).rejects.toMatchObject({ code: "bad-file-name" });
  });

  it("reports a missing cfg directory and empty messages", async () => {
    await expect(writeChatCfg({ cfgDir: path.join(os.tmpdir(), "does-not-exist-cs2t"), fileName: "a.cfg", text: "x", channel: "all" })).rejects.toBeInstanceOf(CfgError);
    const dir = await tmp();
    await expect(writeChatCfg({ cfgDir: dir, fileName: "a.cfg", text: " ", channel: "all" })).rejects.toMatchObject({ code: "empty-message" });
  });

  it("builds the bind command", () => {
    expect(bindCommand("kp_plus", "chat_reader.cfg")).toBe('bind "kp_plus" "exec chat_reader.cfg"');
  });
});

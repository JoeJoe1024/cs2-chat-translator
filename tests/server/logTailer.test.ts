import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LogTailer } from "../../src/cs2/logTailer";
import type { WatcherStatus } from "../../src/shared/protocol";

const tailers: LogTailer[] = [];
afterEach(() => tailers.splice(0).forEach((t) => t.stop()));

async function setup(initial?: string | Buffer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs2t-tail-"));
  const file = path.join(dir, "console.log");
  if (initial !== undefined) await fs.writeFile(file, initial);
  const tailer = new LogTailer(10);
  tailers.push(tailer);
  const lines: string[] = [];
  const statuses: WatcherStatus[] = [];
  let resets = 0;
  tailer.on("line", (l) => lines.push(l));
  tailer.on("status", (s) => statuses.push(s));
  tailer.on("reset", () => resets++);
  return { file, tailer, lines, statuses, resets: () => resets };
}

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("LogTailer", () => {
  it("starts at the end of the file and never replays history", async () => {
    const t = await setup("old line 1\nold line 2\n");
    t.tailer.start(t.file);
    await until(() => t.statuses.some((s) => s.state === "watching"));
    await fs.appendFile(t.file, "new line\n");
    await until(() => t.lines.length === 1);
    expect(t.lines).toEqual(["new line"]);
  });

  it("only emits complete lines and handles CRLF", async () => {
    const t = await setup("");
    t.tailer.start(t.file);
    await until(() => t.statuses.length > 0);
    await fs.appendFile(t.file, "half a li");
    await new Promise((r) => setTimeout(r, 60));
    expect(t.lines).toEqual([]);
    await fs.appendFile(t.file, "ne\r\nsecond\r\n");
    await until(() => t.lines.length === 2);
    expect(t.lines).toEqual(["half a line", "second"]);
  });

  it("does not corrupt multi-byte characters split across reads", async () => {
    const t = await setup("");
    t.tailer.start(t.file);
    await until(() => t.statuses.length > 0);
    const bytes = Buffer.from("[ALL] 玩家: 你好😀\n", "utf8");
    const cut = bytes.indexOf(0xe4) + 1; // inside the first CJK char
    await fs.appendFile(t.file, bytes.subarray(0, cut));
    await new Promise((r) => setTimeout(r, 60));
    await fs.appendFile(t.file, bytes.subarray(cut, bytes.length - 3));
    await new Promise((r) => setTimeout(r, 60));
    await fs.appendFile(t.file, bytes.subarray(bytes.length - 3));
    await until(() => t.lines.length === 1);
    expect(t.lines[0]).toBe("[ALL] 玩家: 你好😀");
  });

  it("recovers when the file is truncated (game restart)", async () => {
    const t = await setup("");
    t.tailer.start(t.file);
    await until(() => t.statuses.length > 0);
    await fs.appendFile(t.file, "before restart line that is long enough\n");
    await until(() => t.lines.length === 1);
    await fs.writeFile(t.file, "after\n");
    await until(() => t.lines.includes("after"));
    expect(t.resets()).toBeGreaterThan(0);
  });

  it("waits for a missing file, reports why, and reads it once it appears", async () => {
    const t = await setup();
    t.tailer.start(t.file);
    await until(() => t.statuses.some((s) => s.state === "waiting" && s.reason === "log-missing"));
    await fs.writeFile(t.file, "first\nsecond\n");
    await until(() => t.lines.length === 2);
    expect(t.lines).toEqual(["first", "second"]);
    expect(t.statuses.at(-1)?.state).toBe("watching");
  });

  it("handles delete + re-create", async () => {
    const t = await setup("x\n");
    t.tailer.start(t.file);
    await until(() => t.statuses.some((s) => s.state === "watching"));
    await fs.rm(t.file);
    await until(() => t.statuses.some((s) => s.state === "waiting"));
    await fs.writeFile(t.file, "reborn\n");
    await until(() => t.lines.includes("reborn"));
  });

  it("reports idle with no path", async () => {
    const t = await setup();
    t.tailer.start("");
    expect(t.statuses[0]).toMatchObject({ state: "idle", reason: "no-path" });
  });

  it("copes with a burst of many lines", async () => {
    const t = await setup("");
    t.tailer.start(t.file);
    await until(() => t.statuses.length > 0);
    const burst = Array.from({ length: 5000 }, (_, i) => `[ALL] p${i}: msg ${i}`).join("\n") + "\n";
    await fs.appendFile(t.file, burst);
    await until(() => t.lines.length === 5000, 8000);
    expect(t.lines[4999]).toBe("[ALL] p4999: msg 4999");
  });
});

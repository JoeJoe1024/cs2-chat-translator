import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLock, findRunning, findRunningWithHealth, isProcessAlive, probeHealth, readInstance, writeInstance } from "../../src/launcher/instance";
import { bootWeb, until } from "../fixtures/harness";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "cs2t-launch-"));

describe("instance bookkeeping", () => {
  it("detects live and dead processes", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2_000_000_000)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });

  it("ignores missing, corrupt and stale instance files", async () => {
    const dir = await tmp();
    expect(await findRunning(dir)).toBeNull();
    await fs.writeFile(path.join(dir, "instance.json"), "{nope");
    expect(await readInstance(dir)).toBeNull();
    await writeInstance(dir, { pid: 2_000_000_000, port: 9527, version: "x", startedAt: 1 });
    expect(await findRunning(dir)).toBeNull();
  });

  it("does not accept a port whose answer carries a different instance id", async () => {
    const web = await bootWeb();
    try {
      const dir = await tmp();
      // the recorded instance id is not what this server reports (a different run, or an imitation)
      await writeInstance(dir, { pid: process.pid, port: web.server.port, version: "t", startedAt: 1, instanceId: "recorded-id" });
      expect(await findRunning(dir)).toBeNull();
    } finally {
      await web.stop();
    }
  });

  it("recognises our own service by its health payload, not just an open port", async () => {
    const web = await bootWeb();
    try {
      const dir = await tmp();
      expect(await probeHealth(web.server.port)).toBe(true);
      await writeInstance(dir, { pid: process.pid, port: web.server.port, version: "t", startedAt: 1 });
      expect((await findRunning(dir))?.port).toBe(web.server.port);

      // Some other program listening on a port must not be mistaken for the app.
      const other = net.createServer((s) => s.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nhi"));
      await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
      const otherPort = (other.address() as net.AddressInfo).port;
      expect(await probeHealth(otherPort)).toBe(false);
      await writeInstance(dir, { pid: process.pid, port: otherPort, version: "t", startedAt: 1 });
      expect(await findRunning(dir)).toBeNull();
      other.close();
    } finally {
      await web.stop();
    }
  });

  it("serialises concurrent starters with a lock and recovers from stale locks", async () => {
    const dir = await tmp();
    const release = await acquireLock(dir);
    expect(release).not.toBeNull();
    // Holder is this (live) process but a second attempt from "another launcher" must be refused:
    await fs.writeFile(path.join(dir, "launcher.lock"), String(process.ppid));
    expect(await acquireLock(dir)).toBeNull();
    await fs.writeFile(path.join(dir, "launcher.lock"), "2000000000");
    const again = await acquireLock(dir);
    expect(again).not.toBeNull();
    await again!();
    expect(existsSync(path.join(dir, "launcher.lock"))).toBe(false);
  });
});

// End-to-end through the real bundled launcher (what start.bat runs). Needs `npm run build`.
const BUILT = existsSync(path.resolve("dist/launcher.mjs")) && existsSync(path.resolve("dist/server.mjs"));

describe.skipIf(!BUILT)("bundled launcher", () => {
  const children: ChildProcess[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const c of children.splice(0)) c.kill();
    // The launcher's server is a separate process. Never kill on the recorded pid alone: the pid is only used when the
    // port still answers as this app with the very instance id that was recorded (so a reused pid is never touched),
    // and only for config dirs this test created.
    for (const d of dirs.splice(0)) {
      const found = await findRunningWithHealth(d);
      if (found?.info.instanceId && found.health.instanceId === found.info.instanceId) {
        try {
          process.kill(found.info.pid);
        } catch {
          /* already gone */
        }
      }
    }
  });

  async function launch(configDir: string, port: number) {
    dirs.push(configDir);
    const child = spawn(process.execPath, [path.resolve("dist/launcher.mjs")], {
      env: { ...process.env, CS2T_CONFIG_DIR: configDir, CS2T_NO_BROWSER: "1", CS2T_PORT: String(port), CS2T_SKIP_STALE_CHECK: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let out = "";
    child.stdout!.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr!.on("data", (d: Buffer) => (out += d.toString("utf8")));
    const exited = new Promise<number | null>((r) => child.on("exit", r));
    return { child, output: () => out, exited };
  }

  const freePort = async () => {
    const s = net.createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const p = (s.address() as net.AddressInfo).port;
    await new Promise((r) => s.close(r));
    return p;
  };

  it("starts one service, and a second launch reuses it instead of starting another", async () => {
    const dir = await tmp();
    const port = await freePort();
    const first = await launch(dir, port);
    await until(async () => (await findRunning(dir)) !== null, 20000);
    const info = (await readInstance(dir))!;
    expect(info.port).toBe(port);
    await until(() => first.output().includes(`http://127.0.0.1:${port}/`), 10000); // the launcher prints just after the service is up

    const second = await launch(dir, port);
    expect(await second.exited).toBe(0);
    expect(second.output()).toContain("已經在執行");
    expect((await readInstance(dir))?.pid).toBe(info.pid);
  }, 40000);

  /** Starts a launcher + server on a fresh config dir and returns what the tests need. */
  async function running(opts: { withCfgDir?: boolean } = {}) {
    const dir = await tmp();
    if (opts.withCfgDir) {
      const cfg = path.join(dir, "cfg");
      await fs.mkdir(cfg);
      await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify({ cs2: { pathMode: "manual", cfgDir: cfg, logPath: path.join(dir, "console.log") } }));
    }
    const port = await freePort();
    const first = await launch(dir, port);
    await until(async () => (await findRunning(dir)) !== null, 20000);
    await until(() => first.output().includes(`http://127.0.0.1:${port}/`), 10000);
    return { dir, port, first, info: (await readInstance(dir))! };
  }

  it("an older build with nothing waiting to be sent is replaced safely", async () => {
    const { dir, port, info: old } = await running();
    expect(old.instanceId).toBeTruthy();
    await writeInstance(dir, { ...old, buildId: "an-older-build" }); // as if dist/ was rebuilt after it started

    const second = await launch(dir, port);
    await until(() => second.output().includes("http://127.0.0.1") && second.output().includes("已啟動"), 30000);
    expect(second.output()).toContain("安全地換成新版本");
    const now = (await readInstance(dir))!;
    expect(now.pid).not.toBe(old.pid);
    expect(now.instanceId).not.toBe(old.instanceId);
    expect(isProcessAlive(old.pid)).toBe(false);
    expect(await findRunning(dir)).not.toBeNull();
  }, 60000);

  it("an older build with a prepared message is never closed: the existing one is opened instead", async () => {
    const { dir, port, info: old } = await running({ withCfgDir: true });
    const page = await (await fetch(`http://127.0.0.1:${old.port}/`)).text();
    const token = /name="cs2t-token" content="([^"]+)"/.exec(page)![1]!;
    const prep = await fetch(`http://127.0.0.1:${old.port}/api/cfg`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cs2t-token": token },
      body: JSON.stringify({ message: "still waiting", channel: "all", mode: "direct", clickedAt: Date.now() }),
    });
    expect(prep.status).toBe(200);
    expect(((await (await fetch(`http://127.0.0.1:${old.port}/health`)).json()) as { hasPrepared: boolean }).hasPrepared).toBe(true);
    await writeInstance(dir, { ...old, buildId: "an-older-build" });

    const second = await launch(dir, port);
    expect(await second.exited).toBe(0);
    expect(second.output()).toContain("沒有關閉它");
    expect((await readInstance(dir))?.pid).toBe(old.pid);
    expect(isProcessAlive(old.pid)).toBe(true);
    expect(await fs.readFile(path.join(dir, "cfg", "chat_reader.cfg"), "utf8")).toContain("still waiting"); // not touched
  }, 60000);

  it("starting the server file directly while one is running does not create a second service", async () => {
    const { dir, info } = await running();
    const second = spawn(process.execPath, [path.resolve("dist/server.mjs"), "--port", String(info.port + 1)], {
      env: { ...process.env, CS2T_CONFIG_DIR: dir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    second.stdout!.on("data", (d: Buffer) => (out += d.toString("utf8")));
    const code = await new Promise<number | null>((r) => second.on("exit", r));
    expect(code).toBe(0);
    expect(out).toContain("already running");
    expect((await readInstance(dir))?.pid).toBe(info.pid);
  }, 40000);

  it("two simultaneous double-clicks still produce a single service", async () => {
    const dir = await tmp();
    const port = await freePort();
    const [a, b] = await Promise.all([launch(dir, port), launch(dir, port)]);
    await until(async () => (await findRunning(dir)) !== null, 20000);
    await until(() => a.output().includes("http://") && b.output().includes("http://"), 20000);
    const started = [a, b].filter((l) => l.output().includes("正在啟動"));
    expect(started.length).toBe(1);
    expect((await readInstance(dir))?.port).toBe(port);
  }, 40000);

  it("moves to the next port when the default one is taken by another program", async () => {
    const dir = await tmp();
    const port = await freePort();
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(port, "127.0.0.1", r));
    try {
      await launch(dir, port);
      await until(async () => (await findRunning(dir)) !== null, 20000);
      expect((await readInstance(dir))?.port).toBe(port + 1);
    } finally {
      blocker.close();
    }
  }, 40000);

  it("explains the problem when the whole port range is busy", async () => {
    const dir = await tmp();
    const base = await freePort();
    const blockers: net.Server[] = [];
    try {
      for (let p = base; p <= base + 10; p++) {
        const s = net.createServer();
        await new Promise<void>((resolve, reject) => {
          s.once("error", reject);
          s.listen(p, "127.0.0.1", resolve);
        });
        blockers.push(s);
      }
    } catch {
      // A port in the range is held by something else on this machine: that still counts as busy.
    }
    const l = await launch(dir, base);
    expect(await l.exited).toBe(3);
    expect(l.output()).toContain("全部被其他程式占用");
    blockers.forEach((b) => b.close());
  }, 40000);
});

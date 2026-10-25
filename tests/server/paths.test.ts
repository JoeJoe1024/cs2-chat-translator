import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemorySecretStore } from "../../src/config/secrets";
import { findCs2Installs, type Cs2Install } from "../../src/cs2/steam";
import { LogTailer } from "../../src/cs2/logTailer";
import { App } from "../../src/server/app";
import { until } from "../fixtures/harness";

const tmp = (prefix = "cs2t-paths-") => fs.mkdtemp(path.join(os.tmpdir(), prefix));
const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

async function makeInstall(root: string, ageMs: number | null): Promise<Cs2Install> {
  const gameDir = path.join(root, "steamapps", "common", "Counter-Strike Global Offensive", "game", "csgo");
  await fs.mkdir(path.join(gameDir, "cfg"), { recursive: true });
  const logPath = path.join(gameDir, "console.log");
  if (ageMs !== null) {
    await fs.writeFile(logPath, "x\n");
    const t = new Date(Date.now() - ageMs);
    await fs.utimes(logPath, t, t);
  }
  return { steamRoot: root, library: root, gameDir, logPath, cfgDir: path.join(gameDir, "cfg"), vpkDir: gameDir };
}

async function boot(installs: Cs2Install[], configDir?: string) {
  const dir = configDir ?? (await tmp("cs2t-paths-cfg-"));
  const app = new App({ configDir: dir, secrets: new MemorySecretStore(), tailer: new LogTailer(15), installs, personaNames: [] });
  apps.push(app);
  await app.init();
  return { app, dir };
}

describe("automatic CS2 location", () => {
  it("uses the only install it finds and reports clear status", async () => {
    const a = await makeInstall(await tmp(), 1000);
    const { app } = await boot([a]);
    const p = (await app.getState()).paths;
    expect(p).toMatchObject({ mode: "auto", logPath: a.logPath, cfgDir: a.cfgDir, logExists: true, cfgDirExists: true, cfgDirWritable: true, needsChoice: false, logNameUnusual: false });
    expect(p.candidates).toHaveLength(1);
    expect(p.candidates[0]).toMatchObject({ selected: true, logExists: true });
  });

  it("reports a missing console.log without failing", async () => {
    const a = await makeInstall(await tmp(), null);
    const { app } = await boot([a]);
    const state = await app.getState();
    expect(state.paths.logExists).toBe(false);
    expect(state.paths.candidates[0]).toMatchObject({ logExists: false, logModifiedAt: null });
    expect(state.watcher.reason === "log-missing" || state.watcher.state === "idle" || state.watcher.state === "waiting").toBe(true);
  });

  it("with no install at all, says so and stays usable for manual setup", async () => {
    const { app } = await boot([]);
    const p = (await app.getState()).paths;
    expect(p).toMatchObject({ mode: "auto", logPath: "", cfgDir: "", candidates: [], needsChoice: false, canBrowse: process.platform === "win32" });
  });

  it("does not silently pick one of several installs: it flags it, and an explicit choice wins", async () => {
    const older = await makeInstall(await tmp(), 5 * 60_000);
    const newer = await makeInstall(await tmp(), 1_000);
    const { app } = await boot([older, newer]);
    let p = (await app.getState()).paths;
    expect(p.needsChoice).toBe(true);
    expect(p.candidates).toHaveLength(2);
    expect(p.logPath).toBe(newer.logPath); // provisional: newest console.log, never "first in the list"
    expect(p.candidates.find((c) => c.selected)?.gameDir).toBe(newer.gameDir);

    await app.updateSettings({ cs2: { installDir: older.gameDir } });
    p = (await app.getState()).paths;
    expect(p).toMatchObject({ needsChoice: false, logPath: older.logPath, cfgDir: older.cfgDir });
    expect(p.candidates.find((c) => c.selected)?.gameDir).toBe(older.gameDir);
  });

  it("ignores a stale installDir that no longer exists", async () => {
    const only = await makeInstall(await tmp(), 100);
    const { app } = await boot([only]);
    await app.updateSettings({ cs2: { installDir: path.join(os.tmpdir(), "gone", "csgo") } });
    expect((await app.getState()).paths.logPath).toBe(only.logPath);
  });
});

describe("manual CS2 location", () => {
  it("is never overridden by detection, redetection or restarts, even when the path stops existing", async () => {
    const auto = await makeInstall(await tmp(), 100);
    const manualRoot = await tmp("cs2t-manual-");
    const logPath = path.join(manualRoot, "console.log");
    const cfgDir = path.join(manualRoot, "cfg");
    await fs.mkdir(cfgDir);
    await fs.writeFile(logPath, "x\n");

    const { app, dir } = await boot([auto]);
    await app.updateSettings({ cs2: { pathMode: "manual", logPath, cfgDir } });
    expect((await app.getState()).paths).toMatchObject({ mode: "manual", logPath, cfgDir, logExists: true });

    await app.redetect();
    expect((await app.getState()).paths).toMatchObject({ mode: "manual", logPath, cfgDir });

    await fs.rm(logPath);
    await app.redetect();
    const missing = (await app.getState()).paths;
    expect(missing).toMatchObject({ mode: "manual", logPath, logExists: false }); // still manual, honestly "missing"

    // survives a restart
    await app.close();
    const again = await boot([auto], dir);
    expect((await again.app.getState()).paths).toMatchObject({ mode: "manual", logPath, cfgDir });

    // and switching back to automatic is explicit
    await again.app.updateSettings({ cs2: { pathMode: "auto" } });
    expect((await again.app.getState()).paths).toMatchObject({ mode: "auto", logPath: auto.logPath });
  });

  it("falls back to the detected value only for a field the user left empty", async () => {
    const auto = await makeInstall(await tmp(), 100);
    const manualLog = path.join(await tmp("cs2t-m-"), "console.log");
    const { app } = await boot([auto]);
    await app.updateSettings({ cs2: { pathMode: "manual", logPath: manualLog, cfgDir: "" } });
    expect((await app.getState()).paths).toMatchObject({ mode: "manual", logPath: manualLog, cfgDir: auto.cfgDir });
  });

  it("flags a file that is not called console.log", async () => {
    const f = path.join(await tmp(), "notes.txt");
    await fs.writeFile(f, "hi");
    const { app } = await boot([]);
    await app.updateSettings({ cs2: { pathMode: "manual", logPath: f } });
    expect((await app.getState()).paths).toMatchObject({ logExists: true, logNameUnusual: true });
  });

  it("works with spaces, Chinese, ampersands and parentheses in folder names", async () => {
    const root = path.join(await tmp(), "Counter-Strike (測試) & 資料夾 100%");
    const cfgDir = path.join(root, "cfg 資料夾");
    await fs.mkdir(cfgDir, { recursive: true });
    const logPath = path.join(root, "console.log");
    await fs.writeFile(logPath, "");
    const { app } = await boot([]);
    await app.updateSettings({ cs2: { pathMode: "manual", logPath, cfgDir } });
    const state = await app.getState();
    expect(state.paths).toMatchObject({ logPath, cfgDir, logExists: true, cfgDirWritable: true });
    await until(() => app.tailer.listenerCount("line") > 0);
    const prepared = await app.prepareCfg("hello", "all", "direct");
    expect(await fs.readFile(prepared.file, "utf8")).toContain('say "hello"');
    expect(path.dirname(prepared.file)).toBe(cfgDir);
  });

  it("rejects control characters in paths at the settings layer", async () => {
    const { app } = await boot([]);
    await expect(app.updateSettings({ cs2: { logPath: "C:/a\nb/console.log" } })).rejects.toThrow();
    await expect(app.updateSettings({ cs2: { cfgDir: "C:/x\u0000y" } })).rejects.toThrow();
  });
});

describe("settings written by the previous version", () => {
  it("treats explicit paths as manual mode, and no paths as automatic", async () => {
    const dir = await tmp("cs2t-legacy-");
    await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify({ cs2: { logPath: "D:/old/console.log", cfgDir: "D:/old/cfg", bindKey: "f8", cfgFileName: "mine.cfg", selfNames: ["Old Me"] } }));
    const { app } = await boot([], dir);
    expect(app.settings.get().cs2).toMatchObject({ pathMode: "manual", logPath: "D:/old/console.log", bindKey: "f8", cfgFileName: "mine.cfg", selfNames: ["Old Me"] });

    const dir2 = await tmp("cs2t-legacy-");
    await fs.writeFile(path.join(dir2, "settings.json"), JSON.stringify({ cs2: { bindKey: "kp_plus" }, translation: { geminiModel: "gemini-flash-latest" } }));
    const again = await boot([], dir2);
    expect(again.app.settings.get().cs2.pathMode).toBe("auto");
    expect(again.app.settings.get().general).toMatchObject({ smartFilter: true, translationCache: true });
    expect(again.app.settings.get().translation.staleAfterMs).toBe(5000);
  });
});

describe("finding several installs", () => {
  it("lists every Steam library that holds CS2, without duplicates", async () => {
    const root = await tmp("cs2t-steam-");
    const lib2 = await tmp("cs2t-lib2-");
    await fs.mkdir(path.join(root, "steamapps"), { recursive: true });
    await fs.writeFile(path.join(root, "steamapps", "libraryfolders.vdf"), `"libraryfolders" { "0" { "path" ${JSON.stringify(root)} } "1" { "path" ${JSON.stringify(lib2)} } "2" { "path" ${JSON.stringify(lib2)} } }`);
    for (const lib of [root, lib2]) await fs.mkdir(path.join(lib, "steamapps", "common", "Counter-Strike Global Offensive", "game", "csgo", "cfg"), { recursive: true });
    const found = await findCs2Installs([root, root]);
    const dirs = found.map((f) => f.library.toLowerCase());
    expect(dirs).toContain(root.toLowerCase());
    expect(dirs).toContain(path.normalize(lib2).toLowerCase());
    expect(new Set(found.map((f) => f.gameDir.toLowerCase())).size).toBe(found.length);
  });
});

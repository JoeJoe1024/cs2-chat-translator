import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDir } from "../config/paths";
import { buildIdOf, newestMtime } from "./build";
import { acquireLock, findRunning, findRunningWithHealth, isProcessAlive, probeHealth, readInstance, removeInstance } from "./instance";

/**
 * Entry point of start.bat. Responsibilities:
 *  - make sure the app files exist,
 *  - never start a second server: reuse a healthy instance, and serialise concurrent double-clicks,
 *  - start the server (it picks the next free port if 9527 is taken),
 *  - open the browser exactly once, and keep this window open with the server log.
 */
const BASE_PORT = Number(process.env.CS2T_PORT ?? 9527);
const EXIT_PORT_BUSY = 3;
const READY_TIMEOUT_MS = 25_000;

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = configDir();

const MSG = {
  oldNode: "Node.js 版本過舊。CS2 Chat Translator 需要 Node.js 22.12 或更新版本。\n請至 https://nodejs.org/ 安裝 LTS 版本後,重新雙擊 start.bat。",
  filesMissing: (f: string) => `找不到程式檔案:${f}\n請確認已完整解壓縮,或(開發版)先執行 npm run build。`,
  already: (url: string) => `CS2 Chat Translator 已經在執行,已為你開啟瀏覽器:\n  ${url}`,
  starting: "正在啟動 CS2 Chat Translator…",
  ready: (url: string) => `已啟動:${url}\n瀏覽器會自動開啟。關閉此視窗即可結束程式。`,
  portBusy: (lo: number, hi: number) =>
    `無法啟動:連接埠 ${lo}–${hi} 全部被其他程式占用。\n請關閉占用的程式後再試。`,
  crashed: (code: number | null) => `服務意外結束(代碼 ${code ?? "未知"}),上方有詳細訊息。`,
  timeout: "等待服務啟動逾時。請查看上方訊息,或關閉此視窗後重試。",
  waiting: "另一個啟動程序正在進行,等待它完成…",
  stale: "偵測到程式碼比建置檔新(建置已過期),正在重新建置,只有過期時才會執行…",
  buildFailed: "自動建置失敗,上方有詳細訊息。請在專案資料夾手動執行 npm run build。",
  restartOld: "偵測到舊版本的 CS2 Chat Translator 仍在執行,而且沒有尚未送出的訊息,正在安全地換成新版本…",
  cannotStopOld: "舊版本的服務無法自動關閉。請先關閉它(原本的啟動視窗)後再重試。",
  olderKept: (port: number) => `偵測到舊版本的 CS2 Chat Translator 仍在連接埠 ${port} 執行。為避免遺失尚未送出的訊息,沒有關閉它,直接為你開啟它。要改用新版本,請先關閉舊的視窗再重新啟動。`,
};

function fail(message: string, code = 1): never {
  console.error(`\n[錯誤] ${message}\n`);
  process.exit(code);
}

function openBrowser(url: string): void {
  if (process.env.CS2T_NO_BROWSER === "1" || process.platform !== "win32") return;
  // rundll32 opens the default browser without spawning an extra console window or going through cmd quoting rules.
  spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await probe();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

async function main(): Promise<void> {
  // The Node.js version is checked here rather than by an inline script in start.bat.
  if (Number(process.versions.node.split(".")[0]) < 22) fail(MSG.oldNode);
  const serverFile = path.join(here, "server.mjs");
  const webIndex = path.join(here, "web", "index.html");
  for (const f of [serverFile, webIndex]) if (!existsSync(f)) fail(MSG.filesMissing(f));

  // Development checkout only (a portable release has no sources): never start a build older than the code.
  const root = path.resolve(here, "..");
  if (process.env.CS2T_SKIP_STALE_CHECK !== "1" && existsSync(path.join(root, "src")) && existsSync(path.join(root, "package.json"))) {
    const sources = [path.join(root, "src"), path.join(root, "web", "src"), path.join(root, "web", "index.html"), path.join(root, "package.json")];
    if (newestMtime(sources) > statSync(serverFile).mtimeMs + 1000) {
      console.log(MSG.stale);
      const built = spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: true });
      if (built.status !== 0) fail(MSG.buildFailed);
    }
  }
  const currentBuild = buildIdOf(serverFile);

  const reuse = async (): Promise<boolean> => {
    const found = await findRunningWithHealth(dir);
    if (!found) return false;
    const { info: running, health } = found;
    if (running.buildId !== currentBuild) {
      // Replace an older copy only when it can be done without losing anything: it identifies itself (so it is ours)
      // and reports that no message is waiting to be sent. Anything else (an older build that cannot say, or a
      // prepared message) is left running and simply opened.
      const safe = typeof health.instanceId === "string" && health.hasPrepared === false;
      if (safe) {
        console.log(MSG.restartOld);
        // Verify again right before the kill: the process may have exited (and its PID been reused) or a message may
        // have been prepared since the first check. Only the same, still-idle instance is ever terminated.
        const again = await findRunningWithHealth(dir);
        const unchanged =
          again !== null && again.info.pid === running.pid && again.health.instanceId === health.instanceId && again.health.hasPrepared === false;
        if (unchanged) {
          try {
            process.kill(running.pid);
          } catch {
            /* already gone */
          }
          const gone = await waitFor(async () => (isProcessAlive(running.pid) ? null : true), 8000);
          if (!gone) fail(MSG.cannotStopOld);
          await removeInstance(dir, running.pid);
          return false;
        }
        if (again === null) return false; // it went away on its own: nothing to close, start normally
      }
      console.log(MSG.olderKept(running.port));
    }
    const url = `http://127.0.0.1:${running.port}/`;
    console.log(MSG.already(url));
    openBrowser(url);
    return true;
  };
  if (await reuse()) return;

  const release = await acquireLock(dir);
  if (!release) {
    // Someone else is starting the server right now: wait for it and just open the page.
    console.log(MSG.waiting);
    const running = await waitFor(() => findRunning(dir), READY_TIMEOUT_MS);
    if (!running) fail(MSG.timeout);
    const url = `http://127.0.0.1:${running.port}/`;
    console.log(MSG.already(url));
    openBrowser(url);
    return;
  }

  console.log(MSG.starting);
  const child: ChildProcess = spawn(process.execPath, [serverFile, "--port", String(BASE_PORT)], {
    stdio: "inherit",
    windowsHide: false,
    env: { ...process.env, CS2T_WEB_ROOT: path.join(here, "web") },
  });
  let exited: number | null | undefined;
  child.on("exit", (code) => (exited = code));
  const forward = () => child.kill();
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);

  const ready = await waitFor(async () => {
    if (exited !== undefined) return { dead: true as const };
    const info = await readInstance(dir);
    if (info && info.pid === child.pid && isProcessAlive(info.pid) && (await probeHealth(info.port))) return { dead: false as const, port: info.port };
    return null;
  }, READY_TIMEOUT_MS);
  await release();

  if (!ready) {
    child.kill();
    fail(MSG.timeout);
  }
  if (ready.dead) {
    if (exited === EXIT_PORT_BUSY) fail(MSG.portBusy(BASE_PORT, BASE_PORT + 10), EXIT_PORT_BUSY);
    fail(MSG.crashed(exited ?? null), exited || 1);
  }

  const url = `http://127.0.0.1:${ready.port}/`;
  console.log(MSG.ready(url));
  openBrowser(url);

  const code = await new Promise<number | null>((resolve) => (exited !== undefined ? resolve(exited) : child.on("exit", resolve)));
  if (code !== 0 && code !== null) fail(MSG.crashed(code), code);
}

main().catch((err: unknown) => fail(`啟動器發生錯誤:${err instanceof Error ? err.message : String(err)}`));

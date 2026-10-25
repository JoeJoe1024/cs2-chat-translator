import { execFile } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parseVdf, vdfGet } from "./vdf";

export const CS2_APP_ID = "730";
const CS2_FOLDER = ["steamapps", "common", "Counter-Strike Global Offensive", "game", "csgo"];

export interface Cs2Install {
  steamRoot: string;
  library: string;
  /** `.../game/csgo` */
  gameDir: string;
  logPath: string;
  cfgDir: string;
  vpkDir: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function readSteamPathFromRegistry(): Promise<string | null> {
  if (process.platform !== "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("reg", ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /SteamPath\s+REG_SZ\s+(.+)/i.exec(stdout);
      resolve(m?.[1] ? path.normalize(m[1].trim()) : null);
    });
  });
}

export async function findSteamRoots(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const candidates: (string | null)[] = [await readSteamPathFromRegistry()];
  const pf86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  candidates.push(path.join(pf86, "Steam"), path.join(env.ProgramFiles ?? "C:\\Program Files", "Steam"));
  const found: string[] = [];
  for (const c of candidates) {
    if (c && !found.includes(c) && (await exists(path.join(c, "steamapps")))) found.push(c);
  }
  return found;
}

/** All Steam library folders (including the root itself) listed in `libraryfolders.vdf`. */
export async function steamLibraries(steamRoot: string): Promise<string[]> {
  const libs = [steamRoot];
  try {
    const vdf = parseVdf(await fs.readFile(path.join(steamRoot, "steamapps", "libraryfolders.vdf"), "utf8"));
    const root = vdfGet(vdf, "libraryfolders");
    if (root && typeof root !== "string") {
      for (const entry of Object.values(root)) {
        const p = typeof entry === "string" ? entry : vdfGet(entry, "path");
        if (typeof p === "string" && !libs.some((l) => l.toLowerCase() === path.normalize(p).toLowerCase())) libs.push(path.normalize(p));
      }
    }
  } catch {
    /* no libraryfolders.vdf: the root library is all we know */
  }
  return libs;
}

/** Every CS2 install found in any Steam library (or the common default folders), without duplicates. */
export async function findCs2Installs(extraRoots: string[] = []): Promise<Cs2Install[]> {
  const roots = [...extraRoots, ...(await findSteamRoots())];
  const found: Cs2Install[] = [];
  const add = async (steamRoot: string, library: string) => {
    const gameDir = path.join(library, ...CS2_FOLDER);
    if (found.some((f) => f.gameDir.toLowerCase() === gameDir.toLowerCase())) return;
    if (await exists(gameDir)) found.push(describeInstall(steamRoot, library, gameDir));
  };
  for (const steamRoot of roots) for (const library of await steamLibraries(steamRoot)) await add(steamRoot, library);
  if (process.platform === "win32") {
    for (const library of ["D:/Steam", "D:/SteamLibrary", "E:/SteamLibrary", "C:/Steam"]) await add(roots[0] ?? library, library);
  }
  return found;
}

/** The first install found. Prefer `findCs2Installs` when the user may have several. */
export async function findCs2Install(extraRoots: string[] = []): Promise<Cs2Install | null> {
  return (await findCs2Installs(extraRoots))[0] ?? null;
}

function describeInstall(steamRoot: string, library: string, gameDir: string): Cs2Install {
  return {
    steamRoot,
    library,
    gameDir,
    logPath: path.join(gameDir, "console.log"),
    cfgDir: path.join(gameDir, "cfg"),
    vpkDir: gameDir,
  };
}

/** `"language"` inside `appmanifest_730.acf` → UserConfig. This is Steam's setting, not proof of the in-game language. */
export async function readSteamAppLanguage(install: Cs2Install): Promise<string | null> {
  try {
    const vdf = parseVdf(await fs.readFile(path.join(install.library, "steamapps", `appmanifest_${CS2_APP_ID}.acf`), "utf8"));
    const lang = vdfGet(vdf, "AppState", "UserConfig", "language");
    return typeof lang === "string" && lang ? lang.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function userdataConfigs(steamRoot: string): Promise<string[]> {
  try {
    const ids = await fs.readdir(path.join(steamRoot, "userdata"));
    return ids.map((id) => path.join(steamRoot, "userdata", id, "config", "localconfig.vdf"));
  } catch {
    return [];
  }
}

/** CS2 launch options from every local Steam account, so `-language xyz` can be honoured. */
export async function readLaunchOptions(steamRoot: string): Promise<string[]> {
  const out: string[] = [];
  for (const file of await userdataConfigs(steamRoot)) {
    try {
      const vdf = parseVdf(await fs.readFile(file, "utf8"));
      const opts = vdfGet(vdf, "UserLocalConfigStore", "Software", "Valve", "Steam", "apps", CS2_APP_ID, "LaunchOptions");
      if (typeof opts === "string" && opts) out.push(opts);
    } catch {
      /* unreadable account folder */
    }
  }
  return out;
}

/** Steam persona names of local accounts; the most recently used one first. */
export async function readPersonaNames(steamRoot: string): Promise<string[]> {
  try {
    const vdf = parseVdf(await fs.readFile(path.join(steamRoot, "config", "loginusers.vdf"), "utf8"));
    const users = vdfGet(vdf, "users");
    if (!users || typeof users === "string") return [];
    const rows = Object.values(users)
      .filter((u): u is Record<string, string> => typeof u !== "string")
      .map((u) => ({ name: String(vdfGet(u, "PersonaName") ?? ""), recent: vdfGet(u, "MostRecent") === "1" }))
      .filter((u) => u.name);
    rows.sort((a, b) => Number(b.recent) - Number(a.recent));
    return rows.map((r) => r.name);
  } catch {
    return [];
  }
}

export async function isWritableDir(dir: string): Promise<boolean> {
  try {
    await fs.access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

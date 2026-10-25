import fs from "node:fs/promises";
import { GAME_LANGUAGE_IDS } from "../shared/gameLanguages";
import type { GameLanguageEvidence } from "../shared/protocol";
import { readLaunchOptions, readSteamAppLanguage, type Cs2Install } from "./steam";

const ID_ALT = GAME_LANGUAGE_IDS.join("|");
/** e.g. `ILocalize::AddFile() failed to load file "resource/keybindings_tchinese.txt"` */
const LOG_LANG_RE = new RegExp(`resource/(?:keybindings|csgo|platform|gameui|valve)_(${ID_ALT})\\.txt`, "i");

export function isKnownGameLanguage(id: string): boolean {
  return (GAME_LANGUAGE_IDS as readonly string[]).includes(id);
}

/** Looks for the language CS2 itself reported while loading resources (strongest evidence). */
export function languageFromLogText(text: string): string | null {
  const m = LOG_LANG_RE.exec(text);
  return m?.[1] ? m[1].toLowerCase() : null;
}

export function languageFromLaunchOptions(options: string): string | null {
  const m = /(?:^|\s)-language\s+"?([a-z_]+)"?/i.exec(options);
  const id = m?.[1]?.toLowerCase();
  return id && isKnownGameLanguage(id) ? id : null;
}

async function readHead(file: string, maxBytes: number): Promise<string> {
  const fh = await fs.open(file, "r");
  try {
    const { size } = await fh.stat();
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, 0);
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
}

/**
 * Collects every available clue about the in-game language, strongest first:
 *  1. what the running game logged while loading resources,
 *  2. a `-language` launch option,
 *  3. Steam's per-game language setting.
 * The result is evidence, not a verdict: the chat detector still verifies against real chat lines.
 */
export async function collectGameLanguageEvidence(
  install: Cs2Install | null,
  logPath: string,
): Promise<GameLanguageEvidence[]> {
  const evidence: GameLanguageEvidence[] = [];
  try {
    const head = await readHead(logPath, 2 * 1024 * 1024);
    const id = languageFromLogText(head);
    if (id) evidence.push({ language: id, source: "console-log", detail: "console.log resource loading" });
  } catch {
    /* no log yet */
  }
  if (install) {
    for (const opts of await readLaunchOptions(install.steamRoot)) {
      const id = languageFromLaunchOptions(opts);
      if (id) evidence.push({ language: id, source: "launch-option", detail: "-language launch option" });
    }
    const steamApp = await readSteamAppLanguage(install);
    if (steamApp && isKnownGameLanguage(steamApp)) {
      evidence.push({ language: steamApp, source: "steam-app", detail: "Steam game language setting" });
    }
  }
  return evidence;
}

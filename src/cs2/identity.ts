import fs from "node:fs/promises";
import { cleanName } from "../shared/names";

/**
 * Who is "me"? console.log chat lines carry only a display name: no SteamID, and names are not unique or unforgeable.
 * So the app treats identity in three tiers and never trusts a name alone:
 *
 *   manual       the user typed / accepted the name in Settings        → counts as "me"
 *   console-log  the game itself named the local network channel       → counts as "me"
 *   steam        Steam's profile name (usually, not always, in-game)   → only a SUGGESTION until the user accepts it
 *
 * The console-log source is the engine's own line for the local loopback connection, e.g.
 *   [NetSteamConn] Associating NetChan <name> @ loopback:0 (loopback:0) with Steam Net Connection handle #123
 * It only exists when the local machine hosts the game (offline / practice / bots). In online matches there is no such
 * line, so the name stays "unconfirmed" and the user must accept it manually.
 */
const LOOPBACK = /^(?:\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\s+)?\[NetSteamConn\] Associating NetChan (.+) @ loopback:(\d+) \(loopback:\2\) with Steam Net Connection handle #\d+\s*$/;

/** Returns the local player's name from an engine loopback line, or null. Names containing " @ " are rejected. */
export function localNameFromLine(line: string): string | null {
  if (!line.includes("loopback")) return null;
  const m = LOOPBACK.exec(line);
  const name = m?.[1] ? cleanName(m[1]) : "";
  if (!name || name === "server" || name.includes(" @ ")) return null;
  return name;
}

/** Scans the start of console.log (the current game session) for the most recent local-player line. */
export async function detectLocalNameInLog(logPath: string, maxBytes = 2 * 1024 * 1024): Promise<string | null> {
  let fh;
  try {
    fh = await fs.open(logPath, "r");
    const { size } = await fh.stat();
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, 0);
    let last: string | null = null;
    for (const line of buf.toString("utf8").split(/\r?\n/)) last = localNameFromLine(line) ?? last;
    return last;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

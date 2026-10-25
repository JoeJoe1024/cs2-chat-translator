import os from "node:os";
import path from "node:path";

/** Where settings and caches live. Never inside the install folder, so upgrades keep them. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CS2T_CONFIG_DIR) return path.resolve(env.CS2T_CONFIG_DIR);
  const base = env.APPDATA ?? path.join(os.homedir(), process.platform === "win32" ? "AppData/Roaming" : ".config");
  return path.join(base, "cs2-chat-translator");
}

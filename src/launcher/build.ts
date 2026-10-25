import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Identifies one build of the app: the modification time of dist/server.mjs. The server records it, the launcher compares it. */
export function buildIdOf(serverFile: string): string {
  try {
    return String(Math.round(statSync(serverFile).mtimeMs));
  } catch {
    return "";
  }
}

/** Newest modification time under the given files / folders (missing ones are ignored). Cheap: only stats, no reads. */
export function newestMtime(paths: string[]): number {
  let newest = 0;
  const visit = (p: string) => {
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) if (name !== "node_modules") visit(path.join(p, name));
    } else if (st.mtimeMs > newest) newest = st.mtimeMs;
  };
  paths.forEach(visit);
  return newest;
}

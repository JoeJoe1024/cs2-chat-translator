// Guard for release folders: a portable build must never carry the developer's keys, settings or caches.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** File names that only ever exist on a machine that RAN the app (or hold secrets). */
const FORBIDDEN_NAMES = [
  /^secrets\..*$/i,
  /\.dpapi(\.|$)/i,
  /^settings\.json(\..*)?$/i,
  /^instance\.json$/i,
  /^launcher\.lock$/i,
  /^gemini-models\.json$/i,
  /^chat-templates\.json$/i,
  /^config\.json$/i,
  /^\.env(\..*)?$/i,
  /\.(pem|key|pfx|p12)$/i,
];

/** Text that looks like a real credential. Google API keys start with "AIza" and are 39 characters long. */
const SECRET_PATTERNS = [
  /AIza[0-9A-Za-z_-]{30,}/,
  /"apiKey"\s*:\s*"[^"]{8,}"/,
  /x-goog-api-key["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{20,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const TEXT_EXT = new Set([".txt", ".json", ".js", ".mjs", ".cjs", ".css", ".html", ".bat", ".md", ".cfg", ".log", ".map"]);
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

/** Returns human readable problems (empty = clean). Binary files such as node.exe are checked by name only. */
export function findSecretLeaks(root) {
  const problems = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      const rel = path.relative(root, full);
      if (FORBIDDEN_NAMES.some((re) => re.test(name))) problems.push(`forbidden file: ${rel}`);
      if (TEXT_EXT.has(path.extname(name).toLowerCase()) && st.size <= MAX_SCAN_BYTES) {
        const text = readFileSync(full, "utf8");
        for (const re of SECRET_PATTERNS) if (re.test(text)) problems.push(`secret-looking text in ${rel} (${re.source.slice(0, 24)}…)`);
      }
    }
  };
  walk(root);
  return problems;
}

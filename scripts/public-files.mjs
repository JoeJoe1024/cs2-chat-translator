// Lists what belongs in the PUBLIC GitHub repository and fails if anything unclassified or private is found.
//   npm run public-files
// It reads the file system only; it never runs git, never uploads anything and never changes a file.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Folders that are never part of the repository (rebuilt, installed or local-only). */
const SKIP_DIRS = new Set(["node_modules", "dist", "release", "coverage", ".git", ".claude"]);
/** Local-only paths (must match .gitignore). */
const INTERNAL = [/^docs[\\/]internal[\\/]/];
/** The allow-list of public paths. */
const PUBLIC = [
  /^(README|README\.zh-TW|SECURITY|STREAMING_PERMISSION)\.md$/,
  /^(LICENSE|THIRD-PARTY-NOTICES\.txt|start\.bat|package\.json|package-lock\.json|\.gitignore|.gitattributes)$/,
  /^(tsconfig|tsconfig\.server)\.json$/,
  /^(eslint\.config\.js|vite\.config\.ts|vitest\.config\.ts)$/,
  /^docs[\\/]ARCHITECTURE\.md$/,
  /^docs[\\/]images[\\/][^\\/]+\.png$/,
  /^(src|web|tests)[\\/]/,
  /^scripts[\\/]/,
  /^logo[\\/]/,
];
/** Never allowed anywhere in the public tree. */
const FORBIDDEN_NAME = /(\.dpapi|^secrets\.json$|^settings\.json$|^instance\.json$|^launcher\.lock$|^\.env|\.(pem|key|pfx|p12)$)/i;
const KEY_LIKE = /AIza[0-9A-Za-z_-]{30,}/;

const problems = [];
const publicFiles = [];
const internalFiles = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) && dir === root) continue;
    const full = path.join(dir, name);
    const rel = path.relative(root, full);
    if (statSync(full).isDirectory()) {
      if (name === ".playwright-mcp") problems.push(`local tool folder present: ${rel}`);
      else walk(full);
      continue;
    }
    if (INTERNAL.some((re) => re.test(rel))) internalFiles.push(rel);
    else if (!PUBLIC.some((re) => re.test(rel))) problems.push(`unclassified file (decide public or internal): ${rel}`);
    else {
      publicFiles.push(rel);
      if (FORBIDDEN_NAME.test(name)) problems.push(`private-looking file name in the public set: ${rel}`);
      // tests deliberately contain obviously fake keys such as AIzaSy…DUMMY…; real-looking ones are refused
      if (!/^tests[\\/]/.test(rel) && /\.(md|txt|json|ts|tsx|mjs|js|css|html|bat)$/.test(name) && KEY_LIKE.test(readFileSync(full, "utf8"))) {
        problems.push(`key-like text in ${rel}`);
      }
    }
  }
};
walk(root);

console.log(`Public files: ${publicFiles.length}`);
console.log(`Local-only (internal) files, kept out of the repository: ${internalFiles.length}`);
for (const f of internalFiles) console.log(`  - ${f}`);
if (problems.length > 0) {
  console.error("\nProblems:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log("\nOK: every file is classified, no private-looking file is in the public set.");

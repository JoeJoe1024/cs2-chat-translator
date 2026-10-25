// Builds a LOCAL portable folder + zip: no installer, no Node.js required on the target PC.
//   npm run build && npm run portable
// Output: release/cs2-chat-translator-portable/ and release/cs2-chat-translator-v<version>-windows-portable.zip (never uploaded anywhere).
// The Node.js runtime is copied from the Node.js that runs this script (MIT-licensed; its LICENSE is copied alongside).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findSecretLeaks } from "./lib/secret-scan.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = path.join(root, "release", "cs2-chat-translator-portable");
const need = ["dist/server.mjs", "dist/launcher.mjs", "dist/web/index.html", "start.bat"];
for (const f of need) {
  if (!existsSync(path.join(root, f))) {
    console.error(`Missing ${f}. Run "npm run build" first.`);
    process.exit(1);
  }
}
if (process.platform !== "win32") {
  console.error("The portable build bundles node.exe and is only supported on Windows.");
  process.exit(1);
}

rmSync(path.join(root, "release"), { recursive: true, force: true });
mkdirSync(path.join(out, "runtime"), { recursive: true });
cpSync(path.join(root, "dist"), path.join(out, "dist"), { recursive: true });
cpSync(path.join(root, "scripts", "messages"), path.join(out, "scripts", "messages"), { recursive: true });
cpSync(path.join(root, "start.bat"), path.join(out, "start.bat"));
cpSync(process.execPath, path.join(out, "runtime", "node.exe"));
// The Node.js licence file is not installed next to node.exe on Windows, so a copy of the official LICENSE for the
// matching release is kept in scripts/licenses (the build refuses to continue without it).
const nodeLicense = path.join(root, "scripts", "licenses", "node-LICENSE.txt");
if (!existsSync(nodeLicense)) {
  console.error("Missing scripts/licenses/node-LICENSE.txt (the Node.js licence that must ship next to runtime/node.exe).");
  process.exit(1);
}
cpSync(nodeLicense, path.join(out, "runtime", "LICENSE-node.txt"));
// Public legal files only. Internal documents (docs/internal) are never copied.
for (const doc of ["LICENSE", "STREAMING_PERMISSION.md", "THIRD-PARTY-NOTICES.txt"]) {
  if (!existsSync(path.join(root, doc))) {
    console.error(`Missing ${doc}; the portable package must include it.`);
    process.exit(1);
  }
  cpSync(path.join(root, doc), path.join(out, doc));
}
cpSync(path.join(root, "scripts", "portable-readme.txt"), path.join(out, "README.txt"));

const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
writeFileSync(path.join(out, "VERSION.txt"), `${version}\nNode.js ${process.version}\n`);

// Only an explicit allow-list is copied above, and this scan double-checks the result: a build that would ship a key,
// settings or any per-user file is refused rather than zipped.
const leaks = findSecretLeaks(out);
if (leaks.length > 0) {
  console.error("Refusing to package: the release folder contains private data:\n  " + leaks.join("\n  "));
  rmSync(path.join(root, "release"), { recursive: true, force: true });
  process.exit(1);
}

// Nothing outside this list may ship (no sources, tests, internal docs, node_modules, source maps).
const ALLOWED_TOP = new Set(["dist", "runtime", "scripts", "start.bat", "README.txt", "LICENSE", "STREAMING_PERMISSION.md", "THIRD-PARTY-NOTICES.txt", "VERSION.txt"]);
const extra = readdirSync(out).filter((n) => !ALLOWED_TOP.has(n));
const maps = readdirSync(path.join(out, "dist"), { recursive: true }).filter((n) => String(n).endsWith(".map"));
if (extra.length > 0 || maps.length > 0) {
  console.error(`Refusing to package: unexpected entries: ${[...extra, ...maps].join(", ")}`);
  rmSync(path.join(root, "release"), { recursive: true, force: true });
  process.exit(1);
}

const zip = path.join(root, "release", `cs2-chat-translator-v${version}-windows-portable.zip`);
// Windows' own bsdtar (System32\tar.exe, Windows 10 1803+) writes standard zip archives; GNU tar from Git would not.
execFileSync(path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "tar.exe"), ["-a", "-c", "-f", zip, "-C", path.join(root, "release"), "cs2-chat-translator-portable"], { stdio: "inherit" });
// SHA-256 so downloaders can check the file (verify with: Get-FileHash <zip> -Algorithm SHA256).
const hash = createHash("sha256").update(readFileSync(zip)).digest("hex");
const sumsFile = `${zip}.sha256.txt`;
writeFileSync(sumsFile, `${hash} *${path.basename(zip)}\n`);
console.log(`Portable folder: ${out}\nZip:             ${zip}\nSHA-256:         ${hash}`);

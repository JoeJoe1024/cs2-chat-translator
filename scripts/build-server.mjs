// Bundles the Node side into two single files so a portable build needs no node_modules:
//   dist/server.mjs   the local service
//   dist/launcher.mjs what start.bat runs
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

await build({
  absWorkingDir: root,
  entryPoints: { server: "src/server/main.ts", launcher: "src/launcher/main.ts" },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  minify: false,
  legalComments: "none",
  logLevel: "info",
});

import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDir } from "../config/paths";
import { removeInstance, writeInstance } from "../launcher/instance";
import { randomUUID } from "node:crypto";
import { buildIdOf } from "../launcher/build";
import { findRunning } from "../launcher/instance";
import { APP_VERSION } from "../shared/version";
import { App } from "./app";
import { startServer } from "./http";

const DEFAULT_PORT = 9527;
/** Exit code the launcher recognises: no free port in the probing range. */
const EXIT_PORT_BUSY = 3;

function parsePort(argv: string[]): number {
  const i = argv.indexOf("--port");
  const port = i === -1 ? DEFAULT_PORT : Number(argv[i + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be 0-65535");
  return port;
}

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Bundled: dist/server.mjs next to dist/web. Dev (tsx): src/server → ../../dist/web.
  const webRoot = path.resolve(here, process.env.CS2T_WEB_ROOT ?? (path.basename(here) === "dist" ? "web" : "../../dist/web"));
  const dir = configDir();

  // One service per user: if a valid one is already running, do not start a second copy (the launcher normally
  // checks this too; this covers starting the server file directly).
  const existing = await findRunning(dir);
  if (existing && existing.pid !== process.pid) {
    console.log(`CS2 Chat Translator is already running: http://127.0.0.1:${existing.port}/`);
    process.exit(0);
  }

  const instanceId = randomUUID();
  const buildId = buildIdOf(fileURLToPath(import.meta.url));
  const app = new App({ configDir: dir });
  await app.init();
  const running = await startServer({ app, port: parsePort(process.argv.slice(2)), webRoot, identity: () => ({ instanceId, buildId, hasPrepared: app.hasPrepared() }) });
  await writeInstance(dir, { pid: process.pid, port: running.port, version: APP_VERSION, startedAt: Date.now(), buildId, instanceId });

  const state = await app.getState();
  console.log(`CS2 Chat Translator ${APP_VERSION}`);
  console.log(`  UI:         http://127.0.0.1:${running.port}/`);
  console.log(`  CS2 log:    ${state.paths.logPath || "(not found - set it in Settings)"}`);
  console.log(`  cfg dir:    ${state.paths.cfgDir || "(not found - set it in Settings)"}`);
  console.log(`  Secrets:    ${state.secureStorage === "dpapi" ? "Windows DPAPI" : "memory only (not persisted)"}`);
  console.log("Close this window or press Ctrl+C to stop.");

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await removeInstance(dir, process.pid).catch(() => undefined);
    await running.close();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGBREAK", () => void shutdown());
}

main().catch((err: unknown) => {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EADDRINUSE") {
    console.error("Failed to start: all ports in the probing range are in use.");
    process.exit(EXIT_PORT_BUSY);
  }
  console.error("Failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});

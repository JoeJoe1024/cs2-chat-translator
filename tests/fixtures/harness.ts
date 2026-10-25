import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { MemorySecretStore } from "../../src/config/secrets";
import { LogTailer } from "../../src/cs2/logTailer";
import type { ServerEvent } from "../../src/shared/protocol";
import { App } from "../../src/server/app";
import { startServer, type RunningServer } from "../../src/server/http";

export const TS = "10/22 23:40:01 ";

/** Pretends to be the Google endpoint: "hola" → "T(hola)", reported as Japanese. */
export function googleFetch(overrides: { status?: number } = {}) {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (overrides.status && overrides.status !== 200) return new Response("err", { status: overrides.status });
    const q = new URLSearchParams(String(init?.body)).get("q") ?? "";
    return new Response(JSON.stringify([[[`T(${q})`, q]], null, "ja"]), { status: 200 });
  });
}

export async function until(cond: () => boolean | Promise<boolean>, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

export interface Harness {
  dir: string;
  cfgDir: string;
  logPath: string;
  cfgFile: string;
  app: App;
  events: ServerEvent[];
  fetchMock: ReturnType<typeof googleFetch>;
  secrets: MemorySecretStore;
  writeLog(lines: string[]): Promise<void>;
  cfg(): Promise<string>;
  /** True when the cfg currently contains a say / say_team command (i.e. something is prepared). */
  hasSay(): Promise<boolean>;
  stop(): Promise<void>;
}

export async function bootApp(opts: { fetchMock?: ReturnType<typeof googleFetch>; persona?: string[]; authorize?: boolean } = {}): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs2t-app-"));
  const cfgDir = path.join(dir, "cfg");
  await fs.mkdir(cfgDir);
  const logPath = path.join(dir, "console.log");
  await fs.writeFile(logPath, "");
  const secrets = new MemorySecretStore();
  const fetchMock = opts.fetchMock ?? googleFetch();
  const app = new App({
    configDir: path.join(dir, "config"),
    secrets,
    fetchImpl: fetchMock as unknown as typeof fetch,
    tailer: new LogTailer(10),
    installs: [],
    personaNames: opts.persona ?? ["Me"],
  });
  const events: ServerEvent[] = [];
  const emit = app.hub.emit.bind(app.hub);
  app.hub.emit = (e: ServerEvent) => {
    events.push(e);
    emit(e);
  };
  await app.init();
  await app.updateSettings({ cs2: { pathMode: "manual", logPath, cfgDir, selfNames: opts.authorize === false ? [] : ["Me"] } });
  await until(() => events.some((e) => e.type === "watcher" && e.status.state === "watching"));
  const cfgFile = path.join(cfgDir, "chat_reader.cfg");
  return {
    dir,
    cfgDir,
    logPath,
    cfgFile,
    app,
    events,
    fetchMock,
    secrets,
    writeLog: (lines) => fs.appendFile(logPath, lines.map((l) => `${TS}${l}\n`).join("")),
    cfg: () => fs.readFile(cfgFile, "utf8"),
    hasSay: () => fs.readFile(cfgFile, "utf8").then((c) => /^say(_team)? "/m.test(c), () => false),
    stop: () => app.close(),
  };
}

export interface WebHarness extends Harness {
  server: RunningServer;
  token: string;
  base: string;
}

export async function bootWeb(opts: Parameters<typeof bootApp>[0] = {}): Promise<WebHarness> {
  const h = await bootApp(opts);
  const webRoot = path.join(h.dir, "web");
  await fs.mkdir(path.join(webRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(webRoot, "index.html"), '<!doctype html><meta name="cs2t-token" content="__SESSION_TOKEN__">');
  await fs.writeFile(path.join(webRoot, "assets", "app.js"), "console.log(1)");
  await fs.writeFile(path.join(h.dir, "secret.txt"), "TOP SECRET");
  const server = await startServer({ app: h.app, port: 0, webRoot: path.resolve(webRoot) });
  return {
    ...h,
    server,
    token: server.token,
    base: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      await server.close();
      await h.app.close();
    },
  };
}

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Low-level request so tests can forge Host / Origin headers (fetch forbids that). */
export function rawRequest(
  port: number,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path, headers: { host: `127.0.0.1:${port}`, ...opts.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

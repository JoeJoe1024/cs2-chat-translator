import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { z } from "zod";
import { ENGINE_IDS, settingsPatchSchema } from "../config/schema";
import { CfgError } from "../cs2/cfgWriter";
import { APP_VERSION } from "../shared/version";
import { TranslationError } from "../translation/types";
import { MAX_INPUT_CHARS } from "../translation/service";
import { PrepareSupersededError, type App } from "./app";
import { PickerBusyError, PickerUnsupportedError } from "./picker";
import { MAX_BODY_BYTES, RateLimiter, RequestGuard, newSessionToken } from "./security";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

const SETTINGS_BODY_BYTES = 192 * 1024;
const text = z.string().min(1).max(MAX_INPUT_CHARS);
const langCode = z.string().min(2).max(12);
const schemas = {
  translate: z.object({ text, target: langCode, engine: z.enum(ENGINE_IDS).optional() }),
  cfg: z.object({
    message: z.string().min(1).max(1000),
    channel: z.enum(["all", "team"]),
    /** `translated`: text came from a translation; `direct`: typed text sent as it is. Both use the same key and file. */
    mode: z.enum(["translated", "direct"]).default("translated"),
    /** Client clock at the click; a later click always wins over an earlier, slower one. */
    clickedAt: z.number().int().positive().optional(),
    original: z.string().max(1000).optional(),
  }),
  key: z.object({ apiKey: z.string().trim().min(10).max(256).regex(/^[\x21-\x7e]+$/, "Invalid characters") }),
  keyTest: z.object({
    apiKey: z.string().trim().min(10).max(256).regex(/^[\x21-\x7e]+$/).optional(),
    model: z.string().trim().regex(/^[A-Za-z0-9._-]{1,64}$/).optional(),
  }),
  pick: z.object({ kind: z.enum(["log", "cfg"]), title: z.string().max(120).optional() }),
  paused: z.object({ paused: z.boolean() }),
  messageId: z.object({ id: z.string().regex(/^m[a-z0-9]{3,24}$/) }),
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: unknown,
  ) {
    super(code);
  }
}

export interface ServerOptions {
  app: App;
  port: number;
  webRoot: string;
  token?: string;
  /** Identity reported on /health (instance id, build, whether a message is waiting to be sent). */
  identity?: () => Record<string, unknown>;
}

export interface RunningServer {
  server: http.Server;
  port: number;
  token: string;
  close(): Promise<void>;
}

async function readJson(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limit) throw new HttpError(413, "body-too-large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "body-too-large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid-json");
  }
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new HttpError(400, "validation-failed", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const { app, webRoot } = opts;
  const token = opts.token ?? newSessionToken();
  const translateLimiter = new RateLimiter(30, 10_000);
  const writeLimiter = new RateLimiter(60, 10_000);

  const guardRef: { current: RequestGuard | null } = { current: null };
  let indexHtml: string | null = null;

  const serveStatic = async (res: ServerResponse, pathname: string): Promise<boolean> => {
    const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    const file = path.resolve(webRoot, rel);
    if (file !== webRoot && !file.startsWith(webRoot + path.sep)) return false;
    try {
      if (rel === "index.html") {
        indexHtml ??= await fs.readFile(file, "utf8");
        const body = indexHtml.replace("__SESSION_TOKEN__", token);
        res.writeHead(200, { ...SECURITY_HEADERS, "content-type": MIME[".html"]!, "cache-control": "no-store" });
        res.end(body);
        return true;
      }
      const data = await fs.readFile(file);
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "cache-control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  };

  const route = async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> => {
    const method = req.method ?? "GET";
    const key = req.socket.remoteAddress ?? "local";

    if (method === "GET" && pathname === "/api/events") {
      if (!app.hub.add(res)) throw new HttpError(429, "too-many-streams");
      return;
    }
    if (method === "GET" && pathname === "/api/state") return send(res, 200, await app.getState());

    if (method === "PUT" && pathname === "/api/settings") {
      if (!writeLimiter.allow(key)) throw new HttpError(429, "rate-limited");
      // Larger than other calls: the user dictionary (up to 300 entries) travels with the settings.
      const patch = parse(settingsPatchSchema, await readJson(req, SETTINGS_BODY_BYTES));
      return send(res, 200, { settings: await app.updateSettings(patch) });
    }
    if (method === "PUT" && pathname === "/api/secrets/gemini") {
      if (!writeLimiter.allow(key)) throw new HttpError(429, "rate-limited");
      const { apiKey } = parse(schemas.key, await readJson(req));
      await app.setGeminiKey(apiKey);
      return send(res, 200, { configured: true });
    }
    if (method === "DELETE" && pathname === "/api/secrets/gemini") {
      await app.clearGeminiKey();
      return send(res, 200, { configured: false });
    }
    if (method === "POST" && pathname === "/api/secrets/gemini/test") {
      if (!translateLimiter.allow(key)) throw new HttpError(429, "rate-limited");
      const { apiKey, model } = parse(schemas.keyTest, await readJson(req));
      return send(res, 200, await app.testGeminiKey(apiKey, model));
    }
    if (method === "GET" && pathname === "/api/gemini/models") return send(res, 200, app.geminiModels());
    if (method === "POST" && pathname === "/api/gemini/models/refresh") {
      if (!translateLimiter.allow(key)) throw new HttpError(429, "rate-limited");
      return send(res, 200, await app.refreshGeminiModels());
    }
    if (method === "POST" && pathname === "/api/pick") {
      if (!writeLimiter.allow(key)) throw new HttpError(429, "rate-limited");
      const { kind, title } = parse(schemas.pick, await readJson(req));
      return send(res, 200, await app.browse(kind, title));
    }
    if (method === "POST" && pathname === "/api/paths/redetect") {
      if (!writeLimiter.allow(key)) throw new HttpError(429, "rate-limited");
      await app.redetect();
      return send(res, 200, { ok: true });
    }
    if (method === "POST" && pathname === "/api/translate") {
      if (!translateLimiter.allow(key)) throw new HttpError(429, "rate-limited");
      const body = parse(schemas.translate, await readJson(req));
      return send(res, 200, await app.translateForSend(body.text, body.target, body.engine));
    }
    if (method === "POST" && pathname === "/api/cfg") {
      if (!writeLimiter.allow(key)) throw new HttpError(429, "rate-limited");
      const body = parse(schemas.cfg, await readJson(req));
      const prepared = await app.prepareCfg(body.message, body.channel, body.mode, {
        ...(body.clickedAt ? { clickedAt: body.clickedAt } : {}),
        ...(body.original !== undefined ? { original: body.original } : {}),
      });
      return send(res, 200, { prepared });
    }
    if (method === "POST" && pathname === "/api/cfg/clear") {
      if (!writeLimiter.allow(key)) throw new HttpError(429, "rate-limited");
      await app.clearPrepared();
      return send(res, 200, { ok: true });
    }
    if (method === "POST" && pathname === "/api/chat/translate") {
      if (!translateLimiter.allow(key)) throw new HttpError(429, "rate-limited");
      const { id } = parse(schemas.messageId, await readJson(req));
      const update = await app.translateById(id);
      if (!update) throw new HttpError(404, "message-not-found");
      return send(res, 200, { update });
    }
    if (method === "POST" && pathname === "/api/chat/clear") {
      app.clearHistory();
      return send(res, 200, { ok: true });
    }
    if (method === "PUT" && pathname === "/api/runtime") {
      const { paused } = parse(schemas.paused, await readJson(req));
      return send(res, 200, { runtime: app.setPaused(paused) });
    }
    if (method === "POST" && pathname === "/api/watcher/restart") {
      await app.restartWatcher();
      return send(res, 200, { ok: true });
    }
    throw new HttpError(404, "not-found");
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const guard = guardRef.current!;
      const hostCheck = guard.checkHost(req);
      if (!hostCheck.ok) throw new HttpError(hostCheck.status, hostCheck.code);
      const url = new URL(req.url ?? "/", "http://local");
      const method = req.method ?? "GET";

      // Unauthenticated liveness probe used by start.bat to detect a running instance. Reveals nothing sensitive.
      if (url.pathname === "/health" && method === "GET") return send(res, 200, { app: "cs2-chat-translator", version: APP_VERSION, ...(opts.identity?.() ?? {}) });

      if (url.pathname.startsWith("/api/")) {
        const apiCheck = guard.checkApi(req);
        if (!apiCheck.ok) throw new HttpError(apiCheck.status, apiCheck.code);
        return await route(req, res, url.pathname);
      }
      if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method-not-allowed");
      if (!(await serveStatic(res, url.pathname))) throw new HttpError(404, "not-found");
    } catch (err) {
      if (res.headersSent) return void res.end();
      if (err instanceof HttpError) return send(res, err.status, { error: err.code, ...(err.detail ? { detail: err.detail } : {}) });
      if (err instanceof TranslationError) return send(res, err.code === "quota" ? 429 : 502, { error: `translation-${err.code}` });
      if (err instanceof PrepareSupersededError) return send(res, 409, { error: "superseded" });
      if (err instanceof PickerBusyError) return send(res, 409, { error: "dialog-open" });
      if (err instanceof PickerUnsupportedError) return send(res, 501, { error: "unsupported" });
      if (err instanceof CfgError) return send(res, err.code === "empty-message" ? 400 : 500, { error: err.code });
      // Never leak internals (paths, keys) to the page; details stay in the server console.
      console.error("[server] unexpected error:", err instanceof Error ? err.message : String(err));
      send(res, 500, { error: "internal-error" });
    }
  };

  const server = http.createServer((req, res) => void handler(req, res));
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;

  const port = await new Promise<number>((resolve, reject) => {
    const attempt = (p: number, left: number) => {
      const onListening = () => {
        server.off("error", onError);
        resolve((server.address() as { port: number }).port);
      };
      const onError = (err: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if (err.code === "EADDRINUSE" && left > 0 && opts.port !== 0) attempt(p + 1, left - 1);
        else reject(err);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      // Loopback only: never reachable from other machines.
      server.listen(p, "127.0.0.1");
    };
    attempt(opts.port, 10);
  });
  guardRef.current = new RequestGuard(port, token);

  return {
    server,
    port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

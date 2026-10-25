import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const TOKEN_HEADER = "x-cs2t-token";
export const MAX_BODY_BYTES = 16 * 1024;

export type GuardResult = { ok: true } | { ok: false; status: number; code: string };

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Request guard for a loopback-only service. Defends against the realistic local threats:
 *  - DNS rebinding            → Host header must be exactly the loopback name:port we listen on;
 *  - cross-site requests      → Origin (when present) must equal our own origin;
 *  - blind CSRF               → every /api call needs a per-run secret token the page receives only
 *                               in its own HTML (other sites cannot read it: no CORS headers are sent);
 *  - simple-request CSRF      → state-changing calls must be `application/json`.
 */
export class RequestGuard {
  private readonly hosts: Set<string>;
  private readonly origins: Set<string>;
  private readonly tokenBuf: Buffer;

  constructor(
    port: number,
    token: string,
  ) {
    const names = ["127.0.0.1", "localhost", "[::1]"];
    this.hosts = new Set(names.map((n) => `${n}:${port}`));
    this.origins = new Set(names.map((n) => `http://${n}:${port}`));
    this.tokenBuf = Buffer.from(token);
  }

  checkHost(req: IncomingMessage): GuardResult {
    const host = req.headers.host?.toLowerCase();
    if (!host || !this.hosts.has(host)) return { ok: false, status: 421, code: "bad-host" };
    const origin = req.headers.origin;
    if (origin !== undefined && !this.origins.has(origin.toLowerCase())) return { ok: false, status: 403, code: "bad-origin" };
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none") return { ok: false, status: 403, code: "cross-site" };
    return { ok: true };
  }

  checkApi(req: IncomingMessage): GuardResult {
    const given = req.headers[TOKEN_HEADER];
    if (typeof given !== "string") return { ok: false, status: 401, code: "missing-token" };
    const buf = Buffer.from(given);
    if (buf.length !== this.tokenBuf.length || !timingSafeEqual(buf, this.tokenBuf)) {
      return { ok: false, status: 401, code: "bad-token" };
    }
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD" && method !== "DELETE") {
      const type = req.headers["content-type"] ?? "";
      if (!/^application\/json(\s*;|$)/i.test(type)) return { ok: false, status: 415, code: "json-required" };
    }
    return { ok: true };
  }
}

/** Fixed-window limiter per key. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const t = this.now();
    const slot = this.hits.get(key);
    if (!slot || slot.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      return true;
    }
    slot.count++;
    return slot.count <= this.limit;
  }
}

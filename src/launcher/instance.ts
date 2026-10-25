import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

export interface InstanceInfo {
  pid: number;
  port: number;
  version: string;
  startedAt: number;
  /** Which build of dist/ this server was started from (see build.ts); empty for servers older than this field. */
  buildId?: string;
  /** Random per run; the running server must report the same value, so an open port alone is never trusted. */
  instanceId?: string;
}

/** What a running copy of this app reports on /health. */
export interface HealthInfo {
  instanceId?: string;
  buildId?: string;
  /** A message is prepared and not yet cleared: closing the server would drop it. */
  hasPrepared?: boolean;
}

const INSTANCE_FILE = "instance.json";
const LOCK_FILE = "launcher.lock";

export const instanceFile = (dir: string) => path.join(dir, INSTANCE_FILE);

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function writeInstance(dir: string, info: InstanceInfo): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(instanceFile(dir), JSON.stringify(info), "utf8");
}

export async function removeInstance(dir: string, pid: number): Promise<void> {
  const current = await readInstance(dir);
  if (current?.pid === pid) await fs.rm(instanceFile(dir), { force: true });
}

export async function readInstance(dir: string): Promise<InstanceInfo | null> {
  try {
    const v = JSON.parse(await fs.readFile(instanceFile(dir), "utf8")) as Partial<InstanceInfo>;
    if (typeof v.pid === "number" && typeof v.port === "number" && v.port > 0 && v.port < 65536) {
      return { pid: v.pid, port: v.port, version: String(v.version ?? ""), startedAt: Number(v.startedAt ?? 0), buildId: String(v.buildId ?? ""), ...(typeof v.instanceId === "string" ? { instanceId: v.instanceId } : {}) };
    }
  } catch {
    /* missing or corrupt */
  }
  return null;
}

/** The health payload when the answer comes from OUR service (another program will not send this exact shape), else null. */
export function fetchHealth(port: number, timeoutMs = 1500): Promise<HealthInfo | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: timeoutMs, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c.slice(0, 512)));
      res.on("end", () => {
        try {
          const v = JSON.parse(body) as HealthInfo & { app?: string };
          resolve(res.statusCode === 200 && v.app === "cs2-chat-translator" ? v : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

export async function probeHealth(port: number, timeoutMs = 1500): Promise<boolean> {
  return (await fetchHealth(port, timeoutMs)) !== null;
}

/**
 * A running, healthy instance recorded for this user, with what it reports about itself, or null.
 * Three things must agree: the recorded process is alive, the port answers like this app, and (when the record has
 * one) the answer carries the same instance id. A different program on that port cannot pass all three.
 */
export async function findRunningWithHealth(dir: string): Promise<{ info: InstanceInfo; health: HealthInfo } | null> {
  const info = await readInstance(dir);
  if (!info || !isProcessAlive(info.pid)) return null;
  const health = await fetchHealth(info.port);
  if (!health) return null;
  if (info.instanceId && health.instanceId !== info.instanceId) return null;
  return { info, health };
}

export async function findRunning(dir: string): Promise<InstanceInfo | null> {
  return (await findRunningWithHealth(dir))?.info ?? null;
}

/**
 * Cross-process start-up lock, so two quick double-clicks cannot launch two servers.
 * Returns a release function, or null when another live launcher holds the lock.
 */
export async function acquireLock(dir: string): Promise<(() => Promise<void>) | null> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await fs.open(file, "wx");
      await fh.writeFile(String(process.pid));
      await fh.close();
      return () => fs.rm(file, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = Number(await fs.readFile(file, "utf8").catch(() => "0"));
      if (isProcessAlive(holder) && holder !== process.pid) return null;
      await fs.rm(file, { force: true }); // stale lock from a crashed launcher
    }
  }
  return null;
}

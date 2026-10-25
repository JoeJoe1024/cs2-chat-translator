import type { ServerResponse } from "node:http";
import type { ServerEvent } from "../shared/protocol";

const MAX_CLIENTS = 8;
const HEARTBEAT_MS = 15_000;

/** Server-Sent Events fan-out. Clients are loopback browser tabs; the count is capped defensively. */
export class EventHub {
  private readonly clients = new Set<ServerResponse>();
  private readonly timer: NodeJS.Timeout;

  constructor() {
    this.timer = setInterval(() => this.broadcastRaw(":hb\n\n"), HEARTBEAT_MS);
    this.timer.unref();
  }

  get clientCount(): number {
    return this.clients.size;
  }

  add(res: ServerResponse): boolean {
    if (this.clients.size >= MAX_CLIENTS) return false;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 2000\n\n");
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
    return true;
  }

  emit(event: ServerEvent): void {
    this.broadcastRaw(`data: ${JSON.stringify(event)}\n\n`);
  }

  private broadcastRaw(chunk: string): void {
    for (const res of this.clients) {
      try {
        res.write(chunk);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  close(): void {
    clearInterval(this.timer);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}

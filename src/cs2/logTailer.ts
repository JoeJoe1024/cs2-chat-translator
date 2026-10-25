import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { WatcherStatus } from "../shared/protocol";

type TailerEvents = {
  line: [string];
  status: [WatcherStatus];
  /** The file was re-created or truncated (new game session). */
  reset: [];
};

const MAX_READ_PER_TICK = 4 * 1024 * 1024;
const MAX_PENDING_LINE = 64 * 1024;

/**
 * Follows a growing text file (CS2 `console.log`) by polling.
 *  - starts at the END of the file, so history from earlier sessions is never replayed;
 *  - survives truncation, deletion and re-creation (game restart);
 *  - only emits complete lines, and decodes UTF-8 across read boundaries so multi-byte
 *    characters are never split.
 */
export class LogTailer extends EventEmitter<TailerEvents> {
  private timer: NodeJS.Timeout | null = null;
  private path = "";
  private offset = 0;
  private identity = "";
  private pending = "";
  private decoder = new StringDecoder("utf8");
  private started = false;
  private running = false;
  private lastStatusKey = "";

  constructor(private readonly intervalMs = 250) {
    super();
  }

  start(logPath: string): void {
    this.stop();
    this.path = logPath;
    this.started = false;
    this.offset = 0;
    this.identity = "";
    this.pending = "";
    this.decoder = new StringDecoder("utf8");
    this.lastStatusKey = "";
    if (!logPath) {
      this.setStatus({ state: "idle", logPath, reason: "no-path" });
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private setStatus(status: WatcherStatus): void {
    const key = `${status.state}|${status.reason ?? ""}|${status.logPath}`;
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.emit("status", status);
  }

  /** Exposed for tests: perform one poll. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.poll();
    } finally {
      this.running = false;
    }
  }

  private async poll(): Promise<void> {
    let stat;
    try {
      stat = await fs.stat(this.path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // File missing (game not started / log rotated): wait and begin at 0 once it appears.
      this.started = true;
      this.offset = 0;
      this.identity = "";
      this.pending = "";
      this.setStatus({
        state: code === "ENOENT" || code === "ENOTDIR" ? "waiting" : "error",
        logPath: this.path,
        reason: code === "ENOENT" || code === "ENOTDIR" ? "log-missing" : "read-error",
        detail: code ?? String(err),
      });
      return;
    }

    const identity = `${stat.ino}:${Math.round(stat.birthtimeMs)}`;
    if (!this.started) {
      // First sight of the file: skip history.
      this.started = true;
      this.offset = stat.size;
      this.identity = identity;
    } else if (identity !== this.identity && this.identity !== "") {
      // Re-created file: read it from the start.
      this.offset = 0;
      this.pending = "";
      this.decoder = new StringDecoder("utf8");
      this.identity = identity;
      this.emit("reset");
    } else if (this.identity === "") {
      // Appeared after having been missing: it is new content.
      this.identity = identity;
      this.offset = 0;
      this.emit("reset");
    }

    if (stat.size < this.offset) {
      // Truncated in place.
      this.offset = 0;
      this.pending = "";
      this.decoder = new StringDecoder("utf8");
      this.emit("reset");
    }

    this.setStatus({ state: "watching", logPath: this.path });
    if (stat.size === this.offset) return;

    let fh;
    try {
      fh = await fs.open(this.path, "r");
    } catch (err) {
      this.setStatus({ state: "error", logPath: this.path, reason: "read-error", detail: String((err as Error).message) });
      return;
    }
    try {
      while (this.offset < stat.size) {
        const length = Math.min(stat.size - this.offset, MAX_READ_PER_TICK);
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;
        this.consume(this.decoder.write(buf.subarray(0, bytesRead)));
      }
    } catch (err) {
      this.setStatus({ state: "error", logPath: this.path, reason: "read-error", detail: String((err as Error).message) });
    } finally {
      await fh.close();
    }
  }

  private consume(text: string): void {
    this.pending += text;
    let nl: number;
    while ((nl = this.pending.indexOf("\n")) !== -1) {
      const line = this.pending.slice(0, nl).replace(/\r$/, "");
      this.pending = this.pending.slice(nl + 1);
      if (line) this.emit("line", line);
    }
    if (this.pending.length > MAX_PENDING_LINE) this.pending = this.pending.slice(-MAX_PENDING_LINE);
  }
}

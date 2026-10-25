import { TranslationError } from "./types";

export type Priority = "user" | "chat";

interface Job<T> {
  run: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  enqueuedAt: number;
  /** Chat jobs only: skip (not run) if still waiting after this many ms. 0/undefined = never. */
  staleAfterMs: number;
}

export interface QueueOptions {
  concurrency?: number;
  maxChatBacklog?: number;
  now?: () => number;
}

export interface AddOptions {
  staleAfterMs?: number;
}

/**
 * Bounded FIFO work queue with two priorities. User-initiated translations jump ahead of automatic chat ones.
 * Chat jobs are rejected (never silently dropped) when the backlog is full, and rejected as `stale` when they
 * waited too long: a translation of a message from many seconds ago is worthless in a fast round, and skipping
 * it frees the slot for the newest messages. Only jobs that have NOT started are ever skipped.
 */
export class WorkQueue {
  private readonly lanes: Record<Priority, Job<unknown>[]> = { user: [], chat: [] };
  private active = 0;
  private readonly concurrency: number;
  private readonly maxChatBacklog: number;
  private readonly now: () => number;

  constructor(opts: QueueOptions = {}) {
    this.concurrency = opts.concurrency ?? 2;
    this.maxChatBacklog = opts.maxChatBacklog ?? 40;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.waiting + this.active;
  }

  get waiting(): number {
    return this.lanes.user.length + this.lanes.chat.length;
  }

  get running(): number {
    return this.active;
  }

  add<T>(priority: Priority, run: () => Promise<T>, opts: AddOptions = {}): Promise<T> {
    if (priority === "chat" && this.lanes.chat.length >= this.maxChatBacklog) {
      return Promise.reject(new TranslationError("overloaded", "Translation backlog is full"));
    }
    return new Promise<T>((resolve, reject) => {
      this.lanes[priority].push({
        run,
        resolve: resolve as (v: unknown) => void,
        reject,
        enqueuedAt: this.now(),
        staleAfterMs: priority === "chat" ? (opts.staleAfterMs ?? 0) : 0,
      });
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.concurrency) {
      const job = this.lanes.user.shift() ?? this.lanes.chat.shift();
      if (!job) return;
      if (job.staleAfterMs > 0 && this.now() - job.enqueuedAt > job.staleAfterMs) {
        job.reject(new TranslationError("stale", "Waited too long in the queue"));
        continue;
      }
      this.active++;
      job
        .run()
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }
}

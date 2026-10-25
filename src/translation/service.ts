import type { EngineId } from "../config/schema";
import { Glossary } from "../shared/glossary";
import { normalizeLanguageCode } from "../shared/languages";
import { RequestCache } from "./cache";
import { classifyChat } from "./filter";
import { WorkQueue, type Priority } from "./queue";
import { TranslationError, type TranslationEngine } from "./types";

export const MAX_INPUT_CHARS = 500;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 400;
const DEFAULT_QUOTA_COOLDOWN_MS = 60_000;
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 10_000;
const LATENCY_WINDOW = 50;

export interface TranslateOptions {
  text: string;
  target: string;
  engine: EngineId;
  priority: Priority;
  /** Skip digit / punctuation / emoji-only text before calling any API (default true). */
  smartFilter?: boolean;
  /** Reuse earlier results for identical text (default true). Identical in-flight requests are always merged. */
  useCache?: boolean;
  /** Chat priority only: skip if still queued after this long (0 = never). */
  staleAfterMs?: number;
}

export type TranslateOutcome =
  | { status: "done"; text: string; sourceLanguage?: string; target: string; engine: EngineId | "local"; cached: boolean }
  | { status: "skipped"; reason: "empty" | "not-text" | "same-language"; text: string };

export interface TranslationStats {
  /** Translations waiting for a free slot. */
  waiting: number;
  /** Translations currently being performed by a provider. */
  running: number;
  /** Mean provider round-trip of the most recent successful requests, or null before the first one. */
  avgLatencyMs: number | null;
  cacheHits: number;
  cacheLookups: number;
  /** Answered by the built-in / custom dictionary with no network request. */
  local: number;
  /** Skipped by the smart filter before reaching a provider. */
  filtered: number;
  /** Skipped because they waited too long in the queue. */
  stale: number;
  completed: number;
  failed: number;
}

export interface ServiceDeps {
  engines: Record<EngineId, TranslationEngine>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Per-engine queues. Google and Gemini have separate limits so one slow provider cannot starve the other. */
  queues?: Partial<Record<EngineId, WorkQueue>>;
  timeoutMs?: number;
  onStats?: () => void;
}

type EngineResult = { text: string; sourceLanguage?: string };

/**
 * Orchestrates translations: smart filter, glossary, cache + in-flight merging, a per-engine prioritised queue
 * with a freshness window, per-request timeout, bounded retries, and per-engine cool-downs / circuit breaker so a
 * failing provider fails fast instead of blocking the chat.
 */
export class TranslationService {
  private readonly cache = new RequestCache<EngineResult>();
  private readonly queues: Record<EngineId, WorkQueue>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  /** engine → timestamp until which requests fail fast. */
  private readonly cooldown = new Map<EngineId, { until: number; error: TranslationError }>();
  private readonly consecutiveFailures = new Map<EngineId, number>();
  private readonly latencies: number[] = [];
  private counters = { cacheHits: 0, cacheLookups: 0, local: 0, filtered: 0, stale: 0, completed: 0, failed: 0 };
  private glossary = new Glossary();
  /** Part of every cache key: editing the dictionary makes all earlier translations obsolete at once. */
  private dictionaryVersion = 0;

  constructor(private readonly deps: ServiceDeps) {
    this.queues = {
      // Google's web endpoint tolerates a few parallel requests; Gemini is quota-limited, so keep it lower.
      google: deps.queues?.google ?? new WorkQueue({ concurrency: 3 }),
      gemini: deps.queues?.gemini ?? new WorkQueue({ concurrency: 2 }),
    };
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  get queued(): number {
    return this.queues.google.size + this.queues.gemini.size;
  }

  stats(): TranslationStats {
    const lat = this.latencies;
    return {
      waiting: this.queues.google.waiting + this.queues.gemini.waiting,
      running: this.queues.google.running + this.queues.gemini.running,
      avgLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
      ...this.counters,
    };
  }

  private bump(key: keyof typeof this.counters): void {
    this.counters[key]++;
    this.deps.onStats?.();
  }

  /** Applies a new dictionary immediately: old cached translations (made with the old wording) are dropped. */
  setGlossary(glossary: Glossary): void {
    this.glossary = glossary;
    this.dictionaryVersion++;
    this.cache.clear();
  }

  /** Call after the API key or model changes so a stale `auth` cool-down does not linger. */
  resetEngine(engine: EngineId): void {
    this.cooldown.delete(engine);
    this.consecutiveFailures.delete(engine);
    this.cache.clear();
  }

  async translate(opts: TranslateOptions): Promise<TranslateOutcome> {
    const text = opts.text.replace(/\s+/g, " ").trim().slice(0, MAX_INPUT_CHARS);
    if (!text) return { status: "skipped", reason: "empty", text };

    const target = normalizeLanguageCode(opts.target);
    if (!target) throw new TranslationError("invalid", `Unsupported target language: ${opts.target}`);

    // 1. The dictionary answers common shorthand locally: no network, no queue, no quota. It runs before the smart
    //    filter so a user's own entry for something like "666" still works; GG / NT / ECO have letters anyway.
    const local = this.glossary.translateLocally(text, target);
    if (local) {
      this.bump("local");
      return local.kind === "known"
        ? { status: "skipped", reason: "same-language", text }
        : { status: "done", text: local.text, target, engine: "local", cached: false };
    }

    const skip = classifyChat(text, opts.smartFilter ?? true);
    if (skip) {
      if (skip === "not-text") this.bump("filtered");
      return { status: "skipped", reason: skip, text };
    }

    const cooling = this.cooldown.get(opts.engine);
    if (cooling && cooling.until > this.now()) throw cooling.error;

    // Terms inside a longer sentence: engines that cannot take instructions (Google) get them spelled out in the text,
    // Gemini gets the original plus hints. Ambiguous terms (NC, NP, SAVE, FORCE) are never expanded in a sentence.
    const guarded = this.glossary.protect(text, target);
    const payload = opts.engine === "google" ? guarded.payload : text;
    const key = `${this.dictionaryVersion}|${opts.engine}|${target}|${payload}`;

    const useCache = opts.useCache ?? true;
    let result: EngineResult | undefined;
    let wasCached = false;
    if (useCache) {
      this.counters.cacheLookups++;
      result = this.cache.get(key);
      if (result) {
        wasCached = true;
        this.bump("cacheHits");
      }
    }
    if (!result) {
      try {
        result = await this.cache.dedupe(key, () =>
          this.queues[opts.engine].add(opts.priority, () => this.run(opts.engine, payload, target, guarded.hints), {
            staleAfterMs: opts.staleAfterMs ?? 0,
          }),
        );
      } catch (err) {
        if (err instanceof TranslationError && err.code === "stale") this.bump("stale");
        else this.bump("failed");
        throw err;
      }
      if (useCache) this.cache.set(key, result);
      this.bump("completed");
    }

    // Already in the target language: the engine handed the text back (apart from case, spacing and punctuation),
    // or it reports the source language equal to the target. The reported language is not trusted when the text is
    // visibly written in another script: a throttled Google endpoint was seen answering "en" for Chinese text, and
    // that must not hide a real translation.
    const flat = (v: string) => v.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
    const unchanged = flat(result.text) === flat(text);
    const engineSaysSame = !!result.sourceLanguage && sameLanguage(result.sourceLanguage, target) && !scriptMismatch(text, target);
    if (unchanged || engineSaysSame) {
      return { status: "skipped", reason: "same-language", text };
    }
    return {
      status: "done",
      text: result.text,
      ...(result.sourceLanguage ? { sourceLanguage: result.sourceLanguage } : {}),
      target,
      engine: opts.engine,
      cached: wasCached,
    };
  }

  private async run(engineId: EngineId, text: string, target: string, glossaryHints: string[]): Promise<EngineResult> {
    const engine = this.deps.engines[engineId];
    let lastError: TranslationError | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // A job may have waited in the queue while the provider got rate-limited or went down: do not call it anyway.
      const cooling = this.cooldown.get(engineId);
      if (cooling && cooling.until > this.now()) throw cooling.error;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const started = this.now();
      try {
        const r = await engine.translate({ text, target, signal: controller.signal, glossaryHints });
        this.consecutiveFailures.delete(engineId);
        this.recordLatency(this.now() - started);
        return { text: r.text, ...(r.detectedSource ? { sourceLanguage: r.detectedSource } : {}) };
      } catch (err) {
        lastError = err instanceof TranslationError ? err : new TranslationError("network", (err as Error).message, true);
        if (lastError.code === "quota") {
          this.cooldown.set(engineId, { until: this.now() + (lastError.retryAfterMs ?? DEFAULT_QUOTA_COOLDOWN_MS), error: lastError });
        } else if (lastError.code === "auth" || lastError.code === "model" || lastError.code === "permission") {
          // Do not hammer a provider with a rejected key; cleared by resetEngine() when settings change.
          this.cooldown.set(engineId, { until: this.now() + 10 * 60_000, error: lastError });
        } else if (lastError.code === "network" || lastError.code === "timeout") {
          // Circuit breaker: after a few transient failures in a row, fail fast for a moment instead of letting every
          // queued message spend its own timeout + retries on a provider that is clearly down.
          const n = (this.consecutiveFailures.get(engineId) ?? 0) + 1;
          this.consecutiveFailures.set(engineId, n);
          if (n >= BREAKER_THRESHOLD) {
            this.cooldown.set(engineId, { until: this.now() + BREAKER_COOLDOWN_MS, error: lastError });
            this.consecutiveFailures.delete(engineId);
            break;
          }
        }
        if (!lastError.retryable || attempt === MAX_RETRIES) break;
        await this.sleep(BASE_BACKOFF_MS * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new TranslationError("network", "Unknown translation failure");
  }

  private recordLatency(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > LATENCY_WINDOW) this.latencies.shift();
  }
}

/** `zh-CN` vs `zh` etc.: compare the primary subtag, but keep Chinese variants distinct when both are explicit. */
function sameLanguage(detected: string, target: string): boolean {
  const d = normalizeLanguageCode(detected);
  if (!d) return false;
  if (d === target) return true;
  const base = (c: string) => c.split("-")[0];
  if (base(d) !== base(target)) return false;
  // Google reports plain `zh-CN`/`zh-TW`; treat bare `zh` as the same script family only if target is Chinese.
  return !(d.startsWith("zh") && target.startsWith("zh"));
}

type Script = "latin" | "cjk" | "cyrillic" | "other";

function targetScript(code: string): Script {
  const base = code.toLowerCase().split("-")[0] ?? "";
  if (["zh", "ja", "ko"].includes(base)) return "cjk";
  if (["ru", "uk", "be", "bg", "sr", "mk", "kk", "ky", "mn"].includes(base)) return "cyrillic";
  if (["ar", "fa", "he", "ur", "hi", "bn", "gu", "kn", "ml", "mr", "ne", "pa", "ta", "te", "th", "lo", "km", "my", "si", "ka", "hy", "el"].includes(base)) return "other";
  return "latin";
}

/** The script most of the text's letters belong to, ignoring digits and punctuation. */
function textScript(text: string): Script | null {
  const count = { latin: 0, cjk: 0, cyrillic: 0, other: 0 };
  for (const ch of text) {
    if (/\p{Script=Latin}/u.test(ch)) count.latin++;
    else if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch)) count.cjk++;
    else if (/\p{Script=Cyrillic}/u.test(ch)) count.cyrillic++;
    else if (/\p{L}/u.test(ch)) count.other++;
  }
  const best = (Object.keys(count) as Script[]).reduce((a, b) => (count[b] > count[a] ? b : a), "latin" as Script);
  return count[best] > 0 ? best : null;
}

export function scriptMismatch(text: string, target: string): boolean {
  const have = textScript(text);
  return have !== null && have !== targetScript(target);
}

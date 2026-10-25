import type { EngineId } from "../config/schema";

export interface TranslateRequest {
  text: string;
  /** Target language code, e.g. `en`, `zh-TW`. */
  target: string;
  signal: AbortSignal;
  /** Short hints about game terms found in the text (used by engines that understand instructions). */
  glossaryHints?: string[];
}

export interface TranslateResult {
  text: string;
  /** Source language reported by the engine, if any. */
  detectedSource?: string;
}

export interface TranslationEngine {
  readonly id: EngineId;
  translate(req: TranslateRequest): Promise<TranslateResult>;
}

export type TranslationErrorCode =
  | "network" // transport failure or 5xx
  | "timeout"
  | "auth" // missing / rejected API key
  | "permission" // the key is valid but not allowed to use this model / region / API
  | "model" // the selected model is not available for this key / does not support text generation
  | "quota" // rate limit or quota exhausted
  | "blocked" // provider refused the content
  | "invalid" // malformed provider response
  | "incomplete" // the provider stopped before finishing the reply (e.g. MAX_TOKENS)
  | "overloaded" // local queue is full
  | "stale" // waited in the queue longer than the freshness window; the original chat is kept
  | "cancelled";

export class TranslationError extends Error {
  constructor(
    readonly code: TranslationErrorCode,
    message?: string,
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(message ?? code);
    this.name = "TranslationError";
  }
}

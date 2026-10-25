import type { EngineId } from "../config/schema";
import { TranslationError, type TranslateRequest, type TranslateResult, type TranslationEngine } from "./types";

const ENDPOINT = "https://translate.googleapis.com/translate_a/single";

/**
 * Free Google Translate web endpoint (no key). IMPORTANT: this is an unofficial, undocumented endpoint.
 * It can change, be rate-limited or blocked at any time and its terms do not promise availability.
 * The app treats it as best-effort and offers Gemini as a keyed alternative.
 */
export class GoogleWebEngine implements TranslationEngine {
  readonly id: EngineId = "google";

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async translate({ text, target, signal }: TranslateRequest): Promise<TranslateResult> {
    // The chat text goes in the POST body, not the URL.
    const url = `${ENDPOINT}?${new URLSearchParams({ client: "gtx", sl: "auto", tl: target, dt: "t" })}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ q: text }),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw new TranslationError("timeout", "Google request aborted", true);
      throw new TranslationError("network", (err as Error).message, true);
    }
    if (res.status === 429) throw new TranslationError("quota", "Google rate limit (HTTP 429)", false, retryAfter(res));
    if (res.status >= 500) throw new TranslationError("network", `Google HTTP ${res.status}`, true);
    if (!res.ok) throw new TranslationError("network", `Google HTTP ${res.status}`, false);

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new TranslationError("invalid", "Google returned non-JSON (possibly a block page)");
    }
    return parseGoogle(data);
  }
}

export function parseGoogle(data: unknown): TranslateResult {
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw new TranslationError("invalid", "Unexpected Google response shape");
  const text = (data[0] as unknown[])
    .map((seg) => (Array.isArray(seg) && typeof seg[0] === "string" ? seg[0] : ""))
    .join("");
  if (!text) throw new TranslationError("invalid", "Empty Google translation");
  const detected = typeof data[2] === "string" ? data[2] : undefined;
  return { text, ...(detected ? { detectedSource: detected } : {}) };
}

export function retryAfter(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  const s = h ? Number(h) : NaN;
  return Number.isFinite(s) && s >= 0 ? Math.min(s, 300) * 1000 : undefined;
}

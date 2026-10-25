/**
 * Which Gemini models suit CS2 chat translation, decided by rules (never by a fixed list of versions) so that a model
 * Google releases tomorrow can appear without a new release of this app.
 *
 * Suitable = a STABLE, general text model of the cheap, fast "Flash" or "Flash-Lite" series:
 *   gemini-<major>.<minor>-flash[-lite][-NNN]
 * Models Google is retiring (see RETIRED_GEMINI_MODELS) are left out too, and so is everything else that is not that
 * shape: its id says it is something else or not final: Pro / reasoning-heavy models,
 * `-preview` / `-exp`, live / audio / TTS / image / video / embedding / tools, moving aliases such as `-latest`.
 * The API gives no price or modality field, so an id that does not match this shape is treated as "unknown" and
 * kept out, rather than guessed to be fine.
 */

/** Used for users who never chose a model. Cheap, fast and made for high-volume text. */
export const RECOMMENDED_GEMINI_MODEL = "gemini-3.5-flash-lite";

/** Older series are legacy for this purpose (and are being retired by Google). */
export const MIN_GEMINI_VERSION = 2.5;

export type GeminiTier = "lite" | "flash";

export interface GeminiModelClass {
  tier: GeminiTier;
  version: number;
}

/**
 * Models Google has announced it is retiring and now silently reroutes to another model. models.list still returns
 * them and gives no deprecation field, so they are listed here by hand (last reviewed 2026-10-25). Add an id when
 * Google announces a retirement; nothing else in the app needs to change.
 */
export const RETIRED_GEMINI_MODELS: readonly string[] = ["gemini-3.5-flash", "gemini-3.7-flash"];

export const isRetiredGeminiModel = (id: string): boolean => RETIRED_GEMINI_MODELS.includes(id);

const ID = /^gemini-(\d+(?:\.\d+)?)-flash(-lite)?(?:-\d{3})?$/;

export function classifyGeminiModel(id: string): GeminiModelClass | null {
  if (isRetiredGeminiModel(id)) return null;
  const m = ID.exec(id);
  if (!m) return null;
  const version = Number(m[1]);
  if (!Number.isFinite(version) || version < MIN_GEMINI_VERSION) return null;
  return { tier: m[2] ? "lite" : "flash", version };
}

/** Words in the display name / description that mark a model as not final or not plain text-to-text. */
const NOT_FOR_US = /\b(preview|experimental|exp|deprecated|audio|tts|speech|image|video|live|embedding|robotics|computer use)\b/i;

export function looksUnsuitable(text: string | undefined): boolean {
  return !!text && NOT_FOR_US.test(text);
}

/** Recommended model first, then Flash-Lite (newest first), then Flash (newest first). */
export function sortGeminiModels<T extends { id: string }>(models: readonly T[]): T[] {
  const rank = (id: string): [number, number] => {
    if (id === RECOMMENDED_GEMINI_MODEL) return [0, 0];
    const c = classifyGeminiModel(id);
    if (!c) return [3, 0];
    return [c.tier === "lite" ? 1 : 2, -c.version];
  };
  return [...models].sort((a, b) => {
    const [ta, va] = rank(a.id);
    const [tb, vb] = rank(b.id);
    return ta - tb || va - vb || a.id.localeCompare(b.id);
  });
}

/** What to suggest when the chosen model is not available: the recommended one, else the newest Flash-Lite, else Flash. */
export function suggestGeminiModel(availableIds: readonly string[], exclude?: string): string | null {
  const ids = availableIds.filter((id) => id !== exclude);
  return sortGeminiModels(ids.map((id) => ({ id })))[0]?.id ?? null;
}

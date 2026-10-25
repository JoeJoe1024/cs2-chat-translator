export type SkipReason = "empty" | "not-text";

/** Digits, punctuation, symbols, emoji, separators and joiners only. Letters of ANY script are "text". */
const NO_LETTERS = /^[\p{N}\p{P}\p{S}\p{Z}\p{M}\p{Cf}\p{Extended_Pictographic}\s]+$/u;

/**
 * Decides, BEFORE any API request, whether a chat line is worth translating.
 *
 * Skipped (smart filter on): `666`, `123456`, `!!!!!!`, `?????`, emoji-only or repeated emoji.
 * Always kept: anything containing a letter, so `2 A 1 B`, `1v3`, `30 hp`, `rush B`, `low`, `go`, `gg`, `nt`,
 * `eco`, `哈哈哈哈`, `ｗｗｗ` are translated. When in doubt the answer is "translate".
 * With the filter off only an empty message is skipped.
 */
export function classifyChat(text: string, smartFilter: boolean): SkipReason | null {
  const t = text.trim();
  if (!t) return "empty";
  if (smartFilter && NO_LETTERS.test(t)) return "not-text";
  return null;
}

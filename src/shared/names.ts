/**
 * CS2 writes invisible direction marks around player names (for example U+200E after the name in the Chinese chat
 * format). They are not part of the name, so they must never decide whether two names are "the same player".
 */
// eslint-disable-next-line no-irregular-whitespace
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** The name as a person reads it: no invisible formatting characters, no surrounding spaces. */
export function cleanName(name: string): string {
  return name.replace(INVISIBLE, "").trim();
}

/** Case-insensitive comparison of two display names after cleaning. Exact, never a substring match ("Joe" ≠ "Joe2"). */
export function sameName(a: string, b: string): boolean {
  return cleanName(a).toLowerCase() === cleanName(b).toLowerCase();
}

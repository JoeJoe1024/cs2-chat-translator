import { BUILTIN_ENTRIES, type BuiltinEntry } from "./glossaryData";
import { normalizeLanguageCode } from "./languages";

/** A phrase the user added or re-worded. `lang` is a target language code, or `*` for every target. */
export interface CustomEntry {
  id: string;
  term: string;
  translation: string;
  lang: string;
}

export interface DictionarySettings {
  /** Master switch. Off = nothing is translated locally and nothing is expanded. */
  enabled: boolean;
  /** Built-in entry ids the user switched off. */
  disabled: string[];
  /** The user's own wording. It always wins over the built-in wording for the same term. */
  custom: CustomEntry[];
}

export const DEFAULT_DICTIONARY: DictionarySettings = { enabled: true, disabled: [], custom: [] };

/** Words are runs of letters / digits / underscore, so `eggs` never contains `gg` and punctuation never glues words. */
const WORD = /[\p{L}\p{N}_]+/gu;

function wordsOf(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? []) as string[];
}

interface Token {
  word: string;
  start: number;
  end: number;
}

function tokenize(text: string): Token[] {
  return [...text.matchAll(WORD)].map((m) => ({ word: m[0].toLowerCase(), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
}

interface Phrase {
  words: string[];
  builtin?: BuiltinEntry;
  custom?: CustomEntry[];
}

export interface Match {
  /** Index of the first / last token covered. */
  from: number;
  to: number;
  start: number;
  end: number;
  phrase: Phrase;
}

export type LocalResult =
  | { kind: "translated"; text: string }
  /** The message is only shorthand that the target language's readers already know (e.g. GG for English). */
  | { kind: "known" };

export interface Protected {
  /** The text a general translator should receive (terms spelled out); `original` when nothing applied. */
  payload: string;
  /** `term = meaning` lines for engines that accept instructions. */
  hints: string[];
  changed: boolean;
}

const JOIN_ZH = "，";
const JOIN_JA = "、";

/**
 * The single glossary: built-in vocabulary + the user's edits.
 *  - `translateLocally` answers a whole message with no network at all;
 *  - `protect` spells terms out inside a longer sentence so a general translator gets them right.
 * Matching is case-insensitive, whole-word only, and the longest phrase wins ("rush b" before "rush").
 */
export class Glossary {
  private readonly index = new Map<string, Phrase[]>();
  readonly enabled: boolean;

  constructor(settings: DictionarySettings = DEFAULT_DICTIONARY) {
    this.enabled = settings.enabled;
    if (!settings.enabled) return;
    const byWords = new Map<string, Phrase>();
    const add = (words: string[]) => {
      const key = words.join(" ");
      let phrase = byWords.get(key);
      if (!phrase) {
        phrase = { words };
        byWords.set(key, phrase);
        const bucket = this.index.get(words[0]!) ?? [];
        bucket.push(phrase);
        bucket.sort((a, b) => b.words.length - a.words.length); // longer phrases first
        this.index.set(words[0]!, bucket);
      }
      return phrase;
    };
    const off = new Set(settings.disabled);
    for (const entry of BUILTIN_ENTRIES) {
      if (off.has(entry.id)) continue;
      for (const term of entry.terms) {
        const words = wordsOf(term);
        if (words.length) add(words).builtin = entry;
      }
    }
    for (const c of settings.custom) {
      const words = wordsOf(c.term);
      if (words.length && c.translation.trim()) (add(words).custom ??= []).push(c);
    }
  }

  /** Greedy, left-to-right, longest-phrase-first matches over the message's words. */
  matches(text: string): { tokens: Token[]; found: Match[] } {
    const tokens = tokenize(text);
    const found: Match[] = [];
    for (let i = 0; i < tokens.length; ) {
      const candidates = this.index.get(tokens[i]!.word);
      const hit = candidates?.find((p) => p.words.every((w, k) => tokens[i + k]?.word === w));
      if (hit) {
        const last = i + hit.words.length - 1;
        found.push({ from: i, to: last, start: tokens[i]!.start, end: tokens[last]!.end, phrase: hit });
        i = last + 1;
      } else i++;
    }
    return { tokens, found };
  }

  /** The user's wording for `target` (a specific language beats `*`), or null. */
  private custom(phrase: Phrase, target: string): string | null {
    const list = phrase.custom ?? [];
    return (list.find((c) => c.lang === target) ?? list.find((c) => c.lang === "*"))?.translation.trim() ?? null;
  }

  /** What to show for one phrase in `target`, or null when we have no wording for that language. */
  private render(phrase: Phrase, target: string): { text: string; known: boolean } | null {
    const mine = this.custom(phrase, target);
    if (mine) return { text: mine, known: false };
    const b = phrase.builtin;
    if (!b) return null;
    if (target === "en") return { text: b.en, known: !b.showInEnglish };
    const local = (b.tr as Record<string, string | undefined>)[target];
    return local ? { text: local, known: false } : null;
  }

  /**
   * Translates the WHOLE message locally when every word is a known term and we have wording for the target language.
   * Anything else (unknown words, a language without wording) returns null and goes to the normal translation service.
   */
  translateLocally(text: string, target: string): LocalResult | null {
    if (!this.enabled) return null;
    const code = normalizeLanguageCode(target);
    if (!code) return null;
    const { tokens, found } = this.matches(text);
    if (tokens.length === 0 || found.length === 0) return null;
    if (found.reduce((n, m) => n + (m.to - m.from + 1), 0) !== tokens.length) return null; // some words are not terms

    const parts: string[] = [];
    let allKnown = true;
    for (const m of found) {
      const r = this.render(m.phrase, code);
      if (!r) return null;
      parts.push(r.text);
      allKnown &&= r.known;
    }
    if (allKnown) return { kind: "known" };

    const joiner = code.startsWith("zh") ? JOIN_ZH : code === "ja" ? JOIN_JA : ", ";
    const tail = /[!?.~…！？。]+\s*$/u.exec(text)?.[0].trim() ?? "";
    const out = parts.join(joiner) + tail;
    // Same words back (e.g. "rush B" → "rush B"): nothing to add.
    if (out.replace(/\s+/g, " ").toLowerCase() === text.replace(/\s+/g, " ").trim().toLowerCase()) return { kind: "known" };
    return { kind: "translated", text: out };
  }

  /**
   * For a message that mixes terms with ordinary words: spell the unambiguous terms out in English inside the text
   * (general translators handle English well) and list them as hints. Ambiguous terms (NC, NP, SAVE, FORCE) are left
   * alone unless the user gave their own wording. Only whole words are touched; the original message is never altered.
   */
  protect(text: string, target: string): Protected {
    if (!this.enabled) return { payload: text, hints: [], changed: false };
    const code = normalizeLanguageCode(target) ?? target;
    const { found } = this.matches(text);
    let payload = "";
    let cursor = 0;
    const hints = new Set<string>();
    for (const m of found) {
      const mine = this.custom(m.phrase, code);
      const meaning = mine ?? (m.phrase.builtin && !m.phrase.builtin.ambiguous ? m.phrase.builtin.en : null);
      // Nothing to spell out when the meaning is the very same word ("please" → "please").
      if (!meaning || meaning.toLowerCase() === text.slice(m.start, m.end).toLowerCase()) continue;
      payload += text.slice(cursor, m.start) + meaning;
      cursor = m.end;
      hints.add(`${text.slice(m.start, m.end)} = ${meaning}`);
    }
    if (cursor === 0 && hints.size === 0) return { payload: text, hints: [], changed: false };
    return { payload: payload + text.slice(cursor), hints: [...hints], changed: true };
  }
}

/** Validates user dictionary input before it is saved (also used by the settings page). */
export function validateCustomEntry(term: string, translation: string): "empty-term" | "empty-translation" | "term-too-long" | "translation-too-long" | "no-words" | null {
  if (!term.trim()) return "empty-term";
  if (!translation.trim()) return "empty-translation";
  if (term.length > 40) return "term-too-long";
  if (translation.length > 200) return "translation-too-long";
  if (wordsOf(term).length === 0) return "no-words";
  return null;
}

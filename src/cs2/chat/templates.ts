import { cleanName } from "../../shared/names";
import type { ChatChannel } from "../../shared/protocol";

/** `Cstrike_Chat_*` localization tokens: token name → raw template, e.g. ` [CT] \x03%s1: \x01%s2`. */
export type TokenMap = Record<string, string>;

export interface ChatTemplate {
  /** Localization token, e.g. `Cstrike_Chat_CT_Loc`, or `manual:ct`. */
  token: string;
  language: string;
  channel: ChatChannel;
  dead: boolean;
  /** Number of literal (non-placeholder) characters; more literals = more specific. */
  specificity: number;
  regex: RegExp;
}

export interface ChatMatch {
  template: ChatTemplate;
  name: string;
  text: string;
  location?: string;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Colour codes (\x01–\x08) and other control bytes carry no meaning for parsing; drop them from lines and templates alike. */
export function stripControl(s: string): string {
  return s.replace(CONTROL_CHARS, "");
}

const TIMESTAMP = String.raw`^(?:\d{2}/\d{2} \d{2}:\d{2}:\d{2}\s+)?`;
const MAX_LINE = 2000;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Token name → channel / dead flag, following the game's own naming scheme. */
export function classifyToken(token: string): { channel: ChatChannel; dead: boolean } | null {
  if (!token.startsWith("Cstrike_Chat_")) return null;
  const rest = token.slice("Cstrike_Chat_".length);
  const dead = /Dead|Spec/.test(rest);
  if (/^CT(_|$)/.test(rest)) return { channel: "ct", dead };
  if (/^T(_|$)/.test(rest)) return { channel: "t", dead };
  if (/^All/.test(rest)) return { channel: "all", dead };
  if (/^Spec/.test(rest)) return { channel: "spec", dead: true };
  return null;
}

/**
 * Compiles one localization template into a matcher.
 * `%s1` = player name, `%s2` = message, `%s3` = map location; every other character is literal
 * and any run of whitespace matches loosely (the game's spacing differs between languages).
 */
export function compileTemplate(token: string, language: string, raw: string): ChatTemplate | null {
  const kind = classifyToken(token);
  if (!kind) return null;
  const cleaned = stripControl(raw).trim();
  if (!cleaned.includes("%s1") || !cleaned.includes("%s2")) return null;

  let literal = 0;
  const body = cleaned
    .split(/(%s\d)/)
    .map((part) => {
      switch (part) {
        case "%s1":
          return "(?<name>.+?)";
        case "%s2":
          return "(?<text>.*)";
        case "%s3":
          return "(?<loc>.+?)";
        default: {
          const compact = part.replace(/\s+/g, " ");
          literal += compact.replace(/ /g, "").length;
          return escapeRegex(compact).replace(/ /g, String.raw`\s*`);
        }
      }
    })
    .join("");

  return {
    token,
    language,
    ...kind,
    specificity: literal,
    regex: new RegExp(`${TIMESTAMP}${body}\\s*$`, "u"),
  };
}

export function compileTokenMap(language: string, tokens: TokenMap): ChatTemplate[] {
  const out: ChatTemplate[] = [];
  for (const [token, raw] of Object.entries(tokens)) {
    const t = compileTemplate(token, language, raw);
    if (t) out.push(t);
  }
  return out;
}

/**
 * Matches `line` against all templates and returns the interpretation with the SHORTEST player name.
 * Chat text is attacker-controlled: a message such as `hi [DEAD]: x` must not be able to turn the
 * sender into `Bob: hi` just because a more elaborate template also fits.
 */
export function matchTemplates(templates: readonly ChatTemplate[], rawLine: string): ChatMatch | null {
  const line = stripControl(rawLine.length > MAX_LINE ? rawLine.slice(0, MAX_LINE) : rawLine).trimEnd();
  let best: ChatMatch | null = null;
  for (const template of templates) {
    const m = template.regex.exec(line);
    const g = m?.groups;
    if (!g || g.name === undefined || g.text === undefined) continue;
    const name = cleanName(g.name);
    if (!name) continue;
    const loc = g.loc ? cleanName(g.loc) : "";
    const cand: ChatMatch = { template, name, text: g.text.trim(), ...(loc ? { location: loc } : {}) };
    if (
      !best ||
      name.length < best.name.length ||
      (name.length === best.name.length && template.specificity > best.template.specificity)
    ) {
      best = cand;
    }
  }
  return best;
}

export interface ManualTags {
  ct: string;
  t: string;
  all: string;
}

/** User-typed tags, used only when the user explicitly switches the detector to manual mode. */
export function manualTemplates(tags: ManualTags): ChatTemplate[] {
  const out: ChatTemplate[] = [];
  const entries: [ChatChannel, string][] = [["ct", tags.ct], ["t", tags.t], ["all", tags.all]];
  for (const [channel, tag] of entries) {
    const body =
      String.raw`\[${escapeRegex(tag)}\]\s*(?<name>.+?)` +
      String.raw`(?:\s*[﹫@＠]\s*(?<loc>[^:：]*?))?\s*[:：]\s*(?<text>.*)\s*$`;
    out.push({
      token: `manual:${channel}`,
      language: "manual",
      channel,
      dead: false,
      specificity: tag.length + 2,
      regex: new RegExp(`${TIMESTAMP}${body}`, "u"),
    });
  }
  return out;
}

/**
 * For diagnostics only: a bracketed, non-lowercase tag followed by `name:` looks like a chat line in a
 * format we do not know. Subsystem lines such as `[Client]` contain lowercase letters and are ignored.
 */
export function unknownChatTag(rawLine: string): string | null {
  const line = stripControl(rawLine.length > MAX_LINE ? rawLine.slice(0, MAX_LINE) : rawLine);
  const m = /^(?:\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\s+)?\s*\[([^\]]{1,24})\]\s+\S.*?[:：]\s*\S/u.exec(line);
  const tag = m?.[1];
  if (!tag || /[a-z]/.test(tag)) return null;
  return tag;
}

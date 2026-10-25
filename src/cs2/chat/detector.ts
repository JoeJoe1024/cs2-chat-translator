import type { ChatChannel, ChatFormatStatus, GameLanguageEvidence } from "../../shared/protocol";
import { BUILTIN_ENGLISH_TOKENS } from "./builtinEnglish";
import type { ChatLocalization } from "./localization";
import {
  compileTokenMap,
  manualTemplates,
  matchTemplates,
  unknownChatTag,
  type ChatTemplate,
  type ManualTags,
} from "./templates";

export interface ParsedChat {
  channel: ChatChannel;
  dead: boolean;
  sender: string;
  location?: string;
  text: string;
  /** `<language>:<token>` of the template that matched. */
  formatId: string;
}

export interface DetectorConfig {
  mode: "auto" | "manual";
  manual: ManualTags;
  /** Language ids with the evidence that backs them, strongest first. */
  evidence: GameLanguageEvidence[];
}

const PROMOTE_AFTER = 3;
const MAX_UNRECOGNIZED = 20;

/** `schinese_pw` is a variant of `schinese`; both belong to one language group. */
const group = (lang: string) => lang.replace(/_pw$/, "");

/**
 * Turns console.log lines into chat messages without any user-entered tags.
 *
 * Priority (strongest first):
 *   1. chat lines actually seen in the log: a language whose templates keep matching real chat
 *      replaces a wrong language guess;
 *   2. the game language indicated by log / launch option / Steam;
 *   3. English, then every other language shipped with the game.
 * In manual mode only the tags the user typed are used. Lines that match nothing are ignored, never guessed.
 */
export class ChatFormatDetector {
  private mode: "auto" | "manual" = "auto";
  private manual: ChatTemplate[] = [];
  private sets = new Map<string, ChatTemplate[]>();
  private order: string[] = [];
  private primary: string | null = null;
  private evidence: GameLanguageEvidence[] = [];
  private templateSource: ChatFormatStatus["templateSource"] = "builtin-english";
  private readonly matched = new Map<string, { formatId: string; language: string; count: number }>();
  private readonly observedLanguages = new Map<string, number>();
  private readonly unrecognized = new Map<string, number>();
  private primaryMatches = 0;
  private generation = 0;
  private background: Promise<void> = Promise.resolve();

  constructor(
    private localization: ChatLocalization | null,
    private readonly onChange: () => void = () => undefined,
  ) {}

  setLocalization(localization: ChatLocalization | null): void {
    this.localization = localization;
  }

  async configure(config: DetectorConfig): Promise<void> {
    const generation = ++this.generation;
    this.mode = config.mode;
    this.evidence = config.evidence;
    this.manual = manualTemplates(config.manual);
    this.matched.clear();
    this.observedLanguages.clear();
    this.unrecognized.clear();
    this.primaryMatches = 0;
    if (config.mode === "manual") {
      this.templateSource = "manual";
      this.onChange();
      return;
    }

    this.sets = new Map();
    this.primary = config.evidence[0]?.language ?? null;
    let loaded = false;
    if (this.localization) {
      const first = [...new Set([this.primary, "english"].filter((l): l is string => !!l))];
      loaded = await this.loadLanguages(first, generation);
      if (generation !== this.generation) return;
    }
    if (!loaded || !this.sets.has("english")) {
      this.sets.set("english", compileTokenMap("english", BUILTIN_ENGLISH_TOKENS));
      this.templateSource = loaded ? "game-files" : "builtin-english";
    } else {
      this.templateSource = "game-files";
    }
    this.rebuildOrder();
    this.onChange();

    this.background = this.localization ? this.loadRest(generation) : Promise.resolve();
  }

  /** Resolves when templates for all installed languages have been loaded (they load in the background). */
  whenFullyLoaded(): Promise<void> {
    return this.background;
  }

  private async loadLanguages(languages: string[], generation: number): Promise<boolean> {
    if (!this.localization) return false;
    let any = false;
    for (const lang of languages) {
      for (const id of lang === "schinese" ? ["schinese", "schinese_pw"] : [lang]) {
        try {
          const tokens = await this.localization.tokensFor(id);
          if (generation !== this.generation) return any;
          if (tokens) {
            this.sets.set(id, compileTokenMap(id, tokens));
            any = true;
          }
        } catch {
          /* unreadable pack: fall back to what we have */
        }
      }
    }
    return any;
  }

  private async loadRest(generation: number): Promise<void> {
    if (!this.localization) return;
    try {
      const rest = (await this.localization.availableLanguages()).filter((l) => !this.sets.has(l));
      await this.loadLanguages(rest, generation);
      if (generation !== this.generation) return;
      this.rebuildOrder();
      this.onChange();
    } catch {
      /* optional background work */
    }
  }

  private rebuildOrder(): void {
    const primaryGroup = this.primary ? group(this.primary) : null;
    const rank = (lang: string) => (primaryGroup && group(lang) === primaryGroup ? 0 : group(lang) === "english" ? 1 : 2);
    this.order = [...this.sets.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }

  parse(line: string): ParsedChat | null {
    if (!line.includes(":") && !line.includes("：")) return null;

    if (this.mode === "manual") {
      const m = matchTemplates(this.manual, line);
      return m ? this.toParsed(m, null) : null;
    }

    for (const lang of this.order) {
      const m = matchTemplates(this.sets.get(lang) ?? [], line);
      if (m) return this.toParsed(m, lang);
    }
    const tag = unknownChatTag(line);
    if (tag) {
      if (this.unrecognized.size < MAX_UNRECOGNIZED || this.unrecognized.has(tag)) {
        this.unrecognized.set(tag, (this.unrecognized.get(tag) ?? 0) + 1);
      }
    }
    return null;
  }

  private toParsed(m: ReturnType<typeof matchTemplates> & object, lang: string | null): ParsedChat {
    const language = lang ?? "manual";
    const formatId = `${language}:${m.template.token}`;
    const entry = this.matched.get(formatId) ?? { formatId, language, count: 0 };
    entry.count++;
    this.matched.set(formatId, entry);

    if (lang) this.trackLanguage(lang);
    return {
      channel: m.template.channel,
      dead: m.template.dead,
      sender: m.name,
      ...(m.location ? { location: m.location } : {}),
      text: m.text,
      formatId,
    };
  }

  /** Real chat beats a language guess: promote a language that keeps matching while the primary does not. */
  private trackLanguage(lang: string): void {
    if (this.primary && group(lang) === group(this.primary)) {
      this.primaryMatches++;
      return;
    }
    if (group(lang) === "english" && !this.primary) return;
    const seen = (this.observedLanguages.get(group(lang)) ?? 0) + 1;
    this.observedLanguages.set(group(lang), seen);
    if (seen >= PROMOTE_AFTER && seen > this.primaryMatches) {
      this.primary = lang;
      this.primaryMatches = seen;
      this.evidence = [
        { language: lang, source: "console-log", detail: "observed in real chat lines" },
        ...this.evidence.filter((e) => group(e.language) !== group(lang)),
      ];
      this.rebuildOrder();
      this.onChange();
    }
  }

  status(): ChatFormatStatus {
    return {
      mode: this.mode,
      activeLanguages: this.mode === "manual" ? [] : this.order.filter((l) => group(l) === group(this.primary ?? "english") || l === "english"),
      detectedLanguage: this.mode === "manual" ? null : this.primary,
      evidence: this.evidence,
      templateSource: this.templateSource,
      matched: [...this.matched.values()].sort((a, b) => b.count - a.count).slice(0, 12),
      unrecognized: [...this.unrecognized].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count).slice(0, 8),
    };
  }
}

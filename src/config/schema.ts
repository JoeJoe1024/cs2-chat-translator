import { z } from "zod";
import { CHAT_FONT_DEFAULT, CHAT_FONT_MAX, CHAT_FONT_MIN, CHAT_VIEWS } from "../shared/chatView";
import { RIGHT_PCT_MAX, RIGHT_PCT_MIN } from "../shared/layout";
import { UI_LANGUAGES } from "../shared/uiLocales";
import { RECOMMENDED_GEMINI_MODEL } from "../shared/gemini";
import { QUICK_LANGUAGES_MAX, QUICK_PHRASES_MAX } from "../shared/quick";
import { normalizeLanguageCode } from "../shared/languages";

const languageCode = z
  .string()
  .transform((v, ctx) => {
    const code = normalizeLanguageCode(v);
    if (!code) {
      ctx.addIssue({ code: "custom", message: "Unsupported language code" });
      return z.NEVER;
    }
    return code;
  });

/** A chat tag typed by the user, e.g. `CT`, `反恐小組`. Brackets are added by the matcher. */
const manualTag = z
  .string()
  .trim()
  .min(1)
  .max(24)
  .refine((v) => ![...v].some((ch) => ch === "[" || ch === "]" || ch.charCodeAt(0) < 32), "Tag must not contain brackets or control characters");

export const ENGINE_IDS = ["google", "gemini"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

export const THEMES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEMES)[number];

export { UI_LANGUAGES };

/** CFG file name that the in-game bind `exec`s. Restricted so it can never escape the cfg directory. */
export const cfgFileName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,40}\.cfg$/, "Use letters, digits, _ or - and end with .cfg");

/** CS2 key name used in `bind <key> "exec file.cfg"`. */
export const bindKey = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{1,24}$/, "Use a CS2 key name such as kp_plus, f8 or mouse4");

/** A file-system path typed or picked by the user. No control characters; validity is checked when it is used. */
const pathText = z
  .string()
  .trim()
  .max(500)
  .refine((v) => ![...v].some((ch) => ch.charCodeAt(0) < 32), "Path must not contain control characters");

const customEntry = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  term: z.string().trim().min(1).max(40),
  translation: z.string().trim().min(1).max(200),
  /** `*` = every target language. */
  lang: z.union([z.literal("*"), languageCode]).default("*"),
});

const quickPhrase = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  text: z.string().trim().min(1).max(120),
});

export const settingsSchema = z.object({
  general: z
    .object({
      uiLanguage: z.enum(UI_LANGUAGES).default("auto"),
      autoTranslate: z.boolean().default(true),
      /** Translate the local player's own chat lines as well. */
      translateOwnMessages: z.boolean().default(true),
      /** Hide the local player's own chat lines from the chat log (history is kept). Receive side only. */
      hideOwnMessages: z.boolean().default(false),
      /** Skip translating digits / punctuation / emoji-only chat before any API call. */
      smartFilter: z.boolean().default(true),
      /** Reuse earlier translations of identical text. */
      translationCache: z.boolean().default(true),
    })
    .default({
      uiLanguage: "auto",
      autoTranslate: true,
      translateOwnMessages: true,
      hideOwnMessages: false,
      smartFilter: true,
      translationCache: true,
    }),
  translation: z
    .object({
      chatEngine: z.enum(ENGINE_IDS).default("google"),
      sendEngine: z.enum(ENGINE_IDS).default("google"),
      chatTargetLanguage: languageCode.default("en"),
      sendTargetLanguage: languageCode.default("en"),
      geminiModel: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9._-]{1,64}$/)
        .default(RECOMMENDED_GEMINI_MODEL),
      /** Queued chat translations older than this are skipped (0 = never skip). The original chat is never dropped. */
      staleAfterMs: z
        .number()
        .int()
        .refine((v) => v === 0 || (v >= 1000 && v <= 60000), "Use 0 or 1000-60000 ms")
        .default(5000),
    })
    .default({
      chatEngine: "google",
      sendEngine: "google",
      chatTargetLanguage: "en",
      sendTargetLanguage: "en",
      geminiModel: RECOMMENDED_GEMINI_MODEL,
      staleAfterMs: 5000,
    }),
  cs2: z
    .object({
      /** `auto` = detect from Steam libraries; `manual` = use logPath / cfgDir below and never override them. */
      pathMode: z.enum(["auto", "manual"]).default("auto"),
      /** Which detected install to use when several exist (its `game/csgo` folder). Empty = automatic choice. */
      installDir: pathText.default(""),
      logPath: pathText.default(""),
      cfgDir: pathText.default(""),
      cfgFileName: cfgFileName.default("chat_reader.cfg"),
      bindKey: bindKey.default("kp_plus"),
      chatFormat: z
        .object({
          mode: z.enum(["auto", "manual"]).default("auto"),
          manual: z
            .object({ ct: manualTag.default("CT"), t: manualTag.default("T"), all: manualTag.default("ALL") })
            .default({ ct: "CT", t: "T", all: "ALL" }),
          /** Override the detected CS2 language (a Steam language id such as `tchinese`). Empty = auto. */
          gameLanguage: z
            .string()
            .trim()
            .regex(/^[a-z_]{0,24}$/)
            .default(""),
        })
        .default({ mode: "auto", manual: { ct: "CT", t: "T", all: "ALL" }, gameLanguage: "" }),
      /**
       * Names the user confirmed as their own (for the You badge, skipping and hiding own messages).
       * A name detected from Steam is only a suggestion until the user accepts it.
       */
      selfNames: z.array(z.string().trim().min(1).max(64)).max(8).default([]),
    })
    .default({
      pathMode: "auto",
      installDir: "",
      logPath: "",
      cfgDir: "",
      cfgFileName: "chat_reader.cfg",
      bindKey: "kp_plus",
      chatFormat: { mode: "auto", manual: { ct: "CT", t: "T", all: "ALL" }, gameLanguage: "" },
      selfNames: [],
    }),
  /** Game-term dictionary: built-in vocabulary plus the user's edits (see shared/glossary.ts). */
  dictionary: z
    .object({
      enabled: z.boolean().default(true),
      disabled: z.array(z.string().regex(/^[a-z0-9-]{1,40}$/)).max(200).default([]),
      custom: z.array(customEntry).max(300).default([]),
    })
    .default({ enabled: true, disabled: [], custom: [] }),
  /** Quick-communication card under the composer. `phrases: null` means "the built-in list in the UI language". */
  quick: z
    .object({
      phrases: z.array(quickPhrase).max(QUICK_PHRASES_MAX).nullable().default(null),
      languages: z.array(languageCode).max(QUICK_LANGUAGES_MAX).default(["en", "zh-TW", "ja", "ko", "ru", "es"]),
    })
    .default({ phrases: null, languages: ["en", "zh-TW", "ja", "ko", "ru", "es"] }),
  appearance: z
    .object({
      theme: z.enum(THEMES).default("system"),
      chatView: z.enum(CHAT_VIEWS).default("mixed"),
      chatFontSize: z.number().int().min(CHAT_FONT_MIN).max(CHAT_FONT_MAX).default(CHAT_FONT_DEFAULT),
      /** Right column share of the workspace (%), set by dragging the divider. `null` = never set: use the default. */
      rightPct: z.number().min(RIGHT_PCT_MIN).max(RIGHT_PCT_MAX).nullable().default(null),
      rightCollapsed: z.boolean().default(false),
    })
    .default({ theme: "system", chatView: "mixed", chatFontSize: CHAT_FONT_DEFAULT, rightPct: null, rightCollapsed: false }),
});

export type Settings = z.infer<typeof settingsSchema>;

type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/**
 * Same shape as the settings, but EVERY field optional and WITHOUT defaults.
 * (Zod 4 applies a field's default even inside `.partial()`, which would make a patch such as `{ cs2: { bindKey } }`
 * silently reset the other cs2 fields: paths, names, file name. Defaults are stripped on purpose.)
 */
function withoutDefaults(schema: z.ZodType): z.ZodType {
  let s: z.ZodType = schema;
  while (s instanceof z.ZodDefault) s = s.unwrap() as z.ZodType;
  if (s instanceof z.ZodObject) {
    const shape: Record<string, z.ZodType> = {};
    for (const [key, field] of Object.entries(s.shape as Record<string, z.ZodType>)) shape[key] = withoutDefaults(field).optional();
    return z.object(shape);
  }
  return s;
}

/** Update accepted by `PUT /api/settings`: only the fields that are present change. */
export type SettingsPatch = DeepPartial<Settings>;
export const settingsPatchSchema = withoutDefaults(settingsSchema) as unknown as z.ZodType<SettingsPatch>;

export function defaultSettings(): Settings {
  return settingsSchema.parse({});
}

export function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  const next = {
    general: { ...current.general, ...patch.general },
    translation: { ...current.translation, ...patch.translation },
    cs2: {
      ...current.cs2,
      ...patch.cs2,
      chatFormat: {
        ...current.cs2.chatFormat,
        ...patch.cs2?.chatFormat,
        manual: { ...current.cs2.chatFormat.manual, ...patch.cs2?.chatFormat?.manual },
      },
    },
    dictionary: { ...current.dictionary, ...patch.dictionary },
    quick: { ...current.quick, ...patch.quick },
    appearance: { ...current.appearance, ...patch.appearance },
  };
  return settingsSchema.parse(next);
}

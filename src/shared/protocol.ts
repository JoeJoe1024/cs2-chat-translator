import type { EngineId, Settings } from "../config/schema";

export type ChatChannel = "all" | "ct" | "t" | "spec";

/** One parsed chat line, sent to the browser immediately (before translation finishes). */
export interface ChatMessage {
  id: string;
  at: number;
  channel: ChatChannel;
  sender: string;
  location?: string;
  /** Sender was dead / spectating when speaking. */
  dead: boolean;
  text: string;
  isSelf: boolean;
  /** Which chat format template matched (for diagnostics). */
  formatId: string;
}

export type TranslationStatus = "pending" | "done" | "skipped" | "failed";

export interface TranslationUpdate {
  id: string;
  status: TranslationStatus;
  text?: string;
  /** Detected source language (ISO-ish) when the engine reports it. */
  sourceLanguage?: string;
  target?: string;
  engine?: EngineId | "local";
  /** Machine-readable reason for `skipped` / `failed`. */
  reason?: string;
}

export interface ChatEntry extends ChatMessage {
  translation: TranslationUpdate;
}

export type WatcherState = "idle" | "waiting" | "watching" | "error";

export interface WatcherStatus {
  state: WatcherState;
  logPath: string;
  /** Human readable reason code, e.g. `log-missing`, `read-error`. */
  reason?: string;
  detail?: string;
}

export interface GameLanguageEvidence {
  language: string;
  source: "console-log" | "launch-option" | "steam-app" | "steam-client" | "manual";
  detail: string;
}

export interface ChatFormatStatus {
  mode: "auto" | "manual";
  /** Languages whose templates are loaded and used for matching. */
  activeLanguages: string[];
  detectedLanguage: string | null;
  evidence: GameLanguageEvidence[];
  /** How the templates were obtained. */
  templateSource: "game-files" | "builtin-english" | "manual";
  /** Templates that matched real chat lines this session. */
  matched: { formatId: string; language: string; count: number }[];
  /** Bracket-tagged lines that look like chat but matched no known template (never shown as chat). */
  unrecognized: { tag: string; count: number }[];
}

/** Real counters from the running translation service (never placeholders). */
export interface TranslationStatsView {
  waiting: number;
  running: number;
  avgLatencyMs: number | null;
  /** Answered by the game-term dictionary with no network request. */
  local: number;
  cacheHits: number;
  cacheLookups: number;
  filtered: number;
  stale: number;
  completed: number;
  failed: number;
}

export interface RuntimeStatus {
  paused: boolean;
  queued: number;
  stats: TranslationStatsView;
}

export type PreparedMode = "translated" | "direct";

/** The one message currently waiting behind the in-game key. Only a successful write ever replaces it. */
export interface CfgPrepared {
  /** Changes with every successful preparation. */
  id: string;
  mode: PreparedMode;
  channel: "all" | "team";
  /** Text lines that will be said, after safe encoding. */
  lines: string[];
  /** What the user typed, when it differs from what will be said (translated mode). */
  original?: string;
  file: string;
  truncated: boolean;
  preparedAt: number;
  /** Logical time of the click that produced it; a later click always wins over an earlier, slower one. */
  clickedAt: number;
  bindCommand: string;
}

export interface PublicSettings extends Settings {
  /**
   * Never contains the key itself.
   * `reenter` = a key is stored but cannot be decrypted in this Windows environment (copied from another PC / account).
   */
  secrets: { geminiKeyConfigured: boolean; geminiKeyState: "configured" | "missing" | "reenter" };
}

export interface InstallCandidate {
  /** The `game/csgo` folder. */
  gameDir: string;
  logPath: string;
  logExists: boolean;
  /** Last write time of console.log, epoch ms. */
  logModifiedAt: number | null;
  selected: boolean;
}

export interface PathsInfo {
  mode: "auto" | "manual";
  /** The paths actually in use. */
  logPath: string;
  logExists: boolean;
  /** True when the chosen file is not named console.log (probably the wrong file). */
  logNameUnusual: boolean;
  cfgDir: string;
  cfgDirExists: boolean;
  cfgDirWritable: boolean;
  steamRoot: string | null;
  candidates: InstallCandidate[];
  /** Several installs exist and the user has not picked one; the newest console.log is used meanwhile. */
  needsChoice: boolean;
  /** Native Windows file / folder dialogs are available. */
  canBrowse: boolean;
}

export type IdentitySource = "manual" | "console-log" | "steam";

export interface IdentityInfo {
  /** Names that count as "me" (manual + confirmed by the game's own log). */
  authorized: string[];
  manual: string[];
  /** Local name from the game's own loopback line (only exists when this PC hosts the game). */
  logConfirmed: string | null;
  /** Steam profile name; a suggestion only until the user accepts it. */
  steam: string | null;
  /** Steam name exists, is not authorised and no name has been confirmed. */
  suggestSteam: boolean;
}

export interface AppState {
  version: string;
  settings: PublicSettings;
  watcher: WatcherStatus;
  format: ChatFormatStatus;
  paths: PathsInfo;
  runtime: RuntimeStatus;
  /** The message currently prepared (null = nothing: the key does nothing). */
  prepared: CfgPrepared | null;
  secureStorage: "dpapi" | "memory-only";
  identity: IdentityInfo;
  history: ChatEntry[];
}

export type ServerEvent =
  | { type: "chat"; message: ChatMessage }
  | { type: "translation"; update: TranslationUpdate }
  | { type: "watcher"; status: WatcherStatus }
  | { type: "format"; status: ChatFormatStatus }
  | { type: "runtime"; status: RuntimeStatus }
  | { type: "cfg"; prepared: CfgPrepared }
  | { type: "cfg-cleared" }
  | { type: "cleared" }
  | { type: "identity"; identity: IdentityInfo }
  | { type: "notice"; level: "info" | "warn" | "error"; code: string; detail?: string };

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createSecretStore, type SecretStore } from "../config/secrets";
import { SettingsStore } from "../config/store";
import type { EngineId, SettingsPatch } from "../config/schema";
import { ChatFormatDetector } from "../cs2/chat/detector";
import { ChatLocalization } from "../cs2/chat/localization";
import { bindCommand, CfgError, neutralizeCfg, writeChatCfg, type SayChannel } from "../cs2/cfgWriter";
import { Glossary } from "../shared/glossary";
import { collectGameLanguageEvidence } from "../cs2/gameLanguage";
import { detectLocalNameInLog, localNameFromLine } from "../cs2/identity";
import { LogTailer } from "../cs2/logTailer";
import { sameName } from "../shared/names";
import { findCs2Installs, isWritableDir, readPersonaNames, type Cs2Install } from "../cs2/steam";
import type {
  AppState,
  CfgPrepared,
  ChatEntry,
  ChatMessage,
  GameLanguageEvidence,
  IdentityInfo,
  InstallCandidate,
  PathsInfo,
  PreparedMode,
  PublicSettings,
  RuntimeStatus,
  TranslationUpdate,
  WatcherStatus,
} from "../shared/protocol";
import { APP_VERSION } from "../shared/version";
import { GeminiEngine } from "../translation/gemini";
import { classifyGeminiModel, sortGeminiModels } from "../shared/gemini";
import { GeminiModelCache, listGeminiModels, type GeminiModelInfo } from "../translation/geminiModels";
import { GoogleWebEngine } from "../translation/google";
import { TranslationService, type TranslateOutcome } from "../translation/service";
import { TranslationError } from "../translation/types";
import { EventHub } from "./events";
import { pickPath, PickerUnsupportedError, type PickKind } from "./picker";

const HISTORY_LIMIT = 200;
const GEMINI_KEY = "gemini-api-key";
const STATS_EMIT_MS = 500;
const FUTURE_TOLERANCE_MS = 2000;

export interface AppOptions {
  configDir: string;
  secrets?: SecretStore;
  /** Test hooks. */
  fetchImpl?: typeof fetch;
  tailer?: LogTailer;
  installs?: Cs2Install[];
  personaNames?: string[];
}

/** A newer preparation already happened; this older, slower one must not overwrite it. */
export class PrepareSupersededError extends Error {
  constructor() {
    super("superseded");
  }
}

export interface PrepareOptions {
  /** When the user clicked. Later clicks always win. */
  clickedAt?: number;
  /** The text the user typed, for display when the prepared text differs (translated mode). */
  original?: string;
}

export interface GeminiModelsView {
  models: GeminiModelInfo[];
  fetchedAt: number | null;
  /** `null` when no list has been loaded yet; otherwise whether the selected model is in the list. */
  selectedAvailable: boolean | null;
  /** Google answered during this run; otherwise `models` is only the last known list. */
  live: boolean;
}

export class App {
  readonly hub = new EventHub();
  readonly settings: SettingsStore;
  readonly secrets: SecretStore;
  readonly tailer: LogTailer;
  readonly translation: TranslationService;
  private readonly detector: ChatFormatDetector;
  private readonly modelCache: GeminiModelCache;

  private installs: Cs2Install[] = [];
  private personaName: string | null = null;
  private logConfirmedName: string | null = null;
  private geminiKey: string | null = null;
  private geminiKeyUnreadable = false;
  private watcher: WatcherStatus = { state: "idle", logPath: "" };
  private paused = false;
  private seq = 0;
  private readonly history: ChatEntry[] = [];
  /** Latest translation request per message, so a slow older result can never overwrite a newer one. */
  private readonly translationSeq = new Map<string, number>();
  private warnedFallback = false;
  private modelsLive = false;
  private localizationDir = "";
  private evidenceTimers: NodeJS.Timeout[] = [];
  private statsTimer: NodeJS.Timeout | null = null;
  private prepared: CfgPrepared | null = null;
  private lastClickedAt = 0;
  /** Serialises cfg writes so two preparations can never interleave on disk. */
  private prepareChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: AppOptions) {
    this.settings = new SettingsStore(opts.configDir);
    this.secrets = opts.secrets ?? createSecretStore(opts.configDir);
    this.tailer = opts.tailer ?? new LogTailer();
    this.modelCache = new GeminiModelCache(opts.configDir);
    this.detector = new ChatFormatDetector(null, () => this.hub.emit({ type: "format", status: this.detector.status() }));
    const fetchImpl = opts.fetchImpl ?? fetch;
    this.translation = new TranslationService({
      engines: {
        google: new GoogleWebEngine(fetchImpl),
        gemini: new GeminiEngine({
          getApiKey: () => this.geminiKey,
          getModel: () => this.settings.get().translation.geminiModel,
          fetchImpl,
        }),
      },
      onStats: () => this.scheduleStatsEmit(),
    });
  }

  // ---------------------------------------------------------------- lifecycle

  async init(): Promise<void> {
    await this.settings.load();
    try {
      const stored = await this.secrets.inspect(GEMINI_KEY);
      this.geminiKey = stored.state === "ready" ? (stored.value ?? null) : null;
      this.geminiKeyUnreadable = stored.state === "unreadable";
    } catch {
      this.geminiKey = null;
    }
    await this.modelCache.load();
    this.translation.setGlossary(new Glossary(this.settings.get().dictionary));
    this.installs = this.opts.installs ?? (await findCs2Installs());
    const steamRoot = this.installs[0]?.steamRoot;
    this.personaName = (this.opts.personaNames ?? (steamRoot ? await readPersonaNames(steamRoot) : []))[0] ?? null;

    this.tailer.on("line", (line) => void this.handleLine(line));
    this.tailer.on("status", (status) => {
      this.watcher = status;
      this.hub.emit({ type: "watcher", status });
    });
    this.tailer.on("reset", () => this.scheduleEvidenceRefresh());
    await this.restartWatcher();
    await this.neutralizeAtStartup();
  }

  async close(): Promise<void> {
    this.tailer.stop();
    await this.neutralizeQuietly();
    for (const t of this.evidenceTimers) clearTimeout(t);
    if (this.statsTimer) clearTimeout(this.statsTimer);
    this.hub.close();
  }

  // ---------------------------------------------------------------- paths & watcher

  /** The install in use: the user's explicit choice, the only one found, or (several, none chosen) the newest log. */
  private activeInstall(): { install: Cs2Install | null; needsChoice: boolean } {
    const chosen = this.settings.get().cs2.installDir;
    const explicit = chosen ? this.installs.find((i) => i.gameDir.toLowerCase() === chosen.toLowerCase()) : undefined;
    if (explicit) return { install: explicit, needsChoice: false };
    if (this.installs.length <= 1) return { install: this.installs[0] ?? null, needsChoice: false };
    const mtime = (i: Cs2Install) => {
      try {
        return fs.statSync(i.logPath).mtimeMs;
      } catch {
        return 0;
      }
    };
    return { install: [...this.installs].sort((a, b) => mtime(b) - mtime(a))[0] ?? null, needsChoice: true };
  }

  /**
   * Manual mode uses exactly what the user chose and is never replaced by detection, even if the path later stops
   * existing (the status then says so). An empty manual field falls back to the detected value for that field only.
   */
  resolvePaths(): { logPath: string; cfgDir: string; mode: "auto" | "manual" } {
    const cs2 = this.settings.get().cs2;
    const { install } = this.activeInstall();
    if (cs2.pathMode === "manual") {
      return { mode: "manual", logPath: cs2.logPath || install?.logPath || "", cfgDir: cs2.cfgDir || install?.cfgDir || "" };
    }
    return { mode: "auto", logPath: install?.logPath ?? "", cfgDir: install?.cfgDir ?? "" };
  }

  async restartWatcher(): Promise<void> {
    const { logPath } = this.resolvePaths();
    await this.configureDetector(logPath);
    this.logConfirmedName = logPath ? await detectLocalNameInLog(logPath) : null;
    this.hub.emit({ type: "identity", identity: this.identity() });
    this.tailer.start(logPath);
  }

  /** Re-scan Steam libraries (new install, moved library, game just installed) and restart watching. */
  async redetect(): Promise<void> {
    if (!this.opts.installs) this.installs = await findCs2Installs();
    await this.restartWatcher();
  }

  private async configureDetector(logPath: string): Promise<void> {
    const cs2 = this.settings.get().cs2;
    const install = this.activeInstall().install;
    const vpkDir = install?.vpkDir ?? (logPath ? path.dirname(logPath) : "");
    if (vpkDir && vpkDir !== this.localizationDir) this.localizationDir = vpkDir;
    const hasPack = !!vpkDir && fs.existsSync(path.join(vpkDir, "pak01_dir.vpk"));
    const localization = hasPack ? new ChatLocalization(vpkDir, path.join(this.opts.configDir, "chat-templates.json")) : null;
    this.detector.setLocalization(localization);

    const evidence: GameLanguageEvidence[] = [];
    if (cs2.chatFormat.gameLanguage) {
      evidence.push({ language: cs2.chatFormat.gameLanguage, source: "manual", detail: "set in advanced settings" });
    }
    evidence.push(...(await collectGameLanguageEvidence(install, logPath)));
    await this.detector.configure({ mode: cs2.chatFormat.mode, manual: cs2.chatFormat.manual, evidence });
  }

  /** After the game (re)starts, CS2 logs its resource loading a few seconds in; re-read the language then. */
  private scheduleEvidenceRefresh(): void {
    for (const t of this.evidenceTimers) clearTimeout(t);
    this.evidenceTimers = [4000, 20000].map((ms) =>
      setTimeout(() => void this.configureDetector(this.resolvePaths().logPath), ms).unref(),
    );
  }

  /** Opens the native Windows file / folder dialog on this PC and returns the chosen path (or null if cancelled). */
  async browse(kind: "log" | "cfg", title?: string): Promise<{ path: string | null; warning?: "not-console-log" | "not-a-folder" }> {
    const paths = this.resolvePaths();
    const pickKind: PickKind = kind === "log" ? "file" : "folder";
    const initialDir = kind === "log" ? (paths.logPath ? path.dirname(paths.logPath) : "") : paths.cfgDir;
    const picked = await pickPath({ kind: pickKind, initialDir, ...(title ? { title } : {}) });
    if (!picked) return { path: null };
    if (kind === "log") return { path: picked, ...(path.basename(picked).toLowerCase() !== "console.log" ? { warning: "not-console-log" as const } : {}) };
    const isDir = await fsp.stat(picked).then((s) => s.isDirectory(), () => false);
    return { path: picked, ...(isDir ? {} : { warning: "not-a-folder" as const }) };
  }

  get canBrowse(): boolean {
    return process.platform === "win32";
  }

  // ---------------------------------------------------------------- settings & secrets

  async updateSettings(patch: SettingsPatch): Promise<PublicSettings> {
    const before = this.settings.get();
    const next = await this.settings.update(patch);
    const pathsChanged =
      before.cs2.pathMode !== next.cs2.pathMode ||
      before.cs2.installDir !== next.cs2.installDir ||
      before.cs2.logPath !== next.cs2.logPath ||
      before.cs2.cfgDir !== next.cs2.cfgDir ||
      JSON.stringify(before.cs2.chatFormat) !== JSON.stringify(next.cs2.chatFormat);
    if (pathsChanged) await this.restartWatcher();
    if (before.translation.geminiModel !== next.translation.geminiModel) this.translation.resetEngine("gemini");
    if (JSON.stringify(before.dictionary) !== JSON.stringify(next.dictionary)) this.translation.setGlossary(new Glossary(next.dictionary));
    if (
      before.cs2.cfgFileName !== next.cs2.cfgFileName ||
      before.cs2.pathMode !== next.cs2.pathMode ||
      before.cs2.cfgDir !== next.cs2.cfgDir ||
      before.cs2.installDir !== next.cs2.installDir
    ) {
      // The key now runs a different file: nothing is prepared there yet.
      this.prepared = null;
      this.hub.emit({ type: "cfg-cleared" });
      await this.neutralizeAtStartup();
    }
    if (JSON.stringify(before.cs2.selfNames) !== JSON.stringify(next.cs2.selfNames)) {
      this.hub.emit({ type: "identity", identity: this.identity() });
    }
    return this.publicSettings();
  }

  publicSettings(): PublicSettings {
    return {
      ...this.settings.get(),
      secrets: {
        geminiKeyConfigured: !!this.geminiKey,
        geminiKeyState: this.geminiKey ? "configured" : this.geminiKeyUnreadable ? "reenter" : "missing",
      },
    };
  }

  async setGeminiKey(key: string): Promise<void> {
    await this.secrets.set(GEMINI_KEY, key); // encrypted for this Windows user; a key that cannot be decrypted is replaced
    this.geminiKey = key;
    this.geminiKeyUnreadable = false;
    this.translation.resetEngine("gemini");
    this.warnedFallback = false;
  }

  async clearGeminiKey(): Promise<void> {
    await this.secrets.delete(GEMINI_KEY);
    this.geminiKey = null;
    this.geminiKeyUnreadable = false;
    this.translation.resetEngine("gemini");
  }

  /** Verifies a key AND model with a tiny real request. Never echoes the key back. */
  async testGeminiKey(candidate?: string, model?: string): Promise<{ ok: boolean; code?: string }> {
    const key = candidate ?? this.geminiKey;
    if (!key) return { ok: false, code: "auth" };
    const engine = new GeminiEngine({
      getApiKey: () => key,
      getModel: () => model ?? this.settings.get().translation.geminiModel,
      fetchImpl: this.opts.fetchImpl ?? fetch,
    });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    try {
      await engine.translate({ text: "Hello", target: "fr", signal: ctl.signal });
      return { ok: true };
    } catch (err) {
      return { ok: false, code: err instanceof TranslationError ? err.code : "network" };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------- Gemini model list

  geminiModels(): GeminiModelsView {
    const cached = this.modelCache.get();
    const selected = this.settings.get().translation.geminiModel;
    // A list saved by an older build may hold models today's rules would not recommend: apply the rules again.
    const models = sortGeminiModels((cached?.models ?? []).filter((m) => classifyGeminiModel(m.id)));
    return {
      models,
      fetchedAt: cached?.fetchedAt ?? null,
      selectedAvailable: cached ? models.some((m) => m.id === selected) : null,
      // true only after Google answered during this run; otherwise the list is just "last known".
      live: this.modelsLive,
    };
  }

  /** Asks Google for the current model list. On failure the previous list is kept and the reason is returned. */
  async refreshGeminiModels(candidateKey?: string): Promise<GeminiModelsView & { ok: boolean; code?: string }> {
    const key = candidateKey ?? this.geminiKey;
    if (!key) return { ...this.geminiModels(), ok: false, code: "auth" };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15_000);
    try {
      const models = await listGeminiModels({ apiKey: key, fetchImpl: this.opts.fetchImpl ?? fetch, signal: ctl.signal });
      await this.modelCache.save(models);
      this.modelsLive = true;
      return { ...this.geminiModels(), ok: true };
    } catch (err) {
      return { ...this.geminiModels(), ok: false, code: err instanceof TranslationError ? err.code : "network" };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------- state

  async getState(): Promise<AppState> {
    return {
      version: APP_VERSION,
      settings: this.publicSettings(),
      watcher: this.watcher,
      format: this.detector.status(),
      paths: await this.pathsInfo(),
      runtime: this.runtime(),
      prepared: this.prepared,
      secureStorage: this.secrets.kind,
      identity: this.identity(),
      history: this.history,
    };
  }

  private async pathsInfo(): Promise<PathsInfo> {
    const paths = this.resolvePaths();
    const { install, needsChoice } = this.activeInstall();
    const candidates: InstallCandidate[] = await Promise.all(
      this.installs.map(async (i) => {
        const st = await fsp.stat(i.logPath).catch(() => null);
        return { gameDir: i.gameDir, logPath: i.logPath, logExists: !!st, logModifiedAt: st ? st.mtimeMs : null, selected: install?.gameDir === i.gameDir };
      }),
    );
    return {
      mode: paths.mode,
      logPath: paths.logPath,
      logExists: !!paths.logPath && fs.existsSync(paths.logPath),
      logNameUnusual: !!paths.logPath && path.basename(paths.logPath).toLowerCase() !== "console.log",
      cfgDir: paths.cfgDir,
      cfgDirExists: !!paths.cfgDir && fs.existsSync(paths.cfgDir),
      cfgDirWritable: !!paths.cfgDir && (await isWritableDir(paths.cfgDir)),
      steamRoot: this.installs[0]?.steamRoot ?? null,
      candidates,
      needsChoice,
      canBrowse: this.canBrowse,
    };
  }

  runtime(): RuntimeStatus {
    return { paused: this.paused, queued: this.translation.queued, stats: this.translation.stats() };
  }

  private scheduleStatsEmit(): void {
    if (this.statsTimer) return;
    this.statsTimer = setTimeout(() => {
      this.statsTimer = null;
      this.hub.emit({ type: "runtime", status: this.runtime() });
    }, STATS_EMIT_MS);
    this.statsTimer.unref();
  }

  setPaused(paused: boolean): RuntimeStatus {
    this.paused = paused;
    const status = this.runtime();
    this.hub.emit({ type: "runtime", status });
    return status;
  }

  /** A message is prepared and has not been cleared. */
  hasPrepared(): boolean {
    return this.prepared !== null;
  }

  clearHistory(): void {
    this.history.length = 0;
    this.translationSeq.clear();
    this.hub.emit({ type: "cleared" });
  }

  // ---------------------------------------------------------------- identity

  /**
   * Chat lines carry only a display name, which is neither unique nor unforgeable, so a name match by itself is
   * NOT proof of identity. Commands are therefore limited to names the user has explicitly authorised (manual) or that
   * the game's own log confirmed. The Steam profile name is only offered as a suggestion.
   */
  identity(): IdentityInfo {
    const manual = this.settings.get().cs2.selfNames;
    const logConfirmed = this.logConfirmedName;
    const authorized = [...new Set([...manual, ...(logConfirmed ? [logConfirmed] : [])])];
    return {
      authorized,
      manual,
      logConfirmed,
      steam: this.personaName,
      suggestSteam: !!this.personaName && authorized.length === 0,
    };
  }

  private sameName(a: string, b: string): boolean {
    return sameName(a, b);
  }

  /** Display only ("You" badge): confirmed names plus the Steam name. */
  private isSelf(sender: string): boolean {
    const id = this.identity();
    return [...id.authorized, ...(id.steam ? [id.steam] : [])].some((n) => this.sameName(n, sender));
  }

  private isConfirmedSelf(sender: string): boolean {
    return this.identity().authorized.some((n) => this.sameName(n, sender));
  }

  // ---------------------------------------------------------------- chat pipeline

  async handleLine(line: string): Promise<void> {
    const loopbackName = localNameFromLine(line);
    if (loopbackName && loopbackName !== this.logConfirmedName) {
      this.logConfirmedName = loopbackName;
      this.hub.emit({ type: "identity", identity: this.identity() });
    }

    const parsed = this.detector.parse(line);
    if (!parsed) return;
    const settings = this.settings.get();
    const message: ChatMessage = {
      id: `m${Date.now().toString(36)}${(++this.seq).toString(36)}`,
      at: Date.now(),
      channel: parsed.channel,
      sender: parsed.sender,
      ...(parsed.location ? { location: parsed.location } : {}),
      dead: parsed.dead,
      text: parsed.text,
      isSelf: this.isSelf(parsed.sender),
      formatId: parsed.formatId,
    };

    const entry: ChatEntry = { ...message, translation: { id: message.id, status: "pending" } };
    this.pushHistory(entry);
    // The raw chat line goes out immediately; nothing below can delay or drop it.
    this.hub.emit({ type: "chat", message });

    if (!settings.general.autoTranslate) return void this.setTranslation(entry, { id: message.id, status: "skipped", reason: "auto-off" });
    if (this.paused) return void this.setTranslation(entry, { id: message.id, status: "skipped", reason: "paused" });
    // Only a name the user authorised (or the game's own console line confirmed) counts as "me" here; the Steam
    // name alone is a suggestion, so a stranger who shares it is still translated.
    if (this.isConfirmedSelf(message.sender) && (settings.general.hideOwnMessages || !settings.general.translateOwnMessages)) {
      return void this.setTranslation(entry, { id: message.id, status: "skipped", reason: "own-message" });
    }
    await this.translateEntry(entry, "chat");
  }

  /** Translates (or re-translates) one history entry on demand, e.g. a message skipped while paused. */
  async translateById(id: string): Promise<TranslationUpdate | null> {
    const entry = this.history.find((e) => e.id === id);
    if (!entry) return null;
    return this.translateEntry(entry, "user");
  }

  private async translateEntry(entry: ChatEntry, priority: "chat" | "user"): Promise<TranslationUpdate> {
    const settings = this.settings.get();
    const seq = (this.translationSeq.get(entry.id) ?? 0) + 1;
    this.translationSeq.set(entry.id, seq);
    if (entry.translation.status !== "pending") this.setTranslation(entry, { id: entry.id, status: "pending" });

    const { engine, fallbackFrom } = this.effectiveEngine(settings.translation.chatEngine);
    if (fallbackFrom) this.noteFallback();
    let update: TranslationUpdate;
    try {
      update = this.toUpdate(
        entry.id,
        await this.translation.translate({
          text: entry.text,
          target: settings.translation.chatTargetLanguage,
          engine,
          priority,
          smartFilter: settings.general.smartFilter,
          useCache: settings.general.translationCache,
          staleAfterMs: settings.translation.staleAfterMs,
        }),
      );
    } catch (err) {
      update = this.failure(entry.id, err, engine);
    }
    // A newer request for the same message (retry, re-translate) owns the result; drop this late one.
    if (this.translationSeq.get(entry.id) === seq) this.setTranslation(entry, update);
    return update;
  }

  private toUpdate(id: string, outcome: TranslateOutcome): TranslationUpdate {
    if (outcome.status === "skipped") return { id, status: "skipped", reason: outcome.reason };
    return {
      id,
      status: "done",
      text: outcome.text,
      target: outcome.target,
      engine: outcome.engine,
      ...(outcome.sourceLanguage ? { sourceLanguage: outcome.sourceLanguage } : {}),
    };
  }

  private failure(id: string, err: unknown, engine: EngineId): TranslationUpdate {
    const code = err instanceof TranslationError ? err.code : "network";
    if (code === "stale") return { id, status: "skipped", reason: "stale", engine };
    if (code === "auth") this.hub.emit({ type: "notice", level: "error", code: "gemini-auth" });
    return { id, status: "failed", reason: code, engine };
  }

  private effectiveEngine(preferred: EngineId): { engine: EngineId; fallbackFrom?: EngineId } {
    if (preferred === "gemini" && !this.geminiKey) return { engine: "google", fallbackFrom: "gemini" };
    return { engine: preferred };
  }

  private noteFallback(): void {
    if (this.warnedFallback) return;
    this.warnedFallback = true;
    this.hub.emit({ type: "notice", level: "warn", code: this.geminiKeyUnreadable ? "gemini-key-unreadable" : "gemini-no-key-fallback" });
  }

  private setTranslation(entry: ChatEntry, update: TranslationUpdate): void {
    entry.translation = update;
    this.hub.emit({ type: "translation", update });
  }

  private pushHistory(entry: ChatEntry): void {
    this.history.push(entry);
    if (this.history.length > HISTORY_LIMIT) {
      const dropped = this.history.shift();
      if (dropped) this.translationSeq.delete(dropped.id);
    }
  }

  // ---------------------------------------------------------------- UI actions

  /** Translation used by the composer (send side). */
  async translateForSend(text: string, target: string, engine?: EngineId): Promise<TranslateOutcome & { engineUsed: EngineId }> {
    const settings = this.settings.get();
    const wanted = engine ?? settings.translation.sendEngine;
    const { engine: used, fallbackFrom } = this.effectiveEngine(wanted);
    if (fallbackFrom) this.noteFallback();
    const outcome = await this.translation.translate({
      text,
      target,
      engine: used,
      priority: "user",
      smartFilter: settings.general.smartFilter,
      useCache: settings.general.translationCache,
    });
    return { ...outcome, engineUsed: used };
  }

  /**
   * Prepares ONE message behind the shared in-game key (translated or typed as-is).
   *  - Only an explicit call replaces the prepared message; background translations never do.
   *  - Writes are serialised, and a call whose click happened BEFORE an already-prepared one is rejected, so a slow
   *    older request can never overwrite a newer message.
   *  - The state (and the UI) changes only after the file was written; a failed write leaves the previous message intact.
   * CS2 never reports whether a chat line was really sent, so "prepared" is the strongest claim this can make.
   */
  prepareCfg(message: string, channel: SayChannel, mode: PreparedMode, opts: PrepareOptions = {}): Promise<CfgPrepared> {
    const now = Date.now();
    // A click time from the future would block every later preparation, so a clock that is more than a moment ahead of
    // ours is ignored and the arrival time is used instead.
    const clickedAt = opts.clickedAt !== undefined && opts.clickedAt <= now + FUTURE_TOLERANCE_MS ? opts.clickedAt : now;
    const run = this.prepareChain.then(async () => {
      if (clickedAt < this.lastClickedAt) throw new PrepareSupersededError();
      const { cfgDir } = this.resolvePaths();
      const cs2 = this.settings.get().cs2;
      if (!cfgDir) throw new CfgError("cfg-dir-missing");
      const written = await writeChatCfg({ cfgDir, fileName: cs2.cfgFileName, text: message, channel });
      const prepared: CfgPrepared = {
        id: `p${now.toString(36)}${(++this.seq).toString(36)}`,
        mode,
        channel,
        lines: written.lines,
        ...(opts.original !== undefined && opts.original !== message ? { original: opts.original } : {}),
        file: written.file,
        truncated: written.truncated,
        preparedAt: Date.now(),
        clickedAt,
        bindCommand: bindCommand(cs2.bindKey, cs2.cfgFileName),
      };
      this.lastClickedAt = clickedAt;
      this.prepared = prepared;
      this.hub.emit({ type: "cfg", prepared });
      return prepared;
    });
    this.prepareChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Withdraws the prepared message: the key does nothing until something new is prepared. */
  clearPrepared(): Promise<void> {
    const at = Date.now();
    const run = this.prepareChain.then(async () => {
      const { cfgDir } = this.resolvePaths();
      if (cfgDir) {
        const r = await neutralizeCfg(cfgDir, this.settings.get().cs2.cfgFileName);
        if (r === "failed") throw new CfgError("cfg-write-failed");
      }
      // A click made before this one but still being processed must not bring a message back.
      this.lastClickedAt = Math.max(this.lastClickedAt, at);
      this.prepared = null;
      this.hub.emit({ type: "cfg-cleared" });
    });
    this.prepareChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** On start: make sure the bound key cannot send a message left over from an earlier run or the previous app version. */
  private async neutralizeAtStartup(): Promise<void> {
    const { cfgDir } = this.resolvePaths();
    if (!cfgDir) return;
    const r = await neutralizeCfg(cfgDir, this.settings.get().cs2.cfgFileName);
    if (r === "foreign") this.hub.emit({ type: "notice", level: "warn", code: "cfg-foreign-file" });
    if (r === "failed") this.hub.emit({ type: "notice", level: "warn", code: "cfg-write-failed" });
  }

  private async neutralizeQuietly(): Promise<void> {
    try {
      const { cfgDir } = this.resolvePaths();
      if (cfgDir && this.prepared) await neutralizeCfg(cfgDir, this.settings.get().cs2.cfgFileName);
    } catch {
      /* best effort on shutdown */
    }
  }
}

export { PickerUnsupportedError };

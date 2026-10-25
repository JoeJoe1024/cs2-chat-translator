import fs from "node:fs/promises";
import path from "node:path";
import { VpkArchive } from "../vpk";
import { GAME_LANGUAGE_IDS } from "../../shared/gameLanguages";
import type { TokenMap } from "./templates";

/** Cache layout: invalidated automatically when the game's pak01_dir.vpk changes (game update). */
interface CacheFile {
  version: 1;
  vpkSize: number;
  vpkMtimeMs: number;
  languages: Record<string, TokenMap>;
}

const EXTRA_VARIANTS = ["schinese_pw"];
export const KNOWN_RESOURCE_LANGUAGES: readonly string[] = [...GAME_LANGUAGE_IDS, ...EXTRA_VARIANTS];

const TOKEN_LINE = /^\s*"(Cstrike_Chat_[^"]*)"\s+"((?:[^"\\]|\\.)*)"/gim;

export function extractChatTokens(resourceText: string): TokenMap {
  const out: TokenMap = {};
  for (const m of resourceText.replace(/^\uFEFF/, "").matchAll(TOKEN_LINE)) {
    const [, token, value] = m;
    if (token && value !== undefined) out[token] = value.replace(/\\n/g, "\n").replace(/\\(["\\])/g, "$1");
  }
  return out;
}

/**
 * Reads the game's own chat templates from the install the user already owns. Nothing is bundled or
 * redistributed; the result is cached under the app's config dir only to skip re-reading ~4 MB per language.
 */
export class ChatLocalization {
  private archive: VpkArchive | null = null;
  private cache: CacheFile | null = null;

  constructor(
    private readonly vpkDir: string,
    private readonly cacheFile: string,
  ) {}

  private vpkPath(): string {
    return path.join(this.vpkDir, "pak01_dir.vpk");
  }

  /** Languages for which the install contains a `csgo_<id>.txt`. */
  async availableLanguages(): Promise<string[]> {
    const archive = await this.open();
    return KNOWN_RESOURCE_LANGUAGES.filter((id) => archive.has(`resource/csgo_${id}.txt`));
  }

  private async open(): Promise<VpkArchive> {
    if (!this.archive) {
      this.archive = await VpkArchive.open(this.vpkPath(), (f) => /^resource\/csgo_[a-z_]+\.txt$/.test(f));
    }
    return this.archive;
  }

  private async loadCache(): Promise<CacheFile> {
    if (this.cache) return this.cache;
    const st = await fs.stat(this.vpkPath());
    try {
      const parsed = JSON.parse(await fs.readFile(this.cacheFile, "utf8")) as CacheFile;
      if (parsed.version === 1 && parsed.vpkSize === st.size && parsed.vpkMtimeMs === st.mtimeMs) {
        this.cache = parsed;
        return parsed;
      }
    } catch {
      /* no cache or unreadable */
    }
    this.cache = { version: 1, vpkSize: st.size, vpkMtimeMs: st.mtimeMs, languages: {} };
    return this.cache;
  }

  /** Chat tokens for one language id (e.g. `tchinese`), or null if the install has no such file. */
  async tokensFor(language: string): Promise<TokenMap | null> {
    const cache = await this.loadCache();
    const cached = cache.languages[language];
    if (cached) return cached;
    const archive = await this.open();
    const file = `resource/csgo_${language}.txt`;
    if (!archive.has(file)) return null;
    const tokens = extractChatTokens((await archive.read(file)).toString("utf8"));
    cache.languages[language] = tokens;
    await this.saveCache(cache);
    return tokens;
  }

  private async saveCache(cache: CacheFile): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
      const tmp = `${this.cacheFile}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(cache), "utf8");
      await fs.rename(tmp, this.cacheFile);
    } catch {
      /* cache is an optimisation only */
    }
  }
}

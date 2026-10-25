import fs from "node:fs/promises";
import path from "node:path";
import { defaultSettings, mergeSettings, settingsSchema, type Settings, type SettingsPatch } from "./schema";

/** Persists non-secret settings as JSON. Corrupt files are moved aside instead of crashing startup. */
export class SettingsStore {
  private current: Settings = defaultSettings();
  private readonly file: string;

  constructor(private readonly dir: string) {
    this.file = path.join(dir, "settings.json");
  }

  get(): Settings {
    return this.current;
  }

  async load(): Promise<Settings> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return this.current;
      throw err;
    }
    try {
      this.current = settingsSchema.parse(migrate(JSON.parse(raw)));
    } catch {
      await fs.rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => undefined);
      this.current = defaultSettings();
    }
    return this.current;
  }

  async update(patch: SettingsPatch): Promise<Settings> {
    const next = mergeSettings(this.current, patch);
    await this.write(next);
    this.current = next;
    return next;
  }

  private async write(settings: Settings): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(settings, null, 2), "utf8");
    await fs.rename(tmp, this.file);
  }
}

/** Settings written by earlier versions: explicit paths implied manual mode before `pathMode` existed. */
function migrate(raw: unknown): unknown {
  const cs2 = (raw as { cs2?: Record<string, unknown> } | null)?.cs2;
  if (cs2 && typeof cs2 === "object" && cs2.pathMode === undefined && (cs2.logPath || cs2.cfgDir)) {
    return { ...(raw as object), cs2: { ...cs2, pathMode: "manual" } };
  }
  return raw;
}

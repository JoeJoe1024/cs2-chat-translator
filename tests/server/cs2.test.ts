import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSettings, mergeSettings } from "../../src/config/schema";
import { DpapiSecretStore } from "../../src/config/secrets";
import { SettingsStore } from "../../src/config/store";
import { extractChatTokens } from "../../src/cs2/chat/localization";
import { collectGameLanguageEvidence, languageFromLaunchOptions, languageFromLogText } from "../../src/cs2/gameLanguage";
import { findCs2Install, readPersonaNames, readSteamAppLanguage, steamLibraries } from "../../src/cs2/steam";
import { parseVdf, vdfGet } from "../../src/cs2/vdf";
import { VpkArchive } from "../../src/cs2/vpk";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "cs2t-misc-"));

describe("vdf", () => {
  it("parses nested keyvalues, quotes, escapes and comments", () => {
    const v = parseVdf(`"libraryfolders" { // c\n "0" { "path" "C:\\\\Steam" "apps" { "730" "1" } } "1" { "path" "D:\\\\Lib" } }`);
    expect(vdfGet(v, "libraryfolders", "0", "path")).toBe("C:\\Steam");
    expect(vdfGet(v, "LibraryFolders", "1", "PATH")).toBe("D:\\Lib");
    expect(vdfGet(v, "nope", "x")).toBeUndefined();
  });
});

describe("Steam discovery", () => {
  async function fakeSteam(language = "tchinese") {
    const root = await tmp();
    const lib2 = await tmp();
    await fs.mkdir(path.join(root, "steamapps"), { recursive: true });
    await fs.writeFile(
      path.join(root, "steamapps", "libraryfolders.vdf"),
      `"libraryfolders" { "0" { "path" ${JSON.stringify(root)} } "1" { "path" ${JSON.stringify(lib2)} } }`,
    );
    const game = path.join(lib2, "steamapps", "common", "Counter-Strike Global Offensive", "game", "csgo");
    await fs.mkdir(path.join(game, "cfg"), { recursive: true });
    await fs.writeFile(path.join(lib2, "steamapps", "appmanifest_730.acf"), `"AppState" { "appid" "730" "UserConfig" { "language" "${language}" } }`);
    await fs.mkdir(path.join(root, "config"), { recursive: true });
    await fs.writeFile(
      path.join(root, "config", "loginusers.vdf"),
      `"users" { "1" { "PersonaName" "Old" "MostRecent" "0" } "2" { "PersonaName" "咕咕嘎嘎" "MostRecent" "1" } }`,
    );
    await fs.mkdir(path.join(root, "userdata", "42", "config"), { recursive: true });
    await fs.writeFile(
      path.join(root, "userdata", "42", "config", "localconfig.vdf"),
      `"UserLocalConfigStore" { "Software" { "Valve" { "Steam" { "apps" { "730" { "LaunchOptions" "-novid -condebug -language french" } } } } } }`,
    );
    return { root, lib2, game };
  }

  it("finds CS2 in a secondary library and reads language, launch options and persona", async () => {
    const f = await fakeSteam();
    expect(await steamLibraries(f.root)).toEqual([f.root, path.normalize(f.lib2)]);
    const install = await findCs2Install([f.root]);
    expect(install?.gameDir).toBe(f.game);
    expect(install?.logPath).toBe(path.join(f.game, "console.log"));
    expect(await readSteamAppLanguage(install!)).toBe("tchinese");
    expect(await readPersonaNames(f.root)).toEqual(["咕咕嘎嘎", "Old"]);
    const ev = await collectGameLanguageEvidence(install, path.join(f.game, "console.log"));
    expect(ev.map((e) => [e.source, e.language])).toEqual([
      ["launch-option", "french"],
      ["steam-app", "tchinese"],
    ]);
  });

  it("puts what the running game logged ahead of Steam's setting", async () => {
    const f = await fakeSteam("english");
    const install = (await findCs2Install([f.root]))!;
    const log = path.join(f.game, "console.log");
    await fs.writeFile(log, '10/22 23:32:16 ILocalize::AddFile() failed to load file "resource/keybindings_tchinese.txt".\n');
    const ev = await collectGameLanguageEvidence(install, log);
    expect(ev[0]).toMatchObject({ source: "console-log", language: "tchinese" });
    expect(ev.at(-1)).toMatchObject({ source: "steam-app", language: "english" });
  });

  it("returns nothing for a missing log and unknown options", async () => {
    expect(await collectGameLanguageEvidence(null, path.join(os.tmpdir(), "nope.log"))).toEqual([]);
    expect(languageFromLaunchOptions("-novid -language klingon")).toBeNull();
    expect(languageFromLogText("nothing here")).toBeNull();
  });
});

describe("VPK reader", () => {
  function buildTree(files: { name: string; archive: number; offset: number; length: number }[]): Buffer {
    const parts: Buffer[] = [Buffer.from("txt\0resource\0")];
    for (const f of files) {
      const e = Buffer.alloc(18);
      e.writeUInt16LE(0, 4); // preload
      e.writeUInt16LE(f.archive, 6);
      e.writeUInt32LE(f.offset, 8);
      e.writeUInt32LE(f.length, 12);
      e.writeUInt16LE(0xffff, 16);
      parts.push(Buffer.from(`${f.name}\0`), e.subarray(0, 18).subarray(0, 18));
    }
    parts.push(Buffer.from("\0\0\0"));
    return Buffer.concat(parts);
  }

  function header(treeSize: number, dataSize: number): Buffer {
    const h = Buffer.alloc(28);
    h.writeUInt32LE(0x55aa1234, 0);
    h.writeUInt32LE(2, 4);
    h.writeUInt32LE(treeSize, 8);
    h.writeUInt32LE(dataSize, 12);
    return h;
  }

  it("reads files stored inside the dir pack and in numbered archives", async () => {
    const dir = await tmp();
    const inline = Buffer.from('"Cstrike_Chat_All" " [ALL] %s1: %s2"');
    const external = Buffer.from("external payload");
    const tree = buildTree([
      { name: "csgo_inline", archive: 0x7fff, offset: 0, length: inline.length },
      { name: "csgo_ext", archive: 0, offset: 5, length: external.length },
    ]);
    await fs.writeFile(path.join(dir, "pak01_dir.vpk"), Buffer.concat([header(tree.length, inline.length), tree, inline]));
    await fs.writeFile(path.join(dir, "pak01_000.vpk"), Buffer.concat([Buffer.alloc(5), external]));
    const vpk = await VpkArchive.open(path.join(dir, "pak01_dir.vpk"));
    expect(vpk.list().sort()).toEqual(["resource/csgo_ext.txt", "resource/csgo_inline.txt"]);
    expect((await vpk.read("resource/csgo_inline.txt")).toString()).toBe(inline.toString());
    expect((await vpk.read("resource/csgo_ext.txt")).toString()).toBe("external payload");
    await expect(vpk.read("resource/missing.txt")).rejects.toThrow();
  });

  it("rejects files that are not VPKs", async () => {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, "x_dir.vpk"), Buffer.from("this is not a vpk file at all"));
    await expect(VpkArchive.open(path.join(dir, "x_dir.vpk"))).rejects.toThrow(/Not a VPK/);
  });

  it("extracts chat tokens from KeyValues text", () => {
    const tokens = extractChatTokens('"lang"\n{\n"Tokens"\n{\n"Cstrike_Chat_CT"\t" [CT] %s1: %s2"\n"Other" "x"\n"Cstrike_Chat_All" " [ALL] \\"q\\" %s1: %s2"\n}\n}');
    expect(Object.keys(tokens)).toEqual(["Cstrike_Chat_CT", "Cstrike_Chat_All"]);
    expect(tokens.Cstrike_Chat_All).toBe(' [ALL] "q" %s1: %s2');
  });
});

describe("settings", () => {
  it("merges partial patches without losing siblings", () => {
    const next = mergeSettings(defaultSettings(), { cs2: { chatFormat: { manual: { ct: "反恐小組" } } }, appearance: { theme: "light" } });
    expect(next.cs2.chatFormat.manual).toEqual({ ct: "反恐小組", t: "T", all: "ALL" });
    expect(next.cs2.chatFormat.mode).toBe("auto");
    expect(next.appearance.theme).toBe("light");
    expect(next.translation.chatEngine).toBe("google");
  });

  it("defaults: automatic chat format, system theme, google engine", () => {
    const d = defaultSettings();
    expect(d.cs2.chatFormat.mode).toBe("auto");
    expect(d.appearance.theme).toBe("system");
    expect(d.translation.sendEngine).toBe("google");
  });

  it("persists across restarts and survives a corrupt file", async () => {
    const dir = await tmp();
    const a = new SettingsStore(dir);
    await a.load();
    await a.update({ appearance: { theme: "dark" }, translation: { sendTargetLanguage: "ja" } });
    const b = new SettingsStore(dir);
    expect((await b.load()).appearance.theme).toBe("dark");
    expect(b.get().translation.sendTargetLanguage).toBe("ja");

    await fs.writeFile(path.join(dir, "settings.json"), "{ broken json");
    const c = new SettingsStore(dir);
    expect((await c.load()).appearance.theme).toBe("system");
    expect((await fs.readdir(dir)).some((f) => f.startsWith("settings.json.corrupt-"))).toBe(true);
  });

  it("falls back to defaults for invalid stored values", async () => {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify({ appearance: { theme: "neon" } }));
    expect((await new SettingsStore(dir).load()).appearance.theme).toBe("system");
  });
});

describe.skipIf(process.platform !== "win32")("Windows DPAPI secret store (real)", () => {
  it("round-trips a secret and never stores it in clear text", async () => {
    const dir = await tmp();
    const store = new DpapiSecretStore(dir);
    const secret = "AIzaSy-test-secret-ÄÖ-0123456789";
    await store.set("k", secret);
    expect(await store.get("k")).toBe(secret);
    const onDisk = await fs.readFile(path.join(dir, "secrets.dpapi.json"), "utf8");
    expect(onDisk).not.toContain("AIzaSy");
    expect(await new DpapiSecretStore(dir).get("k")).toBe(secret);
    await store.delete("k");
    expect(await new DpapiSecretStore(dir).get("k")).toBeNull();
  }, 60000);
});

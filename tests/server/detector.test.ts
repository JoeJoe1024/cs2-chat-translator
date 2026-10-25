import path from "node:path";
import { existsSync } from "node:fs";
import os from "node:os";
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ChatFormatDetector } from "../../src/cs2/chat/detector";
import { ChatLocalization } from "../../src/cs2/chat/localization";
import { compileTokenMap, matchTemplates } from "../../src/cs2/chat/templates";
import { BUILTIN_ENGLISH_TOKENS } from "../../src/cs2/chat/builtinEnglish";

const ts = "10/22 23:40:01 ";
const BS = String.fromCharCode(92);
const ev = (language: string) => [{ language, source: "console-log" as const, detail: "test" }];

describe("template matching (English templates from the game files)", () => {
  const templates = compileTokenMap("english", BUILTIN_ENGLISH_TOKENS);

  it("parses team, all, location, dead and spectator chat", () => {
    const cases: [string, string, string, boolean, string | undefined][] = [
      [`${ts} [ALL] Alice: hello there`, "all", "Alice", false, undefined],
      [`${ts} [CT] Bob: rush b`, "ct", "Bob", false, undefined],
      [`${ts} [T] Carol﹫BombsiteA: eco round`, "t", "Carol", false, "BombsiteA"],
      [`${ts} [CT] Dave [DEAD]: gg`, "ct", "Dave", true, undefined],
      [`${ts} [ALL] Eve [DEAD]: nice`, "all", "Eve", true, undefined],
      [`${ts} [ALL] Fay [SPEC]: hi`, "all", "Fay", true, undefined],
      [`[ALL] NoTimestamp: works too`, "all", "NoTimestamp", false, undefined],
    ];
    for (const [line, channel, sender, dead, loc] of cases) {
      const m = matchTemplates(templates, line);
      expect(m, line).not.toBeNull();
      expect(m!.template.channel).toBe(channel);
      expect(m!.name).toBe(sender);
      expect(m!.template.dead).toBe(dead);
      expect(m!.location).toBe(loc);
    }
  });

  it("matches the exact shape of real console.log chat lines (two spaces after the timestamp)", () => {
    const m = matchTemplates(templates, "10/23 00:02:33  [ALL] Name: message");
    expect(m).toMatchObject({ name: "Name", text: "message" });
  });

  it("handles colour control codes embedded in the line", () => {
    const m = matchTemplates(templates, `${ts} \u0001[ALL] \u0003Alice\u0001: hi`);
    expect(m?.name).toBe("Alice");
    expect(m?.text).toBe("hi");
  });

  it("does not let message text forge the sender or flags", () => {
    const forged = matchTemplates(templates, `${ts} [ALL] Mallory: look [DEAD]: pwned`);
    expect(forged?.name).toBe("Mallory");
    expect(forged?.template.dead).toBe(false);
    expect(forged?.text).toBe("look [DEAD]: pwned");
    const forgedLoc = matchTemplates(templates, `${ts} [CT] Mallory: go﹫Mid: now`);
    expect(forgedLoc?.name).toBe("Mallory");
    expect(forgedLoc?.location).toBeUndefined();
  });

  it("keeps names and text verbatim (symbols, emoji, CJK, colons in text)", () => {
    const m = matchTemplates(templates, `${ts} [ALL] ~*xX_咕咕嘎嘎_Xx*~ 😀: 你好: world <b>x</b> ${BS} " ' ;`);
    expect(m?.name).toBe("~*xX_咕咕嘎嘎_Xx*~ 😀");
    expect(m?.text).toBe(`你好: world <b>x</b> ${BS} " ' ;`);
  });

  it("ignores system lines", () => {
    for (const line of [
      `${ts} [Client] Connected: yes`,
      `${ts} [NetSteamConn] Associating NetChan foo @ loopback:0 (loopback:0) with Steam Net Connection`,
      `${ts} Cannot create physics for prop_physics "" (models/x.vmdl) @`,
      `${ts} Player: Alice connected`,
    ]) expect(matchTemplates(templates, line), line).toBeNull();
  });
});

describe("ChatFormatDetector without game files", () => {
  it("falls back to English templates and says so", async () => {
    const d = new ChatFormatDetector(null);
    await d.configure({ mode: "auto", manual: { ct: "CT", t: "T", all: "ALL" }, evidence: [] });
    expect(d.parse(`${ts} [CT] Bob: hi`)?.channel).toBe("ct");
    expect(d.status().templateSource).toBe("builtin-english");
  });

  it("manual mode uses only the typed tags and ignores auto templates", async () => {
    const d = new ChatFormatDetector(null);
    await d.configure({ mode: "manual", manual: { ct: "反恐小組", t: "恐怖份子", all: "全部" }, evidence: [] });
    expect(d.parse(`${ts} [反恐小組] 玩家：你好`)).toMatchObject({ channel: "ct", sender: "玩家", text: "你好" });
    expect(d.parse(`${ts} [CT] Bob: hi`)).toBeNull();
  });

  it("collects unrecognised chat-like tags for diagnostics but does not emit them as chat", async () => {
    const d = new ChatFormatDetector(null);
    await d.configure({ mode: "auto", manual: { ct: "CT", t: "T", all: "ALL" }, evidence: [] });
    expect(d.parse(`${ts} [ZZZ] Someone: hi`)).toBeNull();
    expect(d.parse(`${ts} [Client] Foo: bar`)).toBeNull();
    expect(d.status().unrecognized).toEqual([{ tag: "ZZZ", count: 1 }]);
  });
});

// Reads the real localization from a local CS2 install when one exists (skipped otherwise).
const REAL_VPK = "D:/Steam/steamapps/common/Counter-Strike Global Offensive/game/csgo";
describe.skipIf(!existsSync(path.join(REAL_VPK, "pak01_dir.vpk")))("against the real CS2 localization files", { timeout: 120000 }, () => {
  const mk = async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs2t-loc-"));
    return new ChatLocalization(REAL_VPK, path.join(dir, "cache.json"));
  };

  it("parses Traditional Chinese chat (反恐小組 / 恐怖份子 / 所有人, full-width colon)", async () => {
    const d = new ChatFormatDetector(await mk());
    await d.configure({ mode: "auto", manual: { ct: "CT", t: "T", all: "ALL" }, evidence: ev("tchinese") });
    expect(d.parse(`${ts} [反恐小組] 小明：蹲點`)).toMatchObject({ channel: "ct", sender: "小明", text: "蹲點" });
    expect(d.parse(`${ts} [恐怖份子] 小華﹫A點：衝`)).toMatchObject({ channel: "t", sender: "小華", location: "A點" });
    expect(d.parse(`${ts} [所有人] 路人 [陣亡]：gg`)).toMatchObject({ channel: "all", sender: "路人", dead: true });
    expect(d.status().templateSource).toBe("game-files");
  });

  it("recognises Russian, French, German, Korean and Simplified Chinese (PW) formats", async () => {
    const d = new ChatFormatDetector(await mk());
    await d.configure({ mode: "auto", manual: { ct: "CT", t: "T", all: "ALL" }, evidence: ev("english") });
    await d.whenFullyLoaded();
    expect(d.parse(`${ts} [ВСЕМ] Иван: привет`)).toMatchObject({ channel: "all", sender: "Иван" });
    expect(d.parse(`${ts} [AT] Luc : salut`)).toMatchObject({ channel: "ct", sender: "Luc", text: "salut" });
    expect(d.parse(`${ts} [ALLE] Hans: hallo`)).toMatchObject({ channel: "all", sender: "Hans" });
    expect(d.parse(`${ts} [전체] 민수: 안녕`)).toMatchObject({ channel: "all", sender: "민수" });
    expect(d.parse(`${ts} （CT阵营）小李 ：你好`)).toMatchObject({ channel: "ct", sender: "小李", text: "你好" });
  });

  it("promotes the language that real chat proves, even if the evidence was wrong", async () => {
    const d = new ChatFormatDetector(await mk());
    await d.configure({ mode: "auto", manual: { ct: "CT", t: "T", all: "ALL" }, evidence: ev("english") });
    await d.whenFullyLoaded();
    for (let i = 0; i < 3; i++) d.parse(`${ts} [所有人] 玩家${i}：哈囉`);
    expect(d.status().detectedLanguage).toBe("tchinese");
  });
});

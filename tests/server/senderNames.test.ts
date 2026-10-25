import { describe, expect, it } from "vitest";
import { compileTemplate, matchTemplates } from "../../src/cs2/chat/templates";

// Lines as the Traditional-Chinese game writes them to console.log: an invisible left-to-right mark (U+200E) follows the
// player name, and the team line puts the location after a small commercial at (U+FE6B).
const LRM = "‎";
const all = compileTemplate("Cstrike_Chat_All", "tchinese", "[所有人] %s1：%s2")!;
const ct = compileTemplate("Cstrike_Chat_CT_Loc", "tchinese", "[反恐小組] %s1﹫%s3：%s2")!;

describe("sender names from real game lines", () => {
  it("never keeps invisible direction marks in the sender", () => {
    const a = matchTemplates([all, ct], `10/25 17:45:51  [所有人] Joe${LRM}：777`);
    expect(a?.name).toBe("Joe");
    const b = matchTemplates([all, ct], `10/25 17:46:24  [反恐小組] Joe${LRM}﹫CT 起始地點：888`);
    expect(b).toMatchObject({ name: "Joe", location: "CT 起始地點", text: "888" });
  });

  it("does not turn another player into Joe", () => {
    expect(matchTemplates([all], `[所有人] Joe2${LRM}：hi`)?.name).toBe("Joe2");
    expect(matchTemplates([all], `[所有人] NotJoe${LRM}：hi`)?.name).toBe("NotJoe");
  });
});

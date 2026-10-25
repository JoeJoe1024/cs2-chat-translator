import { describe, expect, it } from "vitest";
import { classifyChat } from "../../src/translation/filter";

describe("smart chat filter", () => {
  it.each([
    "666", "777777", "123456", "1 2 3", "!!!!!!", "?????", "?!?!", "...", "---", "😀", "😀😀😀😀", "👍🏻👍🏻", "❤️", "🔥 🔥 🔥", "+1", "1/2", "$$$", "…", "。。。", "！！！", "٣٣٣",
  ])("skips meaningless %j before any API call", (text) => {
    expect(classifyChat(text, true)).toBe("not-text");
  });

  it.each([
    "2 A 1 B", "1v3", "30 hp", "rush B", "low", "go", "gg", "nt", "eco", "a", "B", "1 hp", "A?", "b!!", "2a", "ez", "ok",
    "哈哈哈哈", "ｗｗｗ", "www", "ははは", "ㅋㅋㅋㅋ", "lol lol lol", "хахаха", "666 nice", "gg😀", "A 2", "1v1?",
  ])("always keeps %j so it is translated", (text) => {
    expect(classifyChat(text, true)).toBeNull();
  });

  it("only skips empty text when the filter is off", () => {
    for (const text of ["666", "!!!!!!", "😀"]) expect(classifyChat(text, false)).toBeNull();
    expect(classifyChat("   ", false)).toBe("empty");
    expect(classifyChat("", true)).toBe("empty");
  });
});

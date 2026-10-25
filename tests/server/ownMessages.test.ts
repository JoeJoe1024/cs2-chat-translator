import { afterEach, describe, expect, it } from "vitest";
import { bootApp, until, type Harness } from "../fixtures/harness";

describe("own messages and translation", () => {
  let h: Harness;
  afterEach(async () => {
    await h?.stop();
  });
  const updates = () => h.events.filter((e) => e.type === "translation").map((e) => (e as unknown as { update: { reason?: string; status: string } }).update);

  it("by default my own lines are translated like everyone else's and nothing is hidden", async () => {
    h = await bootApp({ persona: ["Me"] });
    expect(h.app.publicSettings().general).toMatchObject({ translateOwnMessages: true, hideOwnMessages: false });
    await h.writeLog(["[ALL] Me: my own words"]);
    await until(() => h.fetchMock.mock.calls.length >= 1);
    expect(updates().some((u) => u.reason === "own-message")).toBe(false);
  });

  it("an authorised name is not translated when the option is on, or when hidden; others still are", async () => {
    h = await bootApp({ persona: ["Me"] });
    await h.app.updateSettings({ general: { translateOwnMessages: false } });
    await h.writeLog(["[ALL] Me: my own words", "[ALL] Alice: hola"]);
    await until(() => updates().length >= 2 && h.fetchMock.mock.calls.length >= 1);
    expect(updates().some((u) => u.reason === "own-message")).toBe(true);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);

    await h.app.updateSettings({ general: { translateOwnMessages: true } });
    await h.writeLog(["[ALL] Me: translated now"]);
    await until(() => h.fetchMock.mock.calls.length >= 2);

    await h.app.updateSettings({ general: { hideOwnMessages: true } });
    const before = updates().length;
    await h.writeLog(["[ALL] Me: hidden, so no request"]);
    await until(() => updates().length > before);
    expect(updates().at(-1)).toMatchObject({ status: "skipped", reason: "own-message" });
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("my line is recognised despite the invisible mark the game puts after names; Joe2 is a different player", async () => {
    h = await bootApp({ persona: ["Joe"], authorize: false });
    await h.app.updateSettings({ cs2: { selfNames: ["Joe"] }, general: { translateOwnMessages: false } });
    await h.writeLog(["[ALL] Joe‎: 777", "[ALL] Joe2‎: hola amigo"]);
    await until(() => updates().length >= 2 && h.fetchMock.mock.calls.length >= 1);
    expect(updates().filter((u) => u.reason === "own-message")).toHaveLength(1);
    expect(h.fetchMock).toHaveBeenCalledTimes(1); // only Joe2 reached the translation engine
    const chats = h.events.filter((e) => e.type === "chat").map((e) => (e as unknown as { message: { sender: string; isSelf: boolean } }).message);
    expect(chats.map((c) => [c.sender, c.isSelf])).toEqual([["Joe", true], ["Joe2", false]]);
  });

  it("a name that is only the Steam name is not trusted: it is still translated", async () => {
    h = await bootApp({ authorize: false, persona: ["Joe"] });
    await h.writeLog(["[ALL] Joe: hola amigo"]);
    await until(() => h.fetchMock.mock.calls.length >= 1);
    expect(updates().some((u) => u.reason === "own-message")).toBe(false);
  });
});

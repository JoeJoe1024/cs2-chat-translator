import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectLocalNameInLog, localNameFromLine } from "../../src/cs2/identity";
import { bootApp, type Harness } from "../fixtures/harness";

const LOOP = (name: string, n = 0) => `10/22 23:32:33 [NetSteamConn] Associating NetChan ${name} @ loopback:${n} (loopback:${n}) with Steam Net Connection handle #28810`;

describe("local player name from the game's own log", () => {
  it("reads the name from the engine's loopback line", () => {
    expect(localNameFromLine(LOOP("咕咕嘎嘎"))).toBe("咕咕嘎嘎");
    expect(localNameFromLine(LOOP("Joe", 1))).toBe("Joe");
    expect(localNameFromLine(LOOP("Name With Spaces"))).toBe("Name With Spaces");
  });

  it("ignores the server's channel and lines that are not the engine's", () => {
    expect(localNameFromLine(LOOP("server", 1))).toBeNull();
    expect(localNameFromLine("10/22 23:32:33 [Networking] Joe @ loopback:0:  NetChan Setting Timeout to 20.00 seconds")).toBeNull();
    expect(localNameFromLine("10/22 23:40:01  [ALL] Mallory: [NetSteamConn] Associating NetChan Boss @ loopback:0 (loopback:0) with Steam Net Connection handle #1")).toBeNull();
    expect(localNameFromLine("Associating NetChan Boss @ loopback:0 (loopback:0) with Steam Net Connection handle #1")).toBeNull();
  });

  it("refuses names crafted to smuggle a second '@ loopback' structure", () => {
    expect(localNameFromLine(LOOP("Alias @ loopback:0 (loopback:0) with x"))).toBeNull();
    expect(localNameFromLine(LOOP("Foo @ bar"))).toBeNull();
  });

  it("takes the most recent confirmation in a log file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs2t-id-"));
    const log = path.join(dir, "console.log");
    await fs.writeFile(log, [LOOP("Old Name"), "noise", LOOP("server", 1), LOOP("New Name")].join("\n"));
    expect(await detectLocalNameInLog(log)).toBe("New Name");
    expect(await detectLocalNameInLog(path.join(dir, "missing.log"))).toBeNull();
  });
});

describe("which name counts as me", () => {
  let h: Harness;
  afterEach(async () => {
    await h?.stop();
  });

  it("does not trust the Steam name by itself: it is only a suggestion", async () => {
    h = await bootApp({ authorize: false, persona: ["Joe"] });
    const id = h.app.identity();
    expect(id).toMatchObject({ authorized: [], manual: [], steam: "Joe", suggestSteam: true, logConfirmed: null });
  });

  it("accepts the Steam name once the user explicitly confirms it", async () => {
    h = await bootApp({ authorize: false, persona: ["Joe"] });
    await h.app.updateSettings({ cs2: { selfNames: ["Joe"] } });
    expect(h.app.identity()).toMatchObject({ authorized: ["Joe"], suggestSteam: false });
  });

  it("does not let chat text pose as the engine's confirmation line", async () => {
    h = await bootApp({ authorize: false, persona: [] });
    await h.writeLog(["[ALL] Mallory: Associating NetChan Mallory @ loopback:0 (loopback:0) with Steam Net Connection handle #1"]);
    await new Promise((r) => setTimeout(r, 150));
    expect(h.app.identity().logConfirmed).toBeNull();
  });

  it("keeps a manually entered name across a restart", async () => {
    h = await bootApp({ authorize: false });
    await h.app.updateSettings({ cs2: { selfNames: ["新名字"] } });
    const { App } = await import("../../src/server/app");
    const { MemorySecretStore } = await import("../../src/config/secrets");
    const again = new App({ configDir: path.join(h.dir, "config"), secrets: new MemorySecretStore(), installs: [], personaNames: ["Steamy"] });
    await again.init();
    expect(again.identity()).toMatchObject({ authorized: ["新名字"], manual: ["新名字"], steam: "Steamy" });
    await again.close();
  });
});

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DpapiSecretStore, MemorySecretStore } from "../../src/config/secrets";
import { App } from "../../src/server/app";
// @ts-expect-error plain ESM script without type declarations
import * as secretScan from "../../scripts/lib/secret-scan.mjs";
import { bootWeb, until, type WebHarness } from "../fixtures/harness";

const findSecretLeaks = (secretScan as { findSecretLeaks: (root: string) => string[] }).findSecretLeaks;
const KEY = "AIzaSyDUMMY_KEY_FOR_TESTS_0123456789";
const OTHER_KEY = "AIzaSyOTHER_KEY_FOR_TESTS_ABCDEFGHIJ";
const WIN = process.platform === "win32";
const tmp = (p = "cs2t-sec-") => fs.mkdtemp(path.join(os.tmpdir(), p));

/** Encrypts `secret` with DPAPI like the app does, but with options the app never uses (another entropy / machine scope). */
function dpapiBlob(secret: string, opts: { entropy?: string; scope?: "CurrentUser" | "LocalMachine" }): string {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$data = [System.Text.Encoding]::UTF8.GetBytes($env:CS2T_T_SECRET)
$entropy = if ($env:CS2T_T_ENTROPY) { [System.Text.Encoding]::UTF8.GetBytes($env:CS2T_T_ENTROPY) } else { $null }
[Console]::Out.Write([Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect($data, $entropy, $env:CS2T_T_SCOPE)))`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    encoding: "utf8",
    env: { ...process.env, CS2T_T_SECRET: secret, CS2T_T_ENTROPY: opts.entropy ?? "", CS2T_T_SCOPE: opts.scope ?? "CurrentUser" },
  });
  if (r.status !== 0) throw new Error(`could not create test blob: ${r.stderr}`);
  return r.stdout.trim();
}

function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const f = path.join(dir, n);
    return statSync(f).isDirectory() ? allFiles(f) : [f];
  });
}

const DPAPI_PROVIDER = Buffer.from("d08c9ddf0115d1118c7a00c04fc297eb", "hex"); // {D08C9DDF-0115-11D1-8C7A-00C04FC297EB}, bytes as stored
/** DPAPI blob header: version(4) provider(16) masterKeyVersion(4) masterKeyGuid(16) flags(4)… */
const blobFlags = (b64: string) => Buffer.from(b64, "base64").readUInt32LE(40);
const CRYPTPROTECT_LOCAL_MACHINE = 0x4;

describe.skipIf(!WIN)("DPAPI secret store (real Windows DPAPI)", () => {
  it("encrypts for the CURRENT USER only (not the machine), with the standard DPAPI provider", async () => {
    const dir = await tmp();
    await new DpapiSecretStore(dir).set("k", KEY);
    const blob = (JSON.parse(await fs.readFile(path.join(dir, "secrets.dpapi.json"), "utf8")) as Record<string, string>).k!;
    const bytes = Buffer.from(blob, "base64");
    expect(bytes.subarray(4, 20).equals(DPAPI_PROVIDER)).toBe(true);
    expect(blobFlags(blob) & CRYPTPROTECT_LOCAL_MACHINE).toBe(0);
    // sanity check of the header layout: a machine-scope blob does carry the flag
    expect(blobFlags(dpapiBlob("x", { scope: "LocalMachine" })) & CRYPTPROTECT_LOCAL_MACHINE).toBe(CRYPTPROTECT_LOCAL_MACHINE);
  }, 60000);

  it("never leaves the key in plain text, in any file or temp file", async () => {
    const dir = await tmp();
    const store = new DpapiSecretStore(dir);
    await store.set("k", KEY);
    await store.set("k", OTHER_KEY); // replacing must not leave the old one around either
    for (const f of allFiles(dir)) {
      const text = readFileSync(f).toString("latin1");
      for (const secret of [KEY, OTHER_KEY]) {
        expect(text, f).not.toContain(secret);
        expect(text, f).not.toContain(Buffer.from(secret).toString("base64"));
      }
    }
    expect(allFiles(dir).map((f) => path.basename(f))).toEqual(["secrets.dpapi.json"]); // no .tmp / backup left behind
  }, 60000);

  it("round-trips across instances and keeps the on-disk format stable (older saved keys keep working)", async () => {
    const dir = await tmp();
    await new DpapiSecretStore(dir).set("gemini-api-key", KEY);
    const raw = JSON.parse(await fs.readFile(path.join(dir, "secrets.dpapi.json"), "utf8")) as Record<string, string>;
    expect(Object.keys(raw)).toEqual(["gemini-api-key"]);
    expect(raw["gemini-api-key"]).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(await new DpapiSecretStore(dir).inspect("gemini-api-key")).toEqual({ state: "ready", value: KEY });
    // a file written by an earlier version of the app (same format, made directly) is read as before
    const legacyDir = await tmp();
    writeFileSync(path.join(legacyDir, "secrets.dpapi.json"), JSON.stringify({ "gemini-api-key": dpapiBlob(KEY, {}) }));
    expect(await new DpapiSecretStore(legacyDir).get("gemini-api-key")).toBe(KEY);
  }, 60000);

  describe("data copied to another PC or Windows account", () => {
    // DPAPI keys are per user; a blob that this user's keys cannot open behaves exactly like one from another user/PC.
    const foreign = () => dpapiBlob(KEY, { entropy: "a-different-user-or-machine" });

    it("is reported as unreadable, never decrypted, never replaced by a fallback, and left in place", async () => {
      const dir = await tmp();
      const blob = foreign();
      const file = path.join(dir, "secrets.dpapi.json");
      writeFileSync(file, JSON.stringify({ k: blob }));
      const store = new DpapiSecretStore(dir);
      expect(await store.inspect("k")).toEqual({ state: "unreadable" });
      expect(await store.get("k")).toBeNull();
      expect(await store.inspect("missing")).toEqual({ state: "absent" });
      const after = readFileSync(file, "utf8");
      expect(JSON.parse(after)).toEqual({ k: blob }); // untouched: nothing valid is deleted by accident
      expect(after).not.toContain(KEY);
    }, 60000);

    it("garbage, truncated, tampered and non-base64 data are unreadable too, without crashing", async () => {
      const dir = await tmp();
      const good = dpapiBlob(KEY, {});
      const tampered = Buffer.from(good, "base64");
      tampered[tampered.length - 5] = (tampered[tampered.length - 5] ?? 0) ^ 0xff;
      writeFileSync(
        path.join(dir, "secrets.dpapi.json"),
        JSON.stringify({ a: "AAAA", b: good.slice(0, 40), c: tampered.toString("base64"), d: "not base64 !!", e: 42, f: "" }),
      );
      const store = new DpapiSecretStore(dir);
      for (const name of ["a", "b", "c", "d"]) expect(await store.inspect(name), name).toEqual({ state: "unreadable" });
      expect((await store.inspect("e")).state).toBe("absent");
      expect((await store.inspect("f")).state).toBe("absent");
      writeFileSync(path.join(dir, "secrets.dpapi.json"), "{ this is not json");
      expect(await new DpapiSecretStore(dir).inspect("a")).toEqual({ state: "absent" });
    }, 120000);

    it("entering the key again (same or different) encrypts it afresh for this user; removing clears it", async () => {
      const dir = await tmp();
      const file = path.join(dir, "secrets.dpapi.json");
      const old = foreign();
      writeFileSync(file, JSON.stringify({ k: old }));
      const store = new DpapiSecretStore(dir);
      expect((await store.inspect("k")).state).toBe("unreadable");

      await store.set("k", KEY); // the same key typed again
      const fresh = (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>).k!;
      expect(fresh).not.toBe(old);
      expect(await store.inspect("k")).toEqual({ state: "ready", value: KEY });
      expect(await new DpapiSecretStore(dir).get("k")).toBe(KEY);

      writeFileSync(file, JSON.stringify({ k: old }));
      await new DpapiSecretStore(dir).set("k", OTHER_KEY); // or a different one
      expect(await new DpapiSecretStore(dir).get("k")).toBe(OTHER_KEY);

      await store.delete("k");
      expect(await new DpapiSecretStore(dir).inspect("k")).toEqual({ state: "absent" });
      expect(readFileSync(file, "utf8")).toBe("{}");
    }, 120000);

    it("the app asks for the key again instead of using, guessing or silently dropping it", async () => {
      const dir = await tmp();
      mkdirSync(path.join(dir, "cfg"));
      writeFileSync(path.join(dir, "secrets.dpapi.json"), JSON.stringify({ "gemini-api-key": foreign() }));
      const calls: string[] = [];
      const fetchMock = async (url: unknown, init?: RequestInit) => {
        calls.push(String(url));
        const q = new URLSearchParams(String(init?.body)).get("q") ?? "";
        return new Response(JSON.stringify([[[`T(${q})`, q]], null, "ja"]), { status: 200 });
      };
      const app = new App({ configDir: dir, secrets: new DpapiSecretStore(dir), fetchImpl: fetchMock as typeof fetch, installs: [], personaNames: [] });
      const events: string[] = [];
      const emit = app.hub.emit.bind(app.hub);
      app.hub.emit = (e) => {
        if (e.type === "notice") events.push(e.code);
        emit(e);
      };
      await app.init();
      try {
        expect(app.publicSettings().secrets).toEqual({ geminiKeyConfigured: false, geminiKeyState: "reenter" });
        expect(await app.testGeminiKey()).toEqual({ ok: false, code: "auth" });
        expect((await app.refreshGeminiModels()).code).toBe("auth");

        // choosing Gemini does not break translation: it falls back to Google, and says why
        await app.updateSettings({ translation: { sendEngine: "gemini" } });
        const out = await app.translateForSend("buenos dias", "en");
        expect(out).toMatchObject({ status: "done", engineUsed: "google" });
        expect(events).toContain("gemini-key-unreadable");
        expect(calls.every((u) => u.includes("translate.googleapis.com"))).toBe(true);

        // typing the key again fixes it
        await app.setGeminiKey(KEY);
        expect(app.publicSettings().secrets).toEqual({ geminiKeyConfigured: true, geminiKeyState: "configured" });
        for (const f of allFiles(dir)) expect(readFileSync(f).toString("latin1"), f).not.toContain(KEY);
      } finally {
        await app.close();
      }
      const again = new App({ configDir: dir, secrets: new DpapiSecretStore(dir), installs: [], personaNames: [] });
      await again.init();
      expect(again.publicSettings().secrets.geminiKeyState).toBe("configured");
      await again.close();
    }, 120000);

    it("removing an unreadable key is allowed and ends the 're-enter' state", async () => {
      const dir = await tmp();
      writeFileSync(path.join(dir, "secrets.dpapi.json"), JSON.stringify({ "gemini-api-key": foreign() }));
      const app = new App({ configDir: dir, secrets: new DpapiSecretStore(dir), installs: [], personaNames: [] });
      await app.init();
      expect(app.publicSettings().secrets.geminiKeyState).toBe("reenter");
      await app.clearGeminiKey();
      expect(app.publicSettings().secrets.geminiKeyState).toBe("missing");
      await app.close();
    }, 120000);
  });
});

describe("memory secret store (non-Windows fallback)", () => {
  it("reports the same states and never persists", async () => {
    const s = new MemorySecretStore();
    expect(await s.inspect("k")).toEqual({ state: "absent" });
    await s.set("k", KEY);
    expect(await s.inspect("k")).toEqual({ state: "ready", value: KEY });
    await s.delete("k");
    expect(await s.get("k")).toBeNull();
  });
});

describe("the key never leaves the backend", () => {
  let h: WebHarness;
  afterEach(async () => {
    await h?.stop();
    vi.restoreAllMocks();
  });

  it("is absent from every API answer, event, error, log line and settings file", async () => {
    const out: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(" ")));

    // A provider that echoes the key back inside its error text: the worst case for accidental leaks.
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("generativelanguage.googleapis.com")) return new Response(JSON.stringify({ error: { message: `API key ${KEY} is not valid` } }), { status: 403 });
      return new Response(JSON.stringify([[["ok", "ok"]], null, "ja"]), { status: 200 });
    });
    h = await bootWeb({ fetchMock: fetchMock as never });
    const seen: string[] = [];
    const api = async (p: string, init: RequestInit = {}) => {
      const r = await fetch(h.base + p, { ...init, headers: { "x-cs2t-token": h.token, "content-type": "application/json" } });
      const text = await r.text();
      seen.push(`${init.method ?? "GET"} ${p} -> ${r.status} ${text}`);
      return text;
    };

    const events: string[] = [];
    const stream = await fetch(h.base + "/api/events", { headers: { "x-cs2t-token": h.token } });
    const reader = stream.body!.getReader();
    void (async () => {
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        events.push(dec.decode(value));
      }
    })();

    await api("/api/secrets/gemini", { method: "PUT", body: JSON.stringify({ apiKey: KEY }) });
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ translation: { sendEngine: "gemini", chatEngine: "gemini" } }) });
    await api("/api/state");
    await api("/api/gemini/models");
    await api("/api/gemini/models/refresh", { method: "POST", body: "{}" });
    await api("/api/secrets/gemini/test", { method: "POST", body: "{}" });
    await api("/api/secrets/gemini/test", { method: "POST", body: JSON.stringify({ apiKey: OTHER_KEY }) });
    await api("/api/translate", { method: "POST", body: JSON.stringify({ text: "hola amigo", target: "en" }) });
    await h.writeLog(["[ALL] Alice: hola amigo"]);
    await until(() => events.join("").includes('"translation"'), 8000);
    await api("/api/secrets/gemini", { method: "PUT", body: JSON.stringify({ apiKey: "short" }) }); // validation error echo
    await api("/api/state");
    await reader.cancel();

    for (const text of [...seen, ...events, ...out]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(OTHER_KEY);
      expect(text).not.toContain("AIza");
    }
    // settings.json is the file people share when asking for help: it holds no secret at all
    const settingsFile = await fs.readFile(path.join(h.dir, "config", "settings.json"), "utf8");
    expect(settingsFile).not.toMatch(/AIza|apiKey|secret/i);
    expect(JSON.parse(settingsFile).translation.geminiModel).toBeTruthy();
    const state = JSON.parse(await api("/api/state"));
    expect(state.settings.secrets).toEqual({ geminiKeyConfigured: true, geminiKeyState: "configured" });
  }, 60000);
});

describe("release folders carry no private data", () => {
  const make = (files: Record<string, string>) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cs2t-rel-"));
    for (const [name, content] of Object.entries(files)) {
      const f = path.join(dir, name);
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, content);
    }
    return dir;
  };

  it("passes a clean portable layout", () => {
    const dir = make({ "start.bat": "@echo off", "dist/server.mjs": 'headers: { "x-goog-api-key": key }', "dist/web/index.html": "<html></html>", "runtime/LICENSE-node.txt": "MIT", "scripts/messages/no-node.txt": "x", "README.md": "# hi" });
    expect(findSecretLeaks(dir)).toEqual([]);
  });

  it.each([
    ["secrets.dpapi.json", "{}"],
    ["config/settings.json", "{}"],
    ["settings.json.corrupt-1", "{}"],
    ["instance.json", "{}"],
    ["gemini-models.json", "{}"],
    ["chat-templates.json", "{}"],
    [".env", "X=1"],
    ["id.pem", "x"],
    ["old/config.json", "{}"],
  ])("refuses a release containing %s", (name, content) => {
    expect(findSecretLeaks(make({ "start.bat": "x", [name]: content })).length).toBeGreaterThan(0);
  });

  it.each([
    ["notes.txt", `my key is ${KEY}`],
    ["dist/app.js", `const k = "${KEY}";`],
    ["x.json", '{"apiKey":"sk-abcdefghijkl"}'],
    ["a.md", 'curl -H "x-goog-api-key: abcdefghijklmnopqrstuvwxyz123456"'],
    ["k.txt", "-----BEGIN RSA PRIVATE KEY-----"],
  ])("refuses secret-looking text in %s", (name, content) => {
    expect(findSecretLeaks(make({ [name]: content })).some((p) => p.startsWith("secret-looking text"))).toBe(true);
  });

  it("the real bundle and the real portable folder (when built) are clean", () => {
    for (const d of ["dist", "release/cs2-chat-translator-portable"]) {
      if (existsSync(d)) expect(findSecretLeaks(d), d).toEqual([]);
    }
  });
});

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * `absent`     nothing saved
 * `ready`      saved and decrypted
 * `unreadable` something IS saved but cannot be decrypted here (copied from another PC or Windows account, damaged).
 *              The stored data is left untouched; the user is asked to enter the key again.
 */
export type SecretState = "absent" | "ready" | "unreadable";

export interface SecretInspection {
  state: SecretState;
  /** Only when `state` is `ready`. */
  value?: string;
}

/** Storage for the Gemini API key. Implementations must never log the value. */
export interface SecretStore {
  readonly kind: "dpapi" | "memory-only";
  inspect(name: string): Promise<SecretInspection>;
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export class MemorySecretStore implements SecretStore {
  readonly kind = "memory-only" as const;
  private readonly values = new Map<string, string>();

  async inspect(name: string): Promise<SecretInspection> {
    const value = this.values.get(name);
    return value === undefined ? { state: "absent" } : { state: "ready", value };
  }
  async get(name: string): Promise<string | null> {
    return this.values.get(name) ?? null;
  }
  async set(name: string, value: string): Promise<void> {
    this.values.set(name, value);
  }
  async delete(name: string): Promise<void> {
    this.values.delete(name);
  }
}

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$mode = $args[0]
$inputText = [Console]::In.ReadToEnd().Trim()
if ($mode -eq 'protect') {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($inputText)
  $out = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
  [Console]::Out.Write([Convert]::ToBase64String($out))
} else {
  $bytes = [Convert]::FromBase64String($inputText)
  $out = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')
  [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($out))
}
`;

function runPowerShell(mode: "protect" | "unprotect", stdin: string, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    // The secret travels over stdin only, never argv, so it cannot show up in process listings.
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `& { ${PS_SCRIPT} } ${mode}`],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("DPAPI helper timed out"));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`DPAPI helper failed (${code}): ${err.trim().slice(0, 200)}`));
    });
    child.stdin.end(stdin);
  });
}

/**
 * Windows DPAPI (CurrentUser scope) via PowerShell. The encrypted blob can only be decrypted by the
 * same Windows user on the same machine. Plain keys are never written to disk.
 */
export class DpapiSecretStore implements SecretStore {
  readonly kind = "dpapi" as const;
  private readonly file: string;
  private cache: Record<string, string> | null = null;

  constructor(dir: string) {
    this.file = path.join(dir, "secrets.dpapi.json");
  }

  private async load(): Promise<Record<string, string>> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await fs.readFile(this.file, "utf8")) as Record<string, string>;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private async save(blobs: Record<string, string>): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(blobs), "utf8");
    await fs.rename(tmp, this.file);
    this.cache = blobs;
  }

  /**
   * Decrypts with the CURRENT Windows user's DPAPI keys. A blob made by another user or on another PC fails here;
   * that is reported as `unreadable`. There is deliberately no fallback of any kind: no plain-text copy, no default
   * key, no skipped check. The undecryptable blob is kept so nothing valid is ever deleted by accident.
   */
  async inspect(name: string): Promise<SecretInspection> {
    const blob = (await this.load())[name];
    if (typeof blob !== "string" || blob === "") return { state: "absent" };
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) return { state: "unreadable" };
    try {
      return { state: "ready", value: await runPowerShell("unprotect", blob) };
    } catch {
      return { state: "unreadable" };
    }
  }

  async get(name: string): Promise<string | null> {
    return (await this.inspect(name)).value ?? null;
  }

  async set(name: string, value: string): Promise<void> {
    const blob = await runPowerShell("protect", value);
    await this.save({ ...(await this.load()), [name]: blob });
  }

  async delete(name: string): Promise<void> {
    const { [name]: _removed, ...rest } = await this.load();
    await this.save(rest);
  }
}

export function createSecretStore(dir: string): SecretStore {
  return process.platform === "win32" ? new DpapiSecretStore(dir) : new MemorySecretStore();
}

import { spawn } from "node:child_process";

export type PickKind = "file" | "folder";

/**
 * Native Windows file / folder chooser. Browsers cannot reveal a real path (a web <input type=file> only exposes a
 * file name), so the local service opens the standard Windows dialog itself.
 *
 * Safety: the PowerShell script below is a CONSTANT. The only inputs are three environment variables (kind, initial
 * folder, window title); none is ever interpolated into a command string, and the result is just printed back.
 */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
if ($env:CS2T_PICK_DRYRUN -eq '1') { [Console]::Out.Write('ok'); exit 0 }
$kind = $env:CS2T_PICK_KIND
$initial = $env:CS2T_PICK_INITIAL
$title = $env:CS2T_PICK_TITLE
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.WindowState = 'Minimized'
$owner.Show()
try {
  if ($kind -eq 'file') {
    $d = New-Object System.Windows.Forms.OpenFileDialog
    if ($title) { $d.Title = $title }
    $d.Filter = 'console.log|console.log|Log files (*.log)|*.log|All files (*.*)|*.*'
    $d.CheckFileExists = $true
    $d.Multiselect = $false
    if ($initial -and (Test-Path -LiteralPath $initial -PathType Container)) { $d.InitialDirectory = $initial }
    if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.FileName) }
  } elseif ($kind -eq 'folder') {
    $d = New-Object System.Windows.Forms.FolderBrowserDialog
    if ($title) { $d.Description = $title }
    $d.ShowNewFolderButton = $false
    if ($initial -and (Test-Path -LiteralPath $initial -PathType Container)) { $d.SelectedPath = $initial }
    if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }
  } else { exit 2 }
} finally { $owner.Dispose() }
`;

const ENCODED = Buffer.from(SCRIPT, "utf16le").toString("base64");
const TIMEOUT_MS = 10 * 60_000;

export class PickerBusyError extends Error {}
export class PickerUnsupportedError extends Error {}

let busy = false;

/** Strips control characters and limits length of text that becomes a dialog title. */
export function safeTitle(title: string | undefined): string {
  return [...(title ?? "")].filter((c) => c.charCodeAt(0) >= 32).join("").slice(0, 120);
}

export interface PickOptions {
  kind: PickKind;
  initialDir?: string;
  title?: string;
  dryRun?: boolean;
}

/** Resolves with the chosen path, or null when the user cancelled. Only one dialog can be open at a time. */
export function pickPath(opts: PickOptions): Promise<string | null> {
  if (process.platform !== "win32") return Promise.reject(new PickerUnsupportedError("Native dialogs need Windows"));
  if (busy) return Promise.reject(new PickerBusyError("A dialog is already open"));
  busy = true;
  return new Promise<string | null>((resolve, reject) => {
    const child = spawn("powershell.exe", ["-STA", "-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CS2T_PICK_KIND: opts.kind,
        CS2T_PICK_INITIAL: opts.initialDir ?? "",
        CS2T_PICK_TITLE: safeTitle(opts.title),
        CS2T_PICK_DRYRUN: opts.dryRun ? "1" : "0",
      },
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    const done = () => {
      clearTimeout(timer);
      busy = false;
    };
    child.on("error", (e) => {
      done();
      reject(e);
    });
    child.on("close", (code) => {
      done();
      if (code !== 0) return reject(new Error(`Dialog helper failed (${code}): ${err.trim().slice(0, 200)}`));
      resolve(out.trim() || null);
    });
  });
}

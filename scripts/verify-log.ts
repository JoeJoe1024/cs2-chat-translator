/**
 * Checks the chat-format detector against a REAL console.log from your own CS2 install.
 *   npm run verify-log               (auto-detects CS2)
 *   npm run verify-log -- "D:\path\to\console.log"
 * Chat only appears in console.log after you (or others) chatted in a match, so chat first, then run this.
 * It prints counts only and a few lines with player names/messages MASKED; nothing is stored or sent anywhere.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { configDir } from "../src/config/paths";
import { ChatFormatDetector } from "../src/cs2/chat/detector";
import { ChatLocalization } from "../src/cs2/chat/localization";
import { collectGameLanguageEvidence } from "../src/cs2/gameLanguage";
import { findCs2Install } from "../src/cs2/steam";

const install = await findCs2Install();
const logPath = process.argv[2] ?? install?.logPath;
if (!logPath) {
  console.error("CS2 was not found. Pass the console.log path as an argument.");
  process.exit(1);
}

const vpkDir = install?.vpkDir ?? path.dirname(logPath);
const localization = new ChatLocalization(vpkDir, path.join(configDir(), "chat-templates.json"));
const detector = new ChatFormatDetector(localization);
const evidence = await collectGameLanguageEvidence(install, logPath);
await detector.configure({ mode: "auto", manual: { ct: "CT", t: "T", all: "ALL" }, evidence });
await detector.whenFullyLoaded();

const lines = (await fs.readFile(logPath, "utf8")).split(/\r?\n/);
const mask = (s: string) => s.replace(/\S/g, "•");
let chat = 0;
const samples: string[] = [];
for (const line of lines) {
  const parsed = detector.parse(line);
  if (!parsed) continue;
  chat++;
  if (samples.length < 5) samples.push(`${parsed.formatId}  channel=${parsed.channel}  dead=${parsed.dead}  sender=${mask(parsed.sender)}  text=${mask(parsed.text)}`);
}

const status = detector.status();
console.log(`Log:              ${logPath}`);
console.log(`Lines:            ${lines.length}`);
console.log(`Game language:    ${status.detectedLanguage ?? "unknown"} (${status.evidence.map((e) => e.source).join(", ") || "no evidence"})`);
console.log(`Templates from:   ${status.templateSource}`);
console.log(`Chat lines found: ${chat}`);
for (const m of status.matched) console.log(`  ${String(m.count).padStart(5)} × ${m.formatId}`);
if (samples.length) console.log("Samples (masked):\n  " + samples.join("\n  "));
if (status.unrecognized.length) {
  console.log("Lines that look like chat but matched nothing (NOT treated as chat):");
  for (const u of status.unrecognized) console.log(`  ${String(u.count).padStart(5)} × [${u.tag}]`);
}
if (chat === 0) console.log("\nNo chat lines yet. Chat in a match (or a bot match), then run this again.");

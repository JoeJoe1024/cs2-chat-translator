#!/usr/bin/env node
/**
 * CS2 Chat Translator (CLI + Web GUI + Gemini API Fix)
 * ====================================================
 */

import fs from "fs";
import http from "http";
import readline from "readline";
import { exec as execChild, execSync } from "child_process";
import { GoogleGenAI } from "@google/genai";
import translate from "google-translate-api-x";
import crypto from "crypto";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import chalk from "chalk";
import * as fuzz from "fuzzball";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let _cachedMachineKey = null;

function _machineKey() {
  if (_cachedMachineKey) return _cachedMachineKey;

  let hardwareId = "";
  try {
    // 主機板序號
    const mb = execSync("wmic baseboard get serialnumber /value", { timeout: 3000 })
      .toString().replace(/\s+/g, "").replace("SerialNumber=", "");
    // BIOS 序號
    const bios = execSync("wmic bios get serialnumber /value", { timeout: 3000 })
      .toString().replace(/\s+/g, "").replace("SerialNumber=", "");
    hardwareId = mb + bios;
  } catch { /* ignore */ }

  // WMIC 失敗或序號為空／無效則回退到 hostname + username
  if (!hardwareId || hardwareId === "None" || hardwareId.length < 4) {
    hardwareId = os.hostname() + (os.userInfo().username || "");
  }

  const seed = hardwareId + "cs2-translator-salt-v1";
  _cachedMachineKey = crypto.createHash("sha256").update(seed).digest();
  return _cachedMachineKey;
}

function encryptApiKey(plain) {
  if (!plain) return "";
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-cbc", _machineKey(), iv);
    const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return "enc:" + iv.toString("hex") + ":" + enc.toString("hex");
  } catch { return plain; }
}

function decryptApiKey(stored) {
  if (!stored) return "";
  if (!stored.startsWith("enc:")) return stored; // 舊版明文，直接讀
  try {
    const parts = stored.slice(4).split(":");
    const iv = Buffer.from(parts[0], "hex");
    const enc = Buffer.from(parts[1], "hex");
    const decipher = crypto.createDecipheriv("aes-256-cbc", _machineKey(), iv);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch { return ""; }
}

let LOG_PATH = "";
let CSGO_CFG_DIR = "";
let CHAT_CFG = "";
let BIND_KEY = "l";
let AUTO_TRANSLATE_TARGET = "en";
let AUTO_TRANSLATE = true;
let TRANSLATION_PAUSED = false;

let TAG_CT = "CT";
let TAG_T = "T";
let TAG_ALL = "ALL";
let TAG_REGEX = null;

function escapeForRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rebuildTagRegex() {
  const tags = [TAG_CT, TAG_T, TAG_ALL].filter((t) => t && String(t).trim().length);
  if (!tags.length) { TAG_REGEX = null; return; }
  const alt = tags.map(escapeForRegex).join("|");
  TAG_REGEX = new RegExp(`\\[(${alt})\\]\\s+(.*?)\\s*(?:@[^:：]+)?\\s*[:：]\\s*(.+)`);
}

const CONFIG_DIR = path.join(__dirname, "..");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

function guessCs2Root() {
  const home = os.homedir();
  if (process.platform === "win32") {
    // Windows：Steam 預設裝在 Program Files (x86) 或 C:\Steam
    const candidates = [
      "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo",
      "C:\\Program Files\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo",
      "D:\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo",
      "D:\\SteamLibrary\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo",
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return candidates[0]; // 找不到就回傳最常見的路徑當預設
  } else if (process.platform === "darwin") {
    return path.join(home, "Library/Application Support/Steam/steamapps/common/Counter-Strike Global Offensive/game/csgo");
  } else {
    return path.join(home, ".local/share/Steam/steamapps/common/Counter-Strike Global Offensive/game/csgo");
  }
}
const guessedRoot = guessCs2Root();

const defaultConfig = {
  logPath: path.join(guessedRoot, "console.log"),
  cfgDir: path.join(guessedRoot, "cfg"),
  bindKey: "kp_plus",
  autoTranslate: true,
  autoTranslateTarget: "en",
  tagCT: "CT",
  tagT: "T",
  tagAll: "ALL",
  uiLang: "en",
  apiKey: "",
  engine: "google",
  sendEngine: "google",
  chatEngine: "google"
};

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { ...defaultConfig };
    const txt = fs.readFileSync(CONFIG_PATH, "utf8").trim();
    if (!txt) return { ...defaultConfig };
    const cfg = JSON.parse(txt);
    return {
      logPath: cfg.logPath || defaultConfig.logPath,
      cfgDir: cfg.cfgDir || defaultConfig.cfgDir,
      bindKey: cfg.bindKey || defaultConfig.bindKey,
      autoTranslate: typeof cfg.autoTranslate === "boolean" ? cfg.autoTranslate : defaultConfig.autoTranslate,
      autoTranslateTarget: cfg.autoTranslateTarget || defaultConfig.autoTranslateTarget,
      tagCT: cfg.tagCT || defaultConfig.tagCT,
      tagT: cfg.tagT || defaultConfig.tagT,
      tagAll: cfg.tagAll || defaultConfig.tagAll,
      uiLang: cfg.uiLang || "en",
      apiKey: decryptApiKey(cfg.apiKey || ""),
      engine: cfg.apiKey ? (cfg.engine || "gemini") : "google",
      sendEngine: cfg.sendEngine || cfg.engine || defaultConfig.sendEngine,
      chatEngine: cfg.chatEngine || cfg.engine || defaultConfig.chatEngine
    };
  } catch (err) {
    console.error(chalk.red(`Failed to load config: ${err.message}`));
    return { ...defaultConfig };
  }
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const merged = {
      logPath: cfg.logPath || defaultConfig.logPath,
      cfgDir: cfg.cfgDir || defaultConfig.cfgDir,
      bindKey: cfg.bindKey || defaultConfig.bindKey,
      autoTranslate: typeof cfg.autoTranslate === "boolean" ? cfg.autoTranslate : defaultConfig.autoTranslate,
      autoTranslateTarget: cfg.autoTranslateTarget || defaultConfig.autoTranslateTarget,
      tagCT: cfg.tagCT || defaultConfig.tagCT,
      tagT: cfg.tagT || defaultConfig.tagT,
      tagAll: cfg.tagAll || defaultConfig.tagAll,
      uiLang: cfg.uiLang || "en",
      apiKey: encryptApiKey(cfg.apiKey || ""),
      engine: cfg.apiKey ? (cfg.engine || "gemini") : "google",
      sendEngine: cfg.sendEngine || defaultConfig.sendEngine,
      chatEngine: cfg.chatEngine || defaultConfig.chatEngine
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), "utf8");
    return merged;
  } catch (err) {
    console.error(chalk.red(`Failed to write config: ${err.message}`));
    process.exit(1);
  }
}

function setupFromConfig() {
  const cfg = loadConfig();
  LOG_PATH = cfg.logPath;
  CSGO_CFG_DIR = cfg.cfgDir;
  BIND_KEY = cfg.bindKey || "l";
  AUTO_TRANSLATE = cfg.autoTranslate !== false;
  AUTO_TRANSLATE_TARGET = cfg.autoTranslateTarget || "en";
  TAG_CT = cfg.tagCT || defaultConfig.tagCT;
  TAG_T = cfg.tagT || defaultConfig.tagT;
  TAG_ALL = cfg.tagAll || defaultConfig.tagAll;
  rebuildTagRegex();
  CHAT_CFG = path.join(CSGO_CFG_DIR, "chat_reader.cfg");
}

const sym = {
  start: chalk.cyan("🚀"),
  info: chalk.cyan("ℹ️"),
  ok: chalk.green("✅"),
  warn: chalk.yellow("⚠️"),
  err: chalk.red("❌"),
  chat: chalk.magenta("💬"),
  trans: chalk.blueBright("🌍"),
  cfg: chalk.white("📝")
};

function log(prefix, msg) { console.log(prefix, msg); }
function logKV(key, value) { console.log(chalk.gray(`    ${key}:`), chalk.white(value)); }

const LANG_MAP = {
  af: "Afrikaans", sq: "Albanian", am: "Amharic", ar: "Arabic", hy: "Armenian",
  az: "Azerbaijani", eu: "Basque", be: "Belarusian", bn: "Bengali", bs: "Bosnian",
  bg: "Bulgarian", ca: "Catalan", ceb: "Cebuano", ny: "Chichewa", zh: "Chinese",
  zh_cn: "Chinese (Simplified)", zh_tw: "Chinese (Traditional)", co: "Corsican",
  hr: "Croatian", cs: "Czech", da: "Danish", nl: "Dutch", en: "English",
  eo: "Esperanto", et: "Estonian", tl: "Filipino", fi: "Finnish", fr: "French",
  fy: "Frisian", gl: "Galician", ka: "Georgian", de: "German", el: "Greek",
  gu: "Gujarati", ht: "Haitian Creole", ha: "Hausa", haw: "Hawaiian", he: "Hebrew",
  hi: "Hindi", hmn: "Hmong", hu: "Hungarian", is: "Icelandic", ig: "Igbo",
  id: "Indonesian", ga: "Irish", it: "Italian", ja: "Japanese", jw: "Javanese",
  kn: "Kannada", kk: "Kazakh", km: "Khmer", rw: "Kinyarwanda", ko: "Korean",
  ku: "Kurdish (Kurmanji)", ky: "Kyrgyz", lo: "Lao", la: "Latin", lv: "Latvian",
  lt: "Lithuanian", lb: "Luxembourgish", mk: "Macedonian", mg: "Malagasy",
  ms: "Malay", ml: "Malayalam", mt: "Maltese", mi: "Maori", mr: "Marathi",
  mn: "Mongolian", my: "Myanmar (Burmese)", ne: "Nepali", no: "Norwegian",
  or: "Odia (Oriya)", ps: "Pashto", fa: "Persian", pl: "Polish", pt: "Portuguese",
  pa: "Punjabi", ro: "Romanian", ru: "Russian", sm: "Samoan", gd: "Scots Gaelic",
  sr: "Serbian", st: "Sesotho", sn: "Shona", sd: "Sindhi", si: "Sinhala",
  sk: "Slovak", sl: "Slovenian", so: "Somali", es: "Spanish", su: "Sundanese",
  sw: "Swahili", sv: "Swedish", tg: "Tajik", ta: "Tamil", tt: "Tatar", te: "Telugu",
  th: "Thai", tr: "Turkish", tk: "Turkmen", uk: "Ukrainian", ur: "Urdu",
  ug: "Uyghur", uz: "Uzbek", vi: "Vietnamese", cy: "Welsh", xh: "Xhosa",
  yi: "Yiddish", yo: "Yoruba", zu: "Zulu"
};

const sseClients = new Set();
const recentEvents = [];
const MAX_RECENT = 300;

function broadcast(type, payload) {
  const evt = { type, payload, at: Date.now() };
  recentEvents.push(evt);
  if (recentEvents.length > MAX_RECENT) recentEvents.shift();
  const data = `event: ${type}\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch { /* client gone */ }
  }
}

function escapeForCfg(text) {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function writeChatCfg({ message, team = false }) {
  const safe = escapeForCfg(message);
  const cmd = team ? `say_team "${safe}"` : `say "${safe}"`;
  fs.writeFileSync(CHAT_CFG, `// Auto-generated by CS2 Chat Translator\n${cmd}\n`, "utf8");
  log(sym.cfg, `Wrote to cfg: ${team ? "say_team" : "say"} → ${message}`);
  broadcast("cfg", { team, message });
}

function pressBindKey() { }

// -----------------------------------------------------------------------------
// 翻譯核心：依設定切換 Gemini AI 或 Google 翻譯
// engine 由呼叫者指定（"google" 或 "gemini"），若無 API Key 強制退回 google
// -----------------------------------------------------------------------------
async function smartTranslate(text, toLang = "en", engine = "google") {
  const cfg = loadConfig();
  const apiKey = cfg.apiKey || "";
  // 若指定 gemini 但無 API Key，退回 google
  const resolvedEngine = (engine === "gemini" && apiKey) ? "gemini" : "google";

  // ── Google 翻譯（免費，不需要 Key）──
  if (resolvedEngine === "google") {
    try {
      const result = await translate(text, { to: toLang });
      return { text: result.text, from: { language: { iso: result.from?.language?.iso || "auto" } } };
    } catch (err) {
      log(sym.warn, chalk.yellow(`Google Translate failed: ${err.message}`));
      broadcast("error", { message: `Google Translate failed: ${err.message}` });
      return { text, from: { language: { iso: "unknown" } } };
    }
  }

  // ── Gemini AI ──
  try {
    const ai = new GoogleGenAI({ apiKey: apiKey });
    const prompt = `Translate the following text into ${toLang === 'en' ? 'English' : toLang}. 
Please keep the translation faithful and close to the literal meaning, while ensuring it sounds natural. Only output the translated text, nothing else. Do not wrap in quotes.
Text: "${text}"`;
    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: [prompt],
    });
    const translatedText = response.text ? response.text.trim() : text;
    return { text: translatedText, from: { language: { iso: "auto" } } };
  } catch (err) {
    const msg = err.message || "";
    const isKeyError = /API.?KEY|api.?key|invalid.?key|PERMISSION_DENIED|401|403|UNAUTHENTICATED/i.test(msg);
    if (isKeyError) {
      log(sym.err, chalk.red(`Gemini API Key 錯誤: ${msg}`));
      broadcast("keyError", { message: msg });
    } else {
      log(sym.warn, chalk.yellow(`Gemini Translation failed: ${msg}`));
      broadcast("error", { message: `Gemini Translation failed: ${msg}` });
    }
    return { text, from: { language: { iso: "unknown" } } };
  }
}

function normalizeQueryLoose(s) {
  return String(s || "").toLowerCase().replace(/[_\-]+/g, " ").trim();
}

function buildLangCandidates() {
  return Object.entries(LANG_MAP).map(([code, name]) => {
    const bare = name.replace(/\s*\([^)]*\)\s*/g, "").trim();
    return { code, name, aliases: [name.toLowerCase(), bare.toLowerCase(), code.toLowerCase()] };
  });
}

function bestLangMatch(query) {
  const q = normalizeQueryLoose(query);
  if (!q) return null;
  const candidates = buildLangCandidates();
  for (const c of candidates) {
    if (c.aliases.some((a) => a === q)) return { code: c.code, name: c.name, score: 100 };
  }
  let best = null;
  for (const c of candidates) {
    const score = Math.max(...c.aliases.map((a) => fuzz.ratio(q, a)));
    if (!best || score > best.score) best = { code: c.code, name: c.name, score };
  }
  return best && best.score >= 55 ? best : null;
}

function handleCodeLang({ isTeam, message }) {
  const m = message.match(/^code[_\s]+(.+)$/i);
  if (!m) return false;
  const query = m[1].trim();
  if (!query) return true;
  const match = bestLangMatch(query);
  if (match) {
    const reply = `For ${match.name} use tm_${match.code}`;
    writeChatCfg({ message: reply, team: isTeam });
    setTimeout(pressBindKey, 150);
    broadcast("command", { kind: "code", query, reply, score: match.score });
  } else {
    const reply = `No match for "${query}". Try tm_en, tm_de...`;
    writeChatCfg({ message: reply, team: isTeam });
    setTimeout(pressBindKey, 150);
    broadcast("command", { kind: "code", query, reply, score: 0 });
  }
  return true;
}

let lastForeignMsg = null;

async function handleTm({ isTeam, sender, message }) {
  if (!/^tm_[a-z_]{2,5}\b/i.test(message)) return false;
  const [cmd, ...rest] = message.split(" ");
  const lang = cmd.slice(3).toLowerCase();
  const text = rest.join(" ").trim();
  if (!text) return true;
  const cfg2 = loadConfig();
  const sendEngine = cfg2.apiKey ? (cfg2.sendEngine || "google") : "google";
  const res = await smartTranslate(text, lang, sendEngine);
  writeChatCfg({ message: res.text, team: isTeam });
  setTimeout(pressBindKey, 150);
  broadcast("command", { kind: "tm", target: lang, from: "Auto", sender, original: text, translated: res.text });
  return true;
}

async function handleTl({ isTeam, message }) {
  if (!/^_tl\b/i.test(message)) return false;
  if (!lastForeignMsg) {
    writeChatCfg({ message: "No recent message to translate.", team: isTeam });
    setTimeout(pressBindKey, 150);
    return true;
  }
  const parts = message.split(" ");
  const target = parts[1]?.toLowerCase() || "en";
  const cfg2 = loadConfig();
  const sendEngine = cfg2.apiKey ? (cfg2.sendEngine || "google") : "google";
  const res = await smartTranslate(lastForeignMsg.message, target, sendEngine);
  const output = `${lastForeignMsg.player} said - ${res.text}`;
  writeChatCfg({ message: output, team: isTeam });
  setTimeout(pressBindKey, 150);
  broadcast("command", { kind: "tl", target, from: "Auto", sender: lastForeignMsg.player, original: lastForeignMsg.message, translated: res.text });
  return true;
}

async function autoTranslateToConsole({ team, sender, message }) {
  if (!AUTO_TRANSLATE) return;
  if (TRANSLATION_PAUSED) return;
  if (!message) return;
  if (/^(_tl\b|tm_[a-z_]{2,5}\b|code[_\s])/i.test(message)) return;
  if (/^[.\s]+$/.test(message)) return;
  const cfg2 = loadConfig();
  const chatEngine = cfg2.apiKey ? (cfg2.chatEngine || "google") : "google";
  const res = await smartTranslate(message, AUTO_TRANSLATE_TARGET, chatEngine);
  broadcast("auto", { team, sender, fromIso: "auto", fromName: "Auto", target: AUTO_TRANSLATE_TARGET, translated: res.text, original: message, engine: chatEngine });
}

async function handleLine(line) {
  if (!TAG_REGEX) return;
  const match = line.match(TAG_REGEX);
  if (!match) return;
  const [, matchedTag, player, messageRaw] = match;
  let team;
  if (matchedTag === TAG_CT) team = "CT";
  else if (matchedTag === TAG_T) team = "T";
  else team = "ALL";
  const message = (messageRaw || "").trim();
  const sender = (player || "").trim();
  const isTeam = team === "CT" || team === "T";
  broadcast("chat", { team, sender, message, rawTag: matchedTag });
  if (!/^tm_[a-z_]{2,5}\b|^_tl\b|^code[_\s]/i.test(message) && !/^[.\s]+$/.test(message)) {
    lastForeignMsg = { player: sender, message, team };
  }
  if (await handleTl({ isTeam, message })) return;
  if (handleCodeLang({ isTeam, message })) return;
  if (await handleTm({ isTeam, sender, message })) return;
  await autoTranslateToConsole({ team, sender, message });
}

let currentlyWatching = null;

function stopWatching() {
  if (currentlyWatching) {
    fs.unwatchFile(currentlyWatching);
    currentlyWatching = null;
  }
}

function startWatching() {
  stopWatching();
  if (!fs.existsSync(LOG_PATH) || !fs.existsSync(CSGO_CFG_DIR)) {
    broadcast("status", { watching: false, error: "Paths not found" });
    return false;
  }
  currentlyWatching = LOG_PATH;
  fs.watchFile(LOG_PATH, { interval: 500 }, (curr, prev) => {
    if (curr.size <= prev.size) return;
    const stream = fs.createReadStream(LOG_PATH, { start: prev.size, end: curr.size, encoding: "utf8" });
    const rl = readline.createInterface({ input: stream });
    rl.on("line", (line) => {
      Promise.resolve(handleLine(line)).catch((err) => console.error(chalk.red("Line error:"), err));
    });
  });
  broadcast("status", { watching: true, logPath: LOG_PATH });
  return true;
}

function statusSnapshot() {
  return {
    watching: !!currentlyWatching,
    logPath: LOG_PATH,
    cfgDir: CSGO_CFG_DIR,
    bindKey: BIND_KEY,
    autoTranslate: AUTO_TRANSLATE,
    autoTranslateTarget: AUTO_TRANSLATE_TARGET,
    tagCT: TAG_CT,
    tagT: TAG_T,
    tagAll: TAG_ALL,
    logExists: LOG_PATH ? fs.existsSync(LOG_PATH) : false,
    cfgDirExists: CSGO_CFG_DIR ? fs.existsSync(CSGO_CFG_DIR) : false,
    configPath: CONFIG_PATH
  };
}

// -----------------------------------------------------------------------------
// UI 多語言 — 從 locales/*.json 動態載入（啟動時讀取）
// 修改翻譯：直接編輯 locales/<語言代碼>.json，重啟後生效
// -----------------------------------------------------------------------------
const LOCALES_DIR = path.join(__dirname, "../locales");

const LOCALE_NAMES = {
  "en": "English (English)",
  "zh-TW": "Traditional Chinese (繁體中文)",
  "zh-CN": "Simplified Chinese (简体中文)",
  "ru": "Russian (Русский)",
  "de": "German (Deutsch)",
  "pl": "Polish (Polski)",
  "pt": "Portuguese (Português)",
  "uk": "Ukrainian (Українська)",
  "fr": "French (Français)",
  "es": "Spanish (Español)",
  "tr": "Turkish (Türkçe)",
  "ja": "Japanese (日本語)",
  "ko": "Korean (한국어)",
  "sv": "Swedish (Svenska)",
  "da": "Danish (Dansk)",
  "fi": "Finnish (Suomi)",
  "ro": "Romanian (Română)",
  "cs": "Czech (Čeština)",
  "th": "Thai (ไทย)",
  "vi": "Vietnamese (Tiếng Việt)",
  "id": "Indonesian (Bahasa Indonesia)",
  "ar": "Arabic (العربية)",
  "nl": "Dutch (Nederlands)",
  "hu": "Hungarian (Magyar)",
  "el": "Greek (Ελληνικά)"
};

function loadLocales() {
  const locales = {};
  for (const code of Object.keys(LOCALE_NAMES)) {
    const filePath = path.join(LOCALES_DIR, `${code}.json`);
    try {
      locales[code] = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      console.warn(`[i18n] 無法載入 ${filePath}，使用英文代替。`);
      if (code !== "en" && locales["en"]) locales[code] = locales["en"];
    }
  }
  return locales;
}

const LOCALES = loadLocales();

// -----------------------------------------------------------------------------
// HTML 頁面（含 i18n 支援）
// -----------------------------------------------------------------------------
function buildIndexHtml() {
  const localesJson = JSON.stringify(LOCALES);
  const localeNamesJson = JSON.stringify(LOCALE_NAMES);
  const savedLang = loadConfig().uiLang || "en";

  return `<!doctype html>
<html lang="en" data-theme="dark" data-size="md">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>CS2 Chat Translator (Gemini AI)</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0b0b0c; --surface: #141416; --surface-2: #1c1c1f;
    --border: #26262a; --border-strong: #3a3a40; --text: #e8e8ea;
    --muted: #7d7d84; --muted-2: #55555b; --good: #65b881; --bad: #d46464;
    --info: #7ab0d9; --warm: #d99464; --accent: #d9a84b; --accent-dim: #77602a;
    --accent-ink: #1a1205; --font: "JetBrains Mono", monospace; --base-size: 13px;
  }
  html[data-theme="light"] {
    --bg: #fafaf7; --surface: #ffffff; --surface-2: #f1f1ec; --border: #e3e3dc;
    --border-strong: #c4c4ba; --text: #1a1a1c; --muted: #6a6a6e; --muted-2: #a5a5a9;
    --good: #2f8a4e; --bad: #c24040; --info: #3d82b8; --warm: #b4682f;
  }
  html[data-size="sm"] { --base-size: 17px; }
  html[data-size="md"] { --base-size: 20px; }
  html[data-size="lg"] { --base-size: 23px; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; background: var(--bg); color: var(--text); font-family: var(--font); font-size: var(--base-size); line-height: 1.55; }
  body { display: grid; grid-template-rows: auto 1fr; min-height: 100vh; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 14px 24px; border-bottom: 1px solid var(--border); background: var(--bg); }
  .brand { display: flex; align-items: baseline; gap: 12px; }
  .brand .mark { color: var(--accent); font-weight: 600; }
  .status { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .status .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted-2); }
  .status.on .dot { background: var(--good); }
  .status.bad .dot { background: var(--bad); }
  .header-right { display: flex; align-items: center; gap: 14px; }
  #uiLangSel { background: var(--surface); color: var(--muted); border: 1px solid var(--border); border-radius: 3px; font-family: var(--font); font-size: 11px; padding: 4px 6px; outline: none; cursor: pointer; min-width: 110px; max-width: 150px; }
  .engine-badge { font-size: 11px; padding: 3px 8px; border-radius: 3px; border: 1px solid var(--border); color: var(--muted); background: var(--surface); cursor: default; white-space: nowrap; }
  .engine-badge.gemini { color: var(--accent); border-color: var(--accent-dim); }
  .hdr-btn { display: inline-flex; align-items: center; gap: 5px; padding: 4px 9px; background: transparent; color: var(--muted); border: 1px solid var(--border); border-radius: 3px; font-family: var(--font); font-size: 11px; cursor: pointer; white-space: nowrap; }
  .hdr-btn:hover { border-color: var(--border-strong); color: var(--text); }
  .hdr-btn.paused { color: var(--bad); border-color: var(--bad); }
  main { display: flex; min-height: 0; overflow: hidden; }
  .feed { flex: 1; overflow-y: auto; padding: 16px 24px 32px; }
  aside { flex: 0 0 380px; width: 380px; overflow-y: auto; padding: 20px; border-left: 1px solid var(--border); background: var(--surface); }
  .section { margin-bottom: 24px; }
  .section h2 { margin: 0 0 10px 0; font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.14em; color: var(--muted); }
  .field { margin-bottom: 12px; }
  .field label { display: block; margin-bottom: 4px; font-size: 11px; color: var(--muted); }
  .field input[type="text"], .field select { width: 100%; padding: 8px 10px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 3px; font-family: var(--font); font-size: 12px; outline: none; }
  .field .row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .toggle { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; background: var(--bg); border: 1px solid var(--border); border-radius: 3px; }
  .switch { position: relative; width: 32px; height: 18px; background: var(--border-strong); border-radius: 10px; cursor: pointer; }
  .switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--muted); transition: all 120ms; }
  .switch.on { background: var(--accent-dim); }
  .switch.on::after { left: 16px; background: var(--accent); }
  .seg { display: inline-flex; border: 1px solid var(--border); border-radius: 3px; overflow: hidden; width: 100%; }
  .seg button { flex: 1; padding: 7px 0; background: var(--bg); color: var(--muted); border: 0; border-left: 1px solid var(--border); font-family: var(--font); font-size: 11px; cursor: pointer; }
  .seg button:first-child { border-left: 0; }
  .seg button.active { background: var(--surface-2); color: var(--accent); }
  .swatches { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .swatch { width: 22px; height: 22px; border-radius: 50%; cursor: pointer; border: 2px solid transparent; }
  .swatch.active { border-color: var(--text); }
  input[type="color"] { width: 26px; height: 22px; background: transparent; border: 1px solid var(--border); border-radius: 3px; cursor: pointer; }
  .actions { display: flex; gap: 8px; margin-top: 14px; }
  button.btn { padding: 8px 14px; background: transparent; color: var(--text); border: 1px solid var(--border-strong); border-radius: 3px; font-family: var(--font); font-size: 12px; cursor: pointer; }
  button.btn.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 500; width: 100%; }
  .toast { margin-top: 8px; font-size: 11px; color: var(--muted); }
  .toast.ok { color: var(--good); }
  .toast.err { color: var(--bad); }
  .entry { display: grid; grid-template-columns: 72px 1fr; gap: 12px; padding: 9px 0; border-bottom: 1px dashed var(--border); }
  .meta { color: var(--muted-2); font-size: 12px; }
  .tag { display: inline-block; padding: 1px 6px; font-size: 11px; text-transform: uppercase; border-radius: 2px; margin-right: 6px; border: 1px solid var(--border-strong); color: var(--muted); }
  .tag.ct { color: var(--info); } .tag.t { color: var(--warm); }
  .sender { color: var(--text); font-weight: 500; }
  .msg { color: color-mix(in srgb, var(--text) 75%, transparent); }
</style>
</head>
<body>
<header>
  <div class="brand">
    <span class="mark">CS2</span>
    <span data-i18n="subtitle">Chat Translator</span>
  </div>
  <div class="header-right">
    <button class="hdr-btn" id="clearFeedBtn" title="Clear feed" data-i18n="clearFeed">🗑 Clear</button>
    <button class="hdr-btn" id="pauseBtn" title="Pause auto-translation" data-i18n="pauseTranslation">⏸ Pause</button>
    <span id="engineBadge" class="engine-badge" title="Translation engine">🌐 Google Translate</span>
    <select id="uiLangSel" title="UI Language"></select>
    <div class="status off" id="status">
      <span class="dot"></span>
      <span class="label" id="statusLabel" data-i18n="statusConnecting">Connecting…</span>
    </div>
  </div>
</header>
<main>
  <section class="feed" id="feed">
    <div id="feedEmpty" style="color:var(--muted); text-align:center; padding:60px;" data-i18n="feedEmpty">Waiting for chat messages...</div>
  </section>
  <aside>
    <div class="section">
      <h2 data-i18n="geminiTitle">Gemini Web Translate</h2>
      <div class="field">
        <label for="webInput" data-i18n="inputLabel">Text to translate</label>
        <input id="webInput" type="text" data-i18n-ph="inputPlaceholder" placeholder="Enter text in your language" />
      </div>
      <div class="field">
        <div class="row-2">
          <div>
            <label for="webLang" data-i18n="langLabel">Target language</label>
            <select id="webLang">
              <option value="en">English</option>
              <option value="zh-TW">繁體中文</option>
              <option value="zh-CN">简体中文</option>
              <option value="ru">Русский</option>
              <option value="de">Deutsch</option>
              <option value="pl">Polski</option>
              <option value="pt">Português</option>
              <option value="uk">Українська</option>
              <option value="fr">Français</option>
              <option value="es">Español</option>
              <option value="tr">Türkçe</option>
              <option value="ja">日本語</option>
              <option value="ko">한국어</option>
              <option value="sv">Svenska</option>
              <option value="da">Dansk</option>
              <option value="fi">Suomi</option>
              <option value="ro">Română</option>
              <option value="cs">Čeština</option>
              <option value="th">ไทย</option>
              <option value="vi">Tiếng Việt</option>
              <option value="id">Bahasa Indonesia</option>
              <option value="ar">العربية</option>
              <option value="nl">Nederlands</option>
              <option value="hu">Magyar</option>
              <option value="el">Ελληνικά</option>
            </select>
          </div>
          <div>
            <label for="webTeam" data-i18n="channelLabel">Channel</label>
            <select id="webTeam">
              <option value="false" data-i18n="channelAll">Everyone (All chat)</option>
              <option value="true" data-i18n="channelTeam">Team channel</option>
            </select>
          </div>
        </div>
      </div>
      <div class="actions">
        <button class="btn primary" id="webSendBtn" data-i18n="sendBtn">Translate &amp; send to game</button>
      </div>
    </div>

    <div class="section">
      <h2 data-i18n="settingsTitle">Settings</h2>

      <div class="field">
        <label for="apiKeyInput" data-i18n="apiKeyLabel">Gemini API Key</label>
        <div style="display:flex; gap:6px;">
          <input id="apiKeyInput" type="text" autocomplete="off" data-i18n-ph="apiKeyPlaceholder" placeholder="Paste your key → unlock Gemini AI" style="font-family:monospace; flex:1; -webkit-text-security:disc;" />
          <button class="btn" id="testKeyBtn" data-i18n="testKeyBtn" style="white-space:nowrap; padding:6px 10px; font-size:11px;">Test Key</button>
        </div>
        <div id="keyStatus" style="margin-top:5px; font-size:11px; display:none;"></div>
        <div style="margin-top:4px; font-size:11px; color:var(--muted);"><span data-i18n="apiKeyNoKey">No key?</span> <a href="https://aistudio.google.com/apikey" target="_blank" style="color:var(--accent);" data-i18n="apiKeyGetFree">Get free key at aistudio.google.com</a></div>
      </div>
      <div class="field">
        <label data-i18n="sendEngineLabel">Send Text Engine</label>
        <div class="seg" id="segSendEngine">
          <button data-val="google" class="active" id="sendEngineGoogle" data-i18n="engineGoogle">🌐 Google Translate (Free)</button>
          <button data-val="gemini" id="sendEngineGemini" disabled style="opacity:.4;" data-i18n="engineGemini">✨ Gemini AI</button>
        </div>
      </div>
      <div class="field">
        <label data-i18n="chatEngineLabel">Chat Translation Engine</label>
        <div class="seg" id="segEngine">
          <button data-val="google" class="active" id="engineGoogle" data-i18n="engineGoogle">🌐 Google Translate (Free)</button>
          <button data-val="gemini" id="engineGemini" disabled style="opacity:.4;" data-i18n="engineGemini">✨ Gemini AI</button>
        </div>
      </div>

      <div class="field">
        <label for="logPath" data-i18n="logPathLabel">Console log path</label>
        <input id="logPath" type="text" />
      </div>
      <div class="field">
        <label for="cfgDir" data-i18n="cfgDirLabel">CFG directory path</label>
        <input id="cfgDir" type="text" />
      </div>
      <div class="field">
        <label for="autoTarget" data-i18n="autoLangLabel">Auto-translate language</label>
        <select id="autoTarget">
          <option value="en">English</option>
          <option value="zh-TW">繁體中文</option>
          <option value="zh-CN">简体中文</option>
          <option value="ru">Русский</option>
          <option value="de">Deutsch</option>
          <option value="pl">Polski</option>
          <option value="pt">Português</option>
          <option value="uk">Українська</option>
          <option value="fr">Français</option>
          <option value="es">Español</option>
          <option value="tr">Türkçe</option>
          <option value="ja">日本語</option>
          <option value="ko">한국어</option>
          <option value="sv">Svenska</option>
          <option value="da">Dansk</option>
          <option value="fi">Suomi</option>
          <option value="ro">Română</option>
          <option value="cs">Čeština</option>
          <option value="th">ไทย</option>
          <option value="vi">Tiếng Việt</option>
          <option value="id">Bahasa Indonesia</option>
          <option value="ar">العربية</option>
          <option value="nl">Nederlands</option>
          <option value="hu">Magyar</option>
          <option value="el">Ελληνικά</option>
        </select>
      </div>
      <div class="field">
        <label for="bindKey" data-i18n="bindKeyLabel">Bind key</label>
        <input id="bindKey" type="text" maxlength="16" />
        <div id="bindHint" style="margin-top:5px; padding:6px 8px; background:var(--bg); border:1px solid var(--border); border-radius:3px; font-size:11px; color:var(--muted); cursor:pointer; user-select:all;" title="Click to copy"></div>
      </div>
      <div class="field">
        <label data-i18n="condebugLabel">CS2 launch option</label>
        <div id="condebugHint" style="padding:6px 8px; background:var(--bg); border:1px solid var(--border); border-radius:3px; font-size:11px; color:var(--muted); cursor:pointer; user-select:all;" title="Click to copy">-condebug</div>
      </div>
      <div class="field">
        <label data-i18n="chatTagTitle">Chat Tag Prefixes</label>
        <div class="row-2" style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px;">
          <div>
            <label for="tagCT" style="font-size:11px; color:var(--muted);" data-i18n="tagCTLabel">CT team</label>
            <input id="tagCT" type="text" maxlength="20" style="width:100%; padding:6px 8px; background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:3px; font-family:var(--font); font-size:13px;" />
          </div>
          <div>
            <label for="tagT" style="font-size:11px; color:var(--muted);" data-i18n="tagTLabel">T team</label>
            <input id="tagT" type="text" maxlength="20" style="width:100%; padding:6px 8px; background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:3px; font-family:var(--font); font-size:13px;" />
          </div>
          <div>
            <label for="tagAll" style="font-size:11px; color:var(--muted);" data-i18n="tagAllLabel">All-chat</label>
            <input id="tagAll" type="text" maxlength="20" style="width:100%; padding:6px 8px; background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:3px; font-family:var(--font); font-size:13px;" />
          </div>
        </div>
        <div style="margin-top:5px; font-size:11px; color:var(--muted);" data-i18n="chatTagHint">CS2 writes a tag before each chat line (e.g. [CT]). Override if your game client is in another language.</div>
      </div>
      <div class="field" style="margin-top:10px;">
        <label data-i18n="autoTransLabel">Auto-translate non-command messages</label>
        <div class="toggle">
          <span style="font-size:12px;" data-i18n="autoTransToggle">Show auto-translation results</span>
          <div class="switch" id="autoSwitch" role="button"></div>
        </div>
      </div>
      <div class="actions">
        <button class="btn primary" id="saveBtn" style="width:auto; flex:1;" data-i18n="saveBtn">Save</button>
        <button class="btn" id="restartBtn" style="flex:1;" data-i18n="restartBtn">Restart watcher</button>
      </div>
      <div class="toast" id="toast"></div>
    </div>

    <div class="section">
      <h2 data-i18n="appearanceTitle">Appearance</h2>
      <div class="field">
        <label data-i18n="themeLabel">Theme</label>
        <div class="seg" id="segTheme">
          <button data-val="dark" class="active" data-i18n="darkTheme">Dark</button>
          <button data-val="light" data-i18n="lightTheme">Light</button>
        </div>
      </div>
      <div class="field">
        <label data-i18n="accentLabel">Accent color</label>
        <div class="swatches" id="swatches">
          <div class="swatch active" data-val="#d9a84b" style="background:#d9a84b"></div>
          <div class="swatch" data-val="#65b881" style="background:#65b881"></div>
          <div class="swatch" data-val="#7dd3fc" style="background:#7dd3fc"></div>
          <div class="swatch" data-val="#e06666" style="background:#e06666"></div>
          <input type="color" id="accentPicker" value="#d9a84b" style="margin-left:auto;" />
        </div>
      </div>
      <div class="field">
        <label for="fontSel" data-i18n="fontLabel">Font</label>
        <select id="fontSel">
          <option value='"JetBrains Mono", monospace'>JetBrains Mono</option>
          <option value='"IBM Plex Mono", monospace'>IBM Plex Mono</option>
          <option value='"Inter", sans-serif'>Inter</option>
        </select>
      </div>

    </div>
  </aside>
</main>
<script>
  // ── i18n ──────────────────────────────────────────────
  const LOCALES = ${localesJson};
  const LOCALE_NAMES = ${localeNamesJson};
  let currentLang = ${JSON.stringify(savedLang)};

  function applyLang(code) {
    const t = LOCALES[code] || LOCALES['en'];
    if (!t) return;
    currentLang = code;
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.dataset.i18n;
      if (t[key] !== undefined) el.textContent = t[key];
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(el => {
      const key = el.dataset.i18nPh;
      if (t[key] !== undefined) el.placeholder = t[key];
    });
  }

  // 建立 UI 語言下拉選單（只顯示本地語言名稱）
  const uiLangSel = document.getElementById('uiLangSel');
  const LOCALE_SHORT = {
    'en':'English','zh-TW':'繁體中文','zh-CN':'简体中文','ru':'Русский','de':'Deutsch',
    'pl':'Polski','pt':'Português','uk':'Українська','fr':'Français','es':'Español',
    'tr':'Türkçe','ja':'日本語','ko':'한국어','sv':'Svenska','da':'Dansk','fi':'Suomi',
    'ro':'Română','cs':'Čeština','th':'ไทย','vi':'Tiếng Việt','id':'Bahasa Indonesia',
    'ar':'العربية','nl':'Nederlands','hu':'Magyar','el':'Ελληνικά'
  };
  Object.entries(LOCALE_SHORT).forEach(([code, name]) => {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = name;
    if (code === currentLang) opt.selected = true;
    uiLangSel.appendChild(opt);
  });

  uiLangSel.addEventListener('change', async () => {
    applyLang(uiLangSel.value);
    try {
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uiLang: uiLangSel.value })
      });
    } catch {}
  });

  applyLang(currentLang);

  // ── DOM refs ──────────────────────────────────────────
  const feedEl = document.getElementById('feed');
  const feedEmpty = document.getElementById('feedEmpty');
  const statusEl = document.getElementById('status');
  const statusLabel = document.getElementById('statusLabel');
  const toast = document.getElementById('toast');
  const webInput = document.getElementById('webInput');
  const webLang = document.getElementById('webLang');
  const webTeam = document.getElementById('webTeam');
  const webSendBtn = document.getElementById('webSendBtn');
  const logPathInput = document.getElementById('logPath');
  const cfgDirInput = document.getElementById('cfgDir');
  const bindKeyInput = document.getElementById('bindKey');
  const bindHint = document.getElementById('bindHint');
  const autoTargetInput = document.getElementById('autoTarget');
  const autoSwitch = document.getElementById('autoSwitch');
  const saveBtn = document.getElementById('saveBtn');
  const restartBtn = document.getElementById('restartBtn');
  const segTheme = document.getElementById('segTheme');
  const swatches = document.getElementById('swatches');
  const accentPicker = document.getElementById('accentPicker');
  const fontSel = document.getElementById('fontSel');
  const apiKeyInput = document.getElementById('apiKeyInput');
  const segEngine = document.getElementById('segEngine');
  const engineGemini = document.getElementById('engineGemini');
  const engineGoogle = document.getElementById('engineGoogle');
  const engineBadge = document.getElementById('engineBadge');
  const segSendEngine = document.getElementById('segSendEngine');
  const sendEngineGemini = document.getElementById('sendEngineGemini');
  const sendEngineGoogle = document.getElementById('sendEngineGoogle');
  const tagCTInput = document.getElementById('tagCT');
  const tagTInput = document.getElementById('tagT');
  const tagAllInput = document.getElementById('tagAll');

  let autoTranslateOn = true;
  let currentEngine = 'google';
  let currentSendEngine = 'google';

  function updateEngineBadge(engine) {
    currentEngine = engine;
    if (engine === 'gemini') {
      engineBadge.textContent = '\u2728 Gemini AI';
      engineBadge.classList.add('gemini');
    } else {
      engineBadge.textContent = '\uD83C\uDF10 Google Translate';
      engineBadge.classList.remove('gemini');
    }
  }

  function syncEngineButtons(engine) {
    engineGoogle.classList.toggle('active', engine === 'google');
    engineGemini.classList.toggle('active', engine === 'gemini');
    updateEngineBadge(engine);
  }

  function syncSendEngineButtons(engine) {
    currentSendEngine = engine;
    sendEngineGoogle.classList.toggle('active', engine === 'google');
    sendEngineGemini.classList.toggle('active', engine === 'gemini');
  }

  function onApiKeyChange() {
    const hasKey = apiKeyInput.value.trim().length > 0;
    engineGemini.disabled = !hasKey;
    engineGemini.style.opacity = hasKey ? '1' : '.4';
    sendEngineGemini.disabled = !hasKey;
    sendEngineGemini.style.opacity = hasKey ? '1' : '.4';
    if (!hasKey) {
      syncEngineButtons('google');
      syncSendEngineButtons('google');
    }
  }

  apiKeyInput.addEventListener('input', onApiKeyChange);

  segEngine.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;
    syncEngineButtons(btn.dataset.val);
    // 即時儲存 chatEngine 變更
    try {
      const cfgNow = await fetch('/api/config').then(r => r.json());
      await fetch('/api/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...cfgNow, chatEngine: btn.dataset.val, engine: btn.dataset.val })
      });
    } catch { /* 不影響 UI */ }
  });

  segSendEngine.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;
    syncSendEngineButtons(btn.dataset.val);
    // 即時儲存 sendEngine 變更
    try {
      const cfgNow = await fetch('/api/config').then(r => r.json());
      await fetch('/api/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...cfgNow, sendEngine: btn.dataset.val })
      });
    } catch { /* 不影響 UI */ }
  });

  function updateBindHint() {
    const key = bindKeyInput.value.trim() || t('bindKeyPlaceholder') || 'KEY';
    bindHint.textContent = 'bind ' + key + ' "exec chat_reader.cfg"';
  }

  bindKeyInput.addEventListener('input', updateBindHint);

  bindHint.addEventListener('click', () => {
    navigator.clipboard.writeText(bindHint.textContent).then(() => {
      const orig = bindHint.style.color;
      bindHint.style.color = 'var(--good)';
      setTimeout(() => { bindHint.style.color = orig; }, 800);
    });
  });

  const condebugHint = document.getElementById('condebugHint');
  condebugHint.addEventListener('click', () => {
    navigator.clipboard.writeText(condebugHint.textContent).then(() => {
      const orig = condebugHint.style.color;
      condebugHint.style.color = 'var(--good)';
      setTimeout(() => { condebugHint.style.color = orig; }, 800);
    });
  });


  function append(html) {
    const empty = document.getElementById('feedEmpty');
    if (empty) empty.remove();
    feedEl.insertAdjacentHTML('beforeend', html);
    feedEl.scrollTop = feedEl.scrollHeight;
  }

  function t(key) {
    const tr = LOCALES[currentLang] || LOCALES['en'];
    return (tr && tr[key]) || key;
  }

  function setToast(text, cls) {
    toast.textContent = text || '';
    toast.className = 'toast' + (cls ? ' ' + cls : '');
    if (text) setTimeout(() => { toast.textContent = ''; toast.className = 'toast'; }, 2500);
  }

  async function sendWebTranslation() {
    const text = webInput.value.trim();
    const lang = webLang.value;
    const team = webTeam.value === 'true';
    if (!text) return;
    try {
      const res = await fetch('/api/web-translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, lang, team })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      setToast(t('toastTranslated'), 'ok');
      webInput.value = '';
    } catch (err) {
      setToast(t('toastTransFailed') + err.message, 'err');
    }
  }

  webSendBtn.addEventListener('click', sendWebTranslation);
  webInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendWebTranslation(); } });

  autoSwitch.addEventListener('click', () => {
    autoTranslateOn = !autoTranslateOn;
    autoSwitch.classList.toggle('on', autoTranslateOn);
  });

  segTheme.addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    document.documentElement.dataset.theme = btn.dataset.val;
    [...segTheme.children].forEach(b => b.classList.toggle('active', b === btn));
  });
  swatches.addEventListener('click', (e) => {
    const sw = e.target.closest('.swatch'); if (!sw) return;
    const color = sw.dataset.val;
    document.documentElement.style.setProperty('--accent', color);
    accentPicker.value = color;
    [...swatches.querySelectorAll('.swatch')].forEach(s => s.classList.toggle('active', s === sw));
  });
  accentPicker.addEventListener('input', (e) => {
    document.documentElement.style.setProperty('--accent', e.target.value);
  });
  fontSel.addEventListener('change', (e) => {
    document.documentElement.style.setProperty('--font', e.target.value);
  });

  async function loadState() {
    try {
      const [cfg, status] = await Promise.all([
        fetch('/api/config').then(r => r.json()),
        fetch('/api/status').then(r => r.json())
      ]);
      logPathInput.value = cfg.logPath || '';
      cfgDirInput.value = cfg.cfgDir || '';
      bindKeyInput.value = cfg.bindKey || '';
      updateBindHint();
      autoTargetInput.value = cfg.autoTranslateTarget || 'en';
      autoTranslateOn = cfg.autoTranslate !== false;
      autoSwitch.classList.toggle('on', autoTranslateOn);
      tagCTInput.value = cfg.tagCT || 'CT';
      tagTInput.value = cfg.tagT || 'T';
      tagAllInput.value = cfg.tagAll || 'ALL';
      // engine / api key
      apiKeyInput.value = cfg.apiKey || '';
      onApiKeyChange();
      syncEngineButtons(cfg.chatEngine || cfg.engine || 'google');
      syncSendEngineButtons(cfg.sendEngine || 'google');
      statusEl.classList.remove('on', 'bad');
      if (status.watching) {
        statusEl.classList.add('on');
        statusLabel.textContent = t('statusWatching');
      } else {
        statusEl.classList.add('bad');
        statusLabel.textContent = status.error || t('statusIdle');
      }
    } catch {}
  }

  saveBtn.addEventListener('click', async () => {
    try {
      const body = {
        logPath: logPathInput.value.trim(),
        cfgDir: cfgDirInput.value.trim(),
        bindKey: bindKeyInput.value.trim() || 'l',
        autoTranslate: autoTranslateOn,
        autoTranslateTarget: autoTargetInput.value || 'en',
        uiLang: currentLang,
        apiKey: apiKeyInput.value.trim(),
        engine: currentEngine,
        chatEngine: currentEngine,
        sendEngine: currentSendEngine,
        tagCT: tagCTInput.value.trim() || 'CT',
        tagT: tagTInput.value.trim() || 'T',
        tagAll: tagAllInput.value.trim() || 'ALL'
      };
      const res = await fetch('/api/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error();
      setToast(t('toastSaved'), 'ok');
    } catch {
      setToast(t('toastSaveFailed'), 'err');
    }
  });

  restartBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/restart', { method: 'POST' });
      const s = await res.json();
      loadState();
      setToast(s.watching ? t('toastRestarted') : t('toastIdle'), s.watching ? 'ok' : 'err');
    } catch {
      setToast(t('toastRestartFailed'), 'err');
    }
  });

  const es = new EventSource('/events');
  es.addEventListener('chat', e => {
    const d = JSON.parse(e.data).payload;
    const tagClass = d.team === 'CT' ? 'ct' : d.team === 'T' ? 't' : '';
    append('<div class="entry"><div class="meta">' + t('feedChat') + '</div><div><span class="tag ' + tagClass + '">' + d.team + '</span><span class="sender">' + d.sender + '</span><span class="msg">: ' + d.message + '</span></div></div>');
  });
  es.addEventListener('auto', e => {
    const d = JSON.parse(e.data).payload;
    const engineLabel = d.engine === 'google' ? 'Google' : 'Gemini';
    append('<div class="entry"><div class="meta">' + t('feedAuto') + '</div><div style="color:var(--info);">[' + d.sender + '] (' + engineLabel + ' → ' + d.target.toUpperCase() + ')：' + d.translated + '</div></div>');
  });
  es.addEventListener('command', e => {
    const d = JSON.parse(e.data).payload;
    if (d.translated) append('<div class="entry"><div class="meta">' + t('feedSent') + '</div><div style="color:var(--accent);">［送出］' + d.translated + '</div></div>');
  });
  es.addEventListener('keyError', () => {
    showKeyError();
  });

  // ── Key status helpers ──
  const keyStatusEl = document.getElementById('keyStatus');
  const testKeyBtn = document.getElementById('testKeyBtn');

  function showKeyStatus(ok, msg) {
    keyStatusEl.style.display = 'block';
    keyStatusEl.style.color = ok ? 'var(--good)' : 'var(--bad)';
    keyStatusEl.textContent = ok ? '\u2705 ' + (msg || t('testKeyValid')) : '\u274c ' + (msg || t('testKeyInvalid'));
  }

  function showKeyError() {
    showKeyStatus(false, t('keyErrorSettings'));
    append('<div class="entry" style="background:color-mix(in srgb,var(--bad) 10%,transparent);border-radius:4px;"><div class="meta" style="color:var(--bad);">\u26a0 Key</div><div style="color:var(--bad);">' + t('keyErrorFeed') + '</div></div>');
  }

  testKeyBtn.addEventListener('click', async () => {
    const key = apiKeyInput.value.trim();
    if (!key) { showKeyStatus(false, t('testKeyNoKey')); return; }
    testKeyBtn.disabled = true;
    testKeyBtn.textContent = t('testKeyTesting') || '...';
    keyStatusEl.style.display = 'none';
    try {
      const res = await fetch('/api/test-key', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: key })
      });
      const data = await res.json();
      if (data.ok) {
        showKeyStatus(true, t('testKeyValid'));
        // 測試通過 → 自動儲存（只更新 apiKey 和 engine，其他欄位保留現有值）
        try {
          const cfgRes = await fetch('/api/config').then(r => r.json());
          await fetch('/api/config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...cfgRes, apiKey: key, engine: currentEngine })
          });
          setToast(t('toastSaved') || 'Saved', 'ok');
        } catch { /* 儲存失敗不影響測試結果 */ }
      } else if (data.reason === 'no_key') {
        showKeyStatus(false, t('testKeyNoKey'));
      } else if (data.reason === 'invalid_key') {
        showKeyStatus(false, t('testKeyInvalid'));
      } else {
        showKeyStatus(false, t('testKeyFailed') + ': ' + (data.message || ''));
      }
    } catch {
      showKeyStatus(false, t('testKeyConnErr'));
    }
    testKeyBtn.disabled = false;
    testKeyBtn.textContent = t('testKeyBtn') || 'Test Key';
  });

  // ── Clear feed ──
  const clearFeedBtn = document.getElementById('clearFeedBtn');
  clearFeedBtn.addEventListener('click', () => {
    feedEl.innerHTML = '<div id="feedEmpty" style="color:var(--muted); text-align:center; padding:60px;" data-i18n="feedEmpty">' + t('feedEmpty') + '</div>';
  });

  // ── Pause / Resume ──
  const pauseBtn = document.getElementById('pauseBtn');
  function applyPauseState(paused) {
    pauseBtn.classList.toggle('paused', paused);
    pauseBtn.textContent = paused ? ('\u25b6 ' + (t('resumeTranslation') || 'Resume')) : ('\u23f8 ' + (t('pauseTranslation') || 'Pause'));
    pauseBtn.setAttribute('data-i18n', paused ? 'resumeTranslation' : 'pauseTranslation');
  }
  pauseBtn.addEventListener('click', async () => {
    try {
      const r = await fetch('/api/pause', { method: 'POST' });
      const d = await r.json();
      applyPauseState(d.paused);
    } catch { /* ignore */ }
  });
  es.addEventListener('pauseState', e => {
    applyPauseState(JSON.parse(e.data).payload.paused);
  });

  loadState();


</script>
</body>
</html>`;
}

// -----------------------------------------------------------------------------
// HTTP 工具
// -----------------------------------------------------------------------------
function sendJson(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

async function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", chunk => raw += chunk);
    req.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
  });
}

// -----------------------------------------------------------------------------
// Web Server
// -----------------------------------------------------------------------------
function startWebServer(port) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    if (req.method === "GET" && p === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(buildIndexHtml());
      return;
    }

    if (req.method === "GET" && p === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Connection": "keep-alive" });
      res.write(":ok\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (req.method === "GET" && p === "/api/config") {
      sendJson(res, loadConfig());
      return;
    }

    if (req.method === "POST" && p === "/api/config") {
      try {
        const body = await readJsonBody(req);
        const cur = loadConfig();
        const merged = saveConfig({ ...cur, ...body });
        setupFromConfig();
        startWatching();
        broadcast("status", statusSnapshot());
        sendJson(res, merged);
      } catch (err) {
        sendJson(res, { error: err.message }, 400);
      }
      return;
    }

    if (req.method === "POST" && p === "/api/web-translate") {
      try {
        const body = await readJsonBody(req);
        const text = body.text;
        const lang = body.lang || "en";
        const team = body.team === true;
        const cfg = loadConfig();
        const sendEngine = cfg.apiKey ? (cfg.sendEngine || "google") : "google";
        const resTrans = await smartTranslate(text, lang, sendEngine);
        const translated = resTrans.text;
        writeChatCfg({ message: translated, team });
        broadcast("command", { translated });
        sendJson(res, { success: true, translated });
      } catch (err) {
        sendJson(res, { error: err.message }, 400);
      }
      return;
    }

    if (req.method === "GET" && p === "/api/status") {
      sendJson(res, statusSnapshot());
      return;
    }

    if (req.method === "POST" && p === "/api/restart") {
      setupFromConfig();
      startWatching();
      sendJson(res, statusSnapshot());
      return;
    }

    if (req.method === "POST" && p === "/api/test-key") {
      try {
        const body = await readJsonBody(req);
        const testKey = body.apiKey || loadConfig().apiKey || "";
        if (!testKey) { sendJson(res, { ok: false, reason: "no_key" }); return; }
        const ai = new GoogleGenAI({ apiKey: testKey });
        await ai.models.generateContent({ model: "gemini-3.6-flash", contents: ["Hi"] });
        sendJson(res, { ok: true });
      } catch (err) {
        const isKeyError = /API.?KEY|api.?key|invalid.?key|PERMISSION_DENIED|401|403|UNAUTHENTICATED/i.test(err.message || "");
        sendJson(res, { ok: false, reason: isKeyError ? "invalid_key" : "other", message: err.message });
      }
      return;
    }

    if (req.method === "POST" && p === "/api/pause") {
      TRANSLATION_PAUSED = !TRANSLATION_PAUSED;
      broadcast("pauseState", { paused: TRANSLATION_PAUSED });
      sendJson(res, { paused: TRANSLATION_PAUSED });
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(port, "127.0.0.1", () => {
    log(sym.start, chalk.bold(`CS2 Chat Translator`));
    log(sym.info, chalk.cyan(`GUI → http://127.0.0.1:${port}`));
    logKV("Config", CONFIG_PATH);
    logKV("Log", LOG_PATH);
    logKV("CFG Dir", CSGO_CFG_DIR);
  });
}

// -----------------------------------------------------------------------------
// 啟動
// -----------------------------------------------------------------------------
setupFromConfig();
startWatching();
startWebServer(7420);
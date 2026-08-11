# CS2 Chat Translator

Real-time chat translation for Counter-Strike 2. Supports Google Translate (free) and Gemini AI dual-engine with a clean Web GUI.

> **[繁體中文版 README](README.zh-TW.md)**

> **Fork v2.0.0**  
> Original author: [MeckeDev](https://github.com/MeckeDev/cs2-chat-translator)  
> Fork maintained by: [Joe (JoeJoe1024)](https://github.com/JoeJoe1024)  
> Fully optimized for Windows, with Web GUI, Gemini AI, multi-language UI, and encrypted API key storage.

---

## Why I Built This

I'm a CS2 player who loves the game but often couldn't understand what teammates or opponents were trying to say — and I wanted to talk back.

I discovered MeckeDev's original project and thought it was exactly what I needed, but Chinese support was very limited. So I started tweaking it — adding Windows support, a web interface, Gemini AI, and proper localization for Traditional Chinese, Simplified Chinese, and 23 other languages.

This fork is for players like me: people who want to connect across language barriers without any technical hassle.

> **A note on maintenance:** I can't promise I'll keep updating this forever — life gets busy. But whenever I have time, I'll come back and keep things running!

---

## What's New in This Fork

| Feature | Description |
|---------|-------------|
| ✅ Windows support | Auto-detects Steam installation path (original was Linux-only) |
| ✅ Gemini AI engine | Switch between Google Translate and Gemini AI |
| ✅ Encrypted API key | AES-256-CBC encryption bound to local hardware serial |
| ✅ Test Key button | One-click key validation with auto-save on success |
| ✅ Clear / Pause buttons | Clear chat log or pause translation to save API quota |
| ✅ 25+ UI languages | Switch interface language instantly |
| ✅ Custom chat tag prefixes | Supports non-English CS2 clients |
| ✅ Live config reload | Settings apply immediately without restarting |
| ✅ Config stored in project folder | Easy to back up and carry |

---

## Features

### Translation Engines
- **Google Translate (free)** — No API key needed, works out of the box
- **Gemini AI** — Requires a Google AI Studio API key, higher quality translations

### Web GUI
- Real-time chat feed with translations
- **Type in the web page → translate → press in-game hotkey to send** — no typing in CS2 chat at all
- **Clear** button: wipe the chat feed instantly
- **Pause** button: pause translation to save API quota without closing the app
- 25+ UI languages

### Security
- API key stored with **AES-256-CBC** encryption
- Encryption key derived from your **motherboard + BIOS serial numbers**
- Config file is safe to share — it cannot be decrypted on another machine

---

## Requirements

- **OS:** Windows 10 / 11
- **Node.js:** 18 or higher
- **Network:** Required (translation APIs)
- **Game:** Counter-Strike 2 with `-condebug` launch option

---

## Installation

### Option A: Portable ZIP (recommended — no installation required)

1. Download the latest **`cs2-chat-translator-2.0.0.zip`** from [Releases](https://github.com/JoeJoe1024/cs2-chat-translator/releases)
2. Extract the ZIP anywhere
3. Double-click **`start.bat`**
4. The browser opens automatically at `http://127.0.0.1:7420`

> The ZIP already includes a bundled Node.js runtime (`runtime\node.exe`).  
> No Node.js installation, no `npm install` — just extract and run.

### Option B: From Source (for developers)

1. Install [Node.js](https://nodejs.org/) (LTS)
2. Install dependencies:
   ```powershell
   npm install
   ```
3. Start:
   ```powershell
   node bin/cs2-chat-translator.js
   ```

Open your browser at **http://127.0.0.1:7420**

---

## CS2 Setup

### Step 1: Enable console logging

1. Open **Steam**
2. Right-click **Counter-Strike 2 → Properties…**
3. Under **Launch Options**, add: `-condebug`
4. Start CS2 once so `console.log` is created

### Step 2: Find your cfg folder

Typical Windows path:
```
D:\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\cfg
```

### Step 3: Bind a key

Add this to your `autoexec.cfg`:
```
bind kp_plus "exec chat_reader.cfg"
```
> `kp_plus` is the `+` key on the numpad. You can change it in the GUI settings.

---

## Gemini API Key (optional)

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Sign in and create a key
3. Paste it in the GUI settings and click **Test Key**
4. On success it auto-saves and switches to Gemini AI

> Free-tier Gemini provides plenty of daily quota for normal use.

---

## Settings Reference

| Field | Description |
|-------|-------------|
| Gemini API Key | Optional. Leave blank to use Google Translate |
| Translation Engine | Switch Google Translate / Gemini AI (live) |
| Console log path | Full path to CS2's `console.log` |
| CFG directory | Full path to CS2's `cfg` folder |
| Auto-translate language | Target language for automatic chat translation |
| Bind key | Key used in CS2 to execute `chat_reader.cfg` |
| Chat tag prefixes | Change if your CS2 client is not in English |

---

## Supported Languages

**Translation targets:** All Google Translate language codes (100+)

**UI languages (25):**
English, 繁體中文, 简体中文, Русский, Deutsch, Polski, Português, Українська, Français, Español, Türkçe, 日本語, 한국어, Svenska, Dansk, Suomi, Română, Čeština, ไทย, Tiếng Việt, Bahasa Indonesia, العربية, Nederlands, Magyar, Ελληνικά

---

## Config File

Stored in the project folder as `config.json`. The API key field is encrypted (never plain text):

```json
{
  "apiKey": "enc:a3f2b1...:8f9e7d...",
  "engine": "gemini",
  "logPath": "D:\\Steam\\steamapps\\common\\...",
  "bindKey": "kp_plus"
}
```

---

## Troubleshooting

**console.log not found**
1. Confirm `-condebug` is in CS2 launch options
2. Verify the path in settings is correct
3. Make sure CS2 has been launched at least once

**Translations not appearing**
1. Check chat tag prefixes match your CS2 language (English: CT/T/ALL)
2. Click **Restart Watcher** to reload settings

**Invalid API key**
Click **Test Key** next to the key field — it will show a clear error message.

---

## License

This is an open-source fork. Original project copyright by [MeckeDev](https://github.com/MeckeDev). This fork is released under the same license.

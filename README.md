# CS2 聊天翻譯器（CS2 Chat Translator）

即時翻譯 Counter-Strike 2 聊天訊息。支援 Google 翻譯（免費）與 Gemini AI 雙引擎，提供美觀的網頁 GUI 介面。

> **Fork 版本 v2.0.0**  
> 原作者：[MeckeDev](https://github.com/MeckeDev/cs2-chat-translator)  
> 本版修改者：[Joe (JoeJoe1024)](https://github.com/JoeJoe1024)  
> 本版針對 Windows 環境全面優化，新增 Web GUI 功能、Gemini AI 支援、多語言介面、API 金鑰加密等功能。

---

## 相較原版的新增功能

| 功能 | 說明 |
|------|------|
| ✅ Windows 支援 | 自動偵測 Steam 安裝路徑，原版僅支援 Linux |
| ✅ Gemini AI 引擎 | 可切換 Google Translate / Gemini AI |
| ✅ API 金鑰加密 | AES-256-CBC 加密，綁定本機硬體序號 |
| ✅ 測試金鑰功能 | 一鍵驗證 API 金鑰是否有效，通過後自動儲存 |
| ✅ 清除 / 暫停按鈕 | 清空聊天紀錄、暫停翻譯節省 API 用量 |
| ✅ 25+ 種 UI 語言 | 介面語言即時切換 |
| ✅ 聊天標籤自訂 | 支援非英文 CS2 用戶端（如中文版） |
| ✅ 設定即時生效 | 儲存後無需重啟程式 |
| ✅ 設定檔置於專案資料夾 | 方便備份與攜帶 |

---

## 主要功能

### 翻譯引擎
- **Google 翻譯（免費）** — 無需 API 金鑰，開箱即用
- **Gemini AI** — 需要 Google AI Studio API 金鑰，翻譯品質更高

### 翻譯指令

所有翻譯均可透過 **Web GUI 介面輸入後送出**，不需要在遊戲內聊天室手動打字。輸入完成後按下快捷鍵，CS2 會自動執行對應動作。
舊版的需要先在遊戲內打出指令+消息再按下快捷鍵才會觸發，並且會產生2條消息(原始消息與翻譯後的結果)。
但新版的WebGUI不需要，直接在網頁打出消息，按下快捷鍵，CS2就會自動執行對應動作。


### Web GUI 介面
- 即時顯示聊天紀錄與翻譯結果
- **在網頁輸入文字 → 翻譯 → 按遊戲內快捷鍵送出**，全程不需在遊戲聊天室打字
- **清除** 按鈕：一鍵清空畫面
- **暫停翻譯** 按鈕：節省 API 用量，無需關閉程式
- 支援 25+ 種 UI 介面語言

### 安全性
- API 金鑰以 **AES-256-CBC** 加密儲存
- 加密金鑰由本機**主機板序號 + BIOS 序號**衍生，綁定硬體
- 即使設定檔被複製走，其他電腦也無法解密

---

## 系統需求

- **作業系統：** Windows 10 / 11
- **Node.js：** 18 或以上版本
- **網路：** 需要連線（翻譯 API）
- **遊戲：** Counter-Strike 2，需啟用 `-condebug` 啟動參數

---

## 安裝

### 1. 安裝 Node.js

前往 [nodejs.org](https://nodejs.org/) 下載並安裝 LTS 版本。

### 2. 安裝相依套件

在專案資料夾內執行：

```powershell
npm install
```

### 3. 啟動程式

```powershell
node bin/cs2-chat-translator.js
```

程式啟動後，在瀏覽器開啟：

```
http://127.0.0.1:3000
```

---

## CS2 遊戲設定

### 步驟 1：啟用 console 記錄

CS2 必須加上 `-condebug` 啟動參數才會寫入 `console.log`。

1. 開啟 **Steam**
2. 右鍵 **Counter-Strike 2 → 內容…**
3. 在「**啟動選項**」加入：
   ```
   -condebug
   ```
4. 啟動 CS2 一次，讓 `console.log` 建立起來

### 步驟 2：找到 cfg 資料夾

Windows 下 Steam 的典型路徑：
```
D:\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\cfg
```

實際路徑可在 GUI 設定頁面確認或修改。

### 步驟 3：綁定按鍵

在你的 CS2 `cfg` 資料夾裡，開啟（或建立）`autoexec.cfg`，加入：

```
bind kp_plus "exec chat_reader.cfg"
```

> `kp_plus` 是數字鍵盤的 `+` 鍵。可在 GUI 設定頁面自行修改為其他按鍵。

---

## 取得 Gemini API 金鑰（選擇性）

如果想使用 Gemini AI 引擎：

1. 前往 [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. 登入 Google 帳號，建立 API 金鑰
3. 在 GUI 設定頁面貼上金鑰，點擊「**測試金鑰**」
4. 測試通過後會**自動儲存**並切換到 Gemini AI 引擎

> 免費版 Gemini 每天有大量請求配額，一般使用已足夠。

---

## 設定頁面說明

| 欄位 | 說明 |
|------|------|
| Gemini API 金鑰 | 選填。不填則自動使用 Google 翻譯 |
| 翻譯引擎 | 切換 Google Translate / Gemini AI，即時生效 |
| Console log 路徑 | CS2 的 `console.log` 完整路徑 |
| CFG 資料夾路徑 | CS2 的 `cfg` 資料夾完整路徑 |
| 自動翻譯語言 | 聊天自動翻譯的目標語言 |
| 綁定按鍵 | CS2 內執行 `chat_reader.cfg` 的按鍵 |
| 聊天標籤前綴 | 如遊戲語言非英文，請修改為對應標籤<br>繁體中文範例：CT=反恐小組、T=恐怖份子、ALL=所有人 |

設定儲存後**即時生效**，無需重啟程式。

---

## 支援的語言

翻譯目標語言支援所有 Google Translate 語言代碼（`en`, `zh-TW`, `zh-CN`, `ja`, `ko`, `de`, `fr`, `ru`, `es`, `pt`, `th`, `vi`, `ar`… 等 100+ 種）。

UI 介面語言（25 種）：
English、繁體中文、简体中文、Русский、Deutsch、Polski、Português、Українська、Français、Español、Türkçe、日本語、한국어、Svenska、Dansk、Suomi、Română、Čeština、ไทย、Tiếng Việt、Bahasa Indonesia、العربية、Nederlands、Magyar、Ελληνικά

---

## 設定檔位置

設定儲存在專案資料夾內：

```
cs2-chat-translator\config.json
```

金鑰欄位為加密格式（非明文），例：
```json
{
  "apiKey": "enc:a3f2b1...:8f9e7d...",
  "engine": "gemini",
  "logPath": "D:\\Steam\\steamapps\\common\\...",
  "bindKey": "kp_plus"
}
```

---

## 常見問題

### console.log 找不到
1. 確認 CS2 啟動參數有加 `-condebug`
2. 在設定頁面確認路徑正確
3. CS2 有實際執行過（讓檔案建立起來）

### 翻譯沒有出現
1. 確認聊天標籤前綴設定正確（英文 CS2 用 CT/T/ALL，中文 CS2 用 反恐小組/恐怖份子/所有人）
2. 點擊「**重啟監視器**」讓程式重新讀取設定

### API 金鑰無效
點擊金鑰欄位旁的「**測試金鑰**」，頁面會顯示金鑰是否有效。

---

## 授權

本專案為開源 Fork。原始專案版權歸 [MeckeDev](https://github.com/MeckeDev) 所有，遵循原有授權條款。本版修改內容同樣以相同條款開放。

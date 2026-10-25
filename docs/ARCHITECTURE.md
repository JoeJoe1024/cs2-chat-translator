# Architecture

```
start.bat ──▶ dist/launcher.mjs ──▶ dist/server.mjs ──▶ http://127.0.0.1:9527  ◀── browser (React)
 (ASCII)       single instance / port /      local service                              live events (SSE)
               opens the browser
```

## Directories

| Path | Responsibility |
|---|---|
| `src/shared/` | **Pure** code shared by front end and back end (no Node modules): `protocol.ts` (API / SSE types), `languages.ts`, `gameLanguages.ts`, `cs2keys.ts` (browser key → CS2 bind name), `cfgEncode.ts` (safe cfg encoding and command strings), `glossary.ts` + `glossaryData.ts` (the **only** game-term dictionary), `names.ts` (player-name cleaning and comparison) |
| `src/config/` | Settings schema (zod, the **single source of truth**; the patch schema used for updates is derived from it and carries no defaults), `store.ts` (JSON file + migration of old settings), `secrets.ts` (DPAPI), `paths.ts` |
| `src/cs2/` | CS2 integration: `steam.ts` (finds every install, the language and the persona name), `vpk.ts`, `logTailer.ts`, `cfgWriter.ts`, `identity.ts` (local player name) |
| `src/cs2/chat/` | **Chat-format detection**: `templates.ts`, `localization.ts`, `detector.ts` |
| `src/translation/` | `types.ts` (engine interface), `google.ts`, `gemini.ts`, `geminiModels.ts` (models.list + local cache), `service.ts` (dictionary → filter → cache → queue → retry / cooldown / circuit breaker), `queue.ts`, `filter.ts` |
| `src/server/` | `app.ts` (coordination layer), `http.ts` (routes + static files), `security.ts`, `events.ts`, `picker.ts` (native file dialog), `main.ts` |
| `src/launcher/` | `main.ts` (the launcher `start.bat` runs), `instance.ts` (single instance / lock / health check), `build.ts` |
| `web/src/` | React UI: `components/` (`Composer`, `ChatPanel`, `settings/*`), `i18n/` (13 interface languages), `lib/` (API, SSE, theme, state, `clock.ts` click time), `styles/` |
| `tests/` | `server/` (Node), `web/` (jsdom), `fixtures/` (integration harness) |
| `scripts/` | `build-server.mjs`, `make-portable.mjs`, `lib/secret-scan.mjs` (release-package scan), `verify-log.ts`, `eval-gemini.ts` (manual model comparison, needs your own key), `messages/` |

No file mixes HTTP, HTML, CSS and core logic.

## Data flow

```
console.log ─▶ LogTailer ─▶ ChatFormatDetector ─▶ App.handleLine ─┬▶ SSE: chat (immediately, does not wait for translation)
                                                                  └▶ TranslationService ─▶ SSE: translation (updates by message id)
UI "Prepare" ──▶ POST /api/cfg {mode: translated|direct, clickedAt} ─▶ App.prepareCfg ─▶ cfgWriter ─▶ SSE: cfg
```

### Order inside the translation service

1. Empty message → skipped.
2. **Dictionary** (`shared/glossary.ts`): if the whole sentence is a known term with a translation for the target language → answered locally and instantly (`engine: "local"`), with no queue, no network and no quota.
3. **Smart filter**: only digits / symbols / emoji → skipped. Anything containing text (`1v3`, `gg`) always passes.
4. A term inside a sentence → expanded to English (Google) or added as a hint (Gemini); terms with several meanings are not expanded.
5. Cache (the key includes the dictionary version, so any dictionary change invalidates everything) and merging of identical requests in flight.
6. A separate queue per engine (Google 3 in parallel, Gemini 2). The chat queue holds at most 40; work that has **not started** and is older than the adjustable "stale threshold" (default 5 seconds) is skipped (the original text stays).
7. Each request times out after 10 seconds; retryable errors back off and retry; quota / key errors enter a cooldown; repeated network failures briefly open the circuit breaker. **Queued requests re-check the cooldown before they start**, so nothing is sent to a service that is already rate-limiting.

Results are applied by message id, and every message has its own request sequence number, so an older slow result never overwrites a newer one.

### The "prepared message" (two modes, one send key)

- Only `App.prepareCfg` can change what will be sent (the UI's "Translate and prepare", "Prepare to send" and the quick phrases); background translations, mode switches and edited drafts cannot touch it.
- Writes are **serialised** with a promise chain, and each call carries `clickedAt` (the time of the click). A click **older** than the prepared message is rejected (HTTP 409 `superseded`), so a slow translation clicked first and finished last cannot overwrite a later direct message.
- The state is updated and broadcast only **after** a successful write; a failed write keeps the previous message and does not consume the click time.
- On start-up and on normal shutdown, a cfg the app created (including ones created by older versions) is replaced by a "do nothing" file; a file the app did not create is never touched. Changing the key / file name / path clears it in the same way.
- The file content is still `say "…"` / `say_team "…"`, at most 3 lines of ≤ 120 bytes each, written to a temporary file first and then renamed. The UI only says "prepared".

### Paths, identity and the launcher

- `cs2.pathMode`: `auto` (detects every Steam library; with several, `installDir` decides; if none is selected the one with the newest console.log is used for now and the user is told) / `manual` (the user's path is used as it is and is never overwritten by detection, even if the path temporarily does not exist). Old settings with an explicit path are migrated to manual.
- Names: `manual` (authorised) and `console-log` (confirmed by the game engine) count as "me"; the Steam name is only a suggestion. Player names are cleaned of invisible direction marks (U+200E and similar) before they are compared. See [SECURITY.md](../SECURITY.md).
- Launcher: one service per user. A second start opens the existing page; a start lock serialises double clicks; the server picks the next free port (9527 → 9528 …) and listens on `127.0.0.1` only. An older instance is replaced only when it identifies itself by instance id, reports no prepared message, and still answers the same way immediately before it is stopped. Anything else is left running and simply opened.

## Kept behaviours

Log watching, automatic translation of incoming chat, the `bind` + `exec` cfg flow for sending, the Google and Gemini engines selectable separately for chat and sending, the game-term dictionary, default port 9527, the `chat_reader.cfg` file name and the `kp_plus` default key.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ChatEntry } from "@shared/protocol";
import { languageName } from "@shared/languages";
import { cleanName } from "@shared/names";
import { bucketOf, CHAT_FONT_MAX, CHAT_FONT_MIN, CHAT_VIEWS, clampChatFont, type ChatView } from "@shared/chatView";
import type { SettingsPatch } from "../../../src/config/schema";
import { hasKey, useI18n, type MessageKey } from "../i18n";
import { api } from "../lib/api";
import { EngineSelect } from "./EngineSelect";
import { LanguageOptions } from "./LanguageOptions";

/** Within this distance of the bottom counts as "at the bottom" (a few pixels of rounding must not pause following). */
const FOLLOW_TOLERANCE_PX = 12;

export interface ChatAppearance {
  chatView: ChatView;
  chatFontSize: number;
}

interface Props {
  entries: ChatEntry[];
  paused: boolean;
  appearance: ChatAppearance;
  translation: { chatEngine: "google" | "gemini"; chatTargetLanguage: string };
  geminiKeyConfigured: boolean;
  general: { translateOwnMessages: boolean; hideOwnMessages: boolean };
  /** Names the user authorised (or the game confirmed): the only reliable way to tell which lines are "mine". */
  ownNames: string[];
  onSave: (patch: SettingsPatch) => Promise<unknown>;
  onOpenTranslation: () => void;
}

/**
 * Makes a native <details> behave like a dropdown: it closes on a press outside, on Esc (focus goes back to the
 * summary) and when focus tabs out. Listeners only observe, so the click that closed it still reaches its target, and
 * clicks inside never close it. The settings are saved on change, so closing never reverts anything.
 */
function useDismissibleDetails() {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (refocus: boolean) => {
      const el = ref.current;
      if (!el?.open) return;
      el.open = false;
      if (refocus) el.querySelector("summary")?.focus();
    };
    const outside = (e: Event) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && ref.current?.open) close(true);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  return ref;
}

export function ChatPanel({ entries: allEntries, paused, appearance, translation, geminiKeyConfigured, general, ownNames, onSave, onOpenTranslation }: Props) {
  const { t } = useI18n();
  const { chatView: view, chatFontSize: size } = appearance;
  const optsRef = useDismissibleDetails();

  // Hiding is presentation only: the full history stays in `allEntries` and comes back when the option is turned off.
  const own = useMemo(() => new Set(ownNames.map((n) => cleanName(n).toLowerCase())), [ownNames]);
  const entries = useMemo(() => (general.hideOwnMessages ? allEntries.filter((e) => !own.has(cleanName(e.sender).toLowerCase())) : allEntries), [allEntries, general.hideOwnMessages, own]);
  const hiddenOwn = allEntries.length - entries.length;

  // One shared list; the modes below only choose which slice of it each pane shows.
  const buckets = useMemo(() => {
    const team: ChatEntry[] = [];
    const all: ChatEntry[] = [];
    const other: ChatEntry[] = [];
    for (const e of entries) {
      const b = bucketOf(e.channel);
      (b === "team" ? team : b === "all" ? all : other).push(e);
    }
    return { team, all, other };
  }, [entries]);

  const setSize = (n: number) => void onSave({ appearance: { chatFontSize: clampChatFont(n) } });
  const setView = (v: ChatView) => void onSave({ appearance: { chatView: v } });
  const style = { "--chat-fs": `${size}px` } as CSSProperties;

  return (
    <section className="panel chat" aria-labelledby="chat-title" style={style}>
      <div className="panel-head chat-head">
        <h2 id="chat-title">{t("chat.title")}</h2>
        {paused && <span className="pill pill--warn">{t("chat.paused")}</span>}
        <span className="spacer" />
        <details className="chat-opts" ref={optsRef}>
          <summary className="btn btn--ghost btn--small">{t("chat.opts")}</summary>
          <div className="chat-opts-menu">
            <label className="check">
              <input type="checkbox" checked={!general.translateOwnMessages} onChange={(e) => void onSave({ general: { translateOwnMessages: !e.target.checked } })} />
              <span>{t("chat.opts.skipOwnTranslate")}</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={general.hideOwnMessages} onChange={(e) => void onSave({ general: { hideOwnMessages: e.target.checked } })} />
              <span>{t("chat.opts.hideOwn")}</span>
            </label>
            <p className="muted help">{ownNames.length === 0 ? t("chat.opts.noIdentity") : t("chat.opts.help")}</p>
          </div>
        </details>
        <button type="button" className="btn btn--ghost" onClick={() => void api.clearChat()} disabled={allEntries.length === 0}>
          {t("chat.clear")}
        </button>
      </div>

      <div className="chat-tools">
        <label className="tool">
          <span className="tool-label">{t("chat.tools.receive")}</span>
          <EngineSelect value={translation.chatEngine} label={t("tr.chatEngine")} onChange={(v) => void onSave({ translation: { chatEngine: v } })} />
        </label>
        <label className="tool">
          <span className="tool-label">{t("chat.tools.into")}</span>
          <select className="viewselect" value={translation.chatTargetLanguage} aria-label={t("tr.chatTarget")} title={t("tr.chatTarget")} onChange={(e) => void onSave({ translation: { chatTargetLanguage: e.target.value } })}>
            <LanguageOptions engine={translation.chatEngine} />
          </select>
        </label>
        <span className="spacer" />
        <div className="fontstep" role="group" aria-label={t("appearance.chatFont")}>
          <button type="button" className="btn btn--ghost btn--small" onClick={() => setSize(size - 1)} disabled={size <= CHAT_FONT_MIN} aria-label={t("chat.font.smaller")} title={t("chat.font.smaller")}>
            A−
          </button>
          <button type="button" className="btn btn--ghost btn--small" onClick={() => setSize(size + 1)} disabled={size >= CHAT_FONT_MAX} aria-label={t("chat.font.larger")} title={t("chat.font.larger")}>
            A+
          </button>
        </div>
        <select className="viewselect" value={view} aria-label={t("chat.view.label")} title={t("chat.view.label")} onChange={(e) => setView(e.target.value as ChatView)}>
          {CHAT_VIEWS.map((v) => (
            <option key={v} value={v}>
              {t(`chat.view.${v}` as MessageKey)}
            </option>
          ))}
        </select>
      </div>
      {translation.chatEngine === "gemini" && !geminiKeyConfigured && (
        <p className="muted chat-note">
          {t("tr.needKey")}{" "}
          <button type="button" className="link" onClick={onOpenTranslation}>
            {t("tr.needKeyOpen")}
          </button>
        </p>
      )}

      {ownNames.length === 0 && (general.hideOwnMessages || !general.translateOwnMessages) && <p className="muted chat-note">{t("chat.opts.noIdentity")}</p>}

      {hiddenOwn > 0 &&<p className="muted chat-note">{t("chat.hiddenOwn", { n: hiddenOwn })}</p>}

      {view === "mixed" && <ChatList entries={entries} empty={t("chat.empty")} />}
      {view === "team" && <FilteredList entries={buckets.team} hidden={buckets.other.length} empty={t("chat.emptyTeam")} onShowMixed={() => setView("mixed")} />}
      {view === "all" && <FilteredList entries={buckets.all} hidden={buckets.other.length} empty={t("chat.emptyAll")} onShowMixed={() => setView("mixed")} />}
      {view === "split" && <Split team={buckets.team} all={buckets.all} other={buckets.other} />}
    </section>
  );
}

function FilteredList({ entries, hidden, empty, onShowMixed }: { entries: ChatEntry[]; hidden: number; empty: string; onShowMixed: () => void }) {
  const { t } = useI18n();
  return (
    <>
      <ChatList entries={entries} empty={empty} />
      {hidden > 0 && (
        <p className="muted chat-note">
          {t("chat.hiddenOther", { n: hidden })}{" "}
          <button type="button" className="link" onClick={onShowMixed}>
            {t("chat.showMixed")}
          </button>
        </p>
      )}
    </>
  );
}

function Split({ team, all, other }: { team: ChatEntry[]; all: ChatEntry[]; other: ChatEntry[] }) {
  const { t } = useI18n();
  const [showOther, setShowOther] = useState(false);
  return (
    <div className="chat-split-wrap">
      <div className="chat-split">
        <div className="chat-side chat-side--team">
          <h3 className="chat-side-title">{t("chat.side.team")}</h3>
          <ChatList entries={team} empty={t("chat.emptyTeam")} />
        </div>
        <div className="chat-side chat-side--all">
          <h3 className="chat-side-title">{t("chat.side.all")}</h3>
          <ChatList entries={all} empty={t("chat.emptyAll")} />
        </div>
      </div>
      {other.length > 0 && (
        <div className="chat-other">
          <button type="button" className="link" aria-expanded={showOther} onClick={() => setShowOther((v) => !v)}>
            {t("chat.side.other")} ({other.length})
          </button>
          {showOther && (
            <div className="chat-other-list">
              <ChatList entries={other} empty="" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A scrolling list that behaves like a chat window:
 *  - it follows new messages, and the height changes of late translations / text size / window size, while the reader is at the bottom;
 *  - scrolling UP pauses following and never moves the reader again (new lines only raise the "latest" button's counter);
 *  - reaching the bottom again, or the button, resumes following.
 * Only the reader's own scrolling changes the state; content growing under a stationary scrollbar does not.
 */
function ChatList({ entries, empty }: { entries: ChatEntry[]; empty: string }) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const lastTop = useRef(0);
  const lastId = useRef<string | null>(entries.at(-1)?.id ?? null);
  const [following, setFollowing] = useState(true);
  const [unseen, setUnseen] = useState(0);

  const setFollow = useCallback((on: boolean) => {
    follow.current = on;
    setFollowing(on);
    if (on) setUnseen(0);
  }, []);

  const toBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const target = el.scrollHeight - el.clientHeight;
    if (Math.abs(el.scrollTop - target) > 0.5) el.scrollTop = target;
    lastTop.current = el.scrollTop;
  }, []);

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_TOLERANCE_PX;
    if (atBottom) {
      if (!follow.current) setFollow(true);
    } else if (el.scrollTop < lastTop.current - 1 && follow.current) {
      setFollow(false); // the reader moved up on purpose
    }
    lastTop.current = el.scrollTop;
  }, [setFollow]);

  // New or updated messages: follow, or just count what the reader has not seen.
  useLayoutEffect(() => {
    const id = entries.at(-1)?.id ?? null;
    if (follow.current) {
      toBottom();
    } else if (id !== lastId.current) {
      const at = entries.findIndex((e) => e.id === lastId.current);
      const added = at === -1 ? entries.length : entries.length - at - 1;
      if (added > 0) setUnseen((n) => n + added);
    }
    lastId.current = id;
  }, [entries, toBottom]);

  // Heights change without new messages (translation arrives, text size, window size): keep the newest line in view.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (follow.current) toBottom();
    });
    if (rowsRef.current) ro.observe(rowsRef.current);
    if (listRef.current) ro.observe(listRef.current);
    return () => ro.disconnect();
  }, [toBottom]);

  const jump = () => {
    setFollow(true);
    toBottom();
  };

  return (
    <div className="chat-pane">
      <div className="chat-list" ref={listRef} onScroll={onScroll} role="log" aria-live="polite">
        <div className="chat-rows" ref={rowsRef}>
          {entries.length === 0 ? <p className="empty">{empty}</p> : entries.map((e) => <ChatRow key={e.id} entry={e} />)}
        </div>
      </div>
      {entries.length > 0 && !following && (
        <button type="button" className="jump" onClick={jump}>
          ↓ {t("chat.jumpLatest")}
          {unseen > 0 ? ` · ${t("chat.newMessages", { n: unseen })}` : ""}
        </button>
      )}
    </div>
  );
}

function ChatRow({ entry }: { entry: ChatEntry }) {
  const { t } = useI18n();
  const time = new Date(entry.at).toLocaleTimeString([], { hour12: false });
  return (
    <article className={`msg msg--${entry.channel}${entry.isSelf ? " msg--self" : ""}`}>
      <div className="msg-head">
        <span className={`chip chip--${entry.channel}`}>{t(`chat.channel.${entry.channel}` as MessageKey)}</span>
        <span className="sender" dir="auto">
          {entry.sender}
        </span>
        {entry.isSelf && <span className="tag">{t("chat.you")}</span>}
        {entry.dead && <span className="tag">{t("chat.dead")}</span>}
        {entry.location && (
          <span className="muted" dir="auto">
            @ {entry.location}
          </span>
        )}
        <time className="muted time" dateTime={new Date(entry.at).toISOString()}>
          {time}
        </time>
      </div>
      <p className="orig" dir="auto">
        {entry.text}
      </p>
      <Translation entry={entry} />
    </article>
  );
}

function Translation({ entry }: { entry: ChatEntry }) {
  const { t, locale } = useI18n();
  const tr = entry.translation;
  const retry = () => void api.translateMessage(entry.id).catch(() => undefined);

  if (tr.status === "pending") return <p className="tr tr--pending">{t("chat.translating")}</p>;

  if (tr.status === "done") {
    return (
      <div className="tr">
        <p dir="auto">{tr.text}</p>
        <p className="meta">
          {tr.sourceLanguage ? t("chat.from", { lang: languageName(tr.sourceLanguage, locale) }) : null}
          {tr.sourceLanguage && tr.engine ? " · " : null}
          {tr.engine ? t("chat.via", { engine: tr.engine === "gemini" ? "Gemini" : tr.engine === "local" ? t("chat.local") : "Google" }) : null}
        </p>
      </div>
    );
  }

  if (tr.status === "failed") {
    const key = `error.${tr.reason ?? "generic"}`;
    return (
      <p className="tr tr--failed">
        {hasKey(key) ? t(key) : t("error.generic")}{" "}
        <button type="button" className="link" onClick={retry}>
          {t("chat.retry")}
        </button>
      </p>
    );
  }

  const key = `chat.skipped.${tr.reason ?? ""}`;
  const text = hasKey(key) ? t(key) : "";
  if (!text) return null;
  const canTranslate = tr.reason === "paused" || tr.reason === "auto-off";
  return (
    <p className="tr tr--skipped">
      {text}
      {canTranslate && (
        <>
          {" "}
          <button type="button" className="link" onClick={retry}>
            {t("chat.translate")}
          </button>
        </>
      )}
    </p>
  );
}

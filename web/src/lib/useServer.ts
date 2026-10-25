import { useCallback, useEffect, useReducer, useRef } from "react";
import type { AppState, CfgPrepared, ChatEntry, ServerEvent } from "@shared/protocol";
import { api, connectEvents } from "./api";

export interface Toast {
  id: number;
  level: "info" | "warn" | "error";
  code: string;
  /** Extra data for the message, e.g. the sender whose command was ignored. */
  detail?: string;
}

export interface ServerView {
  app: AppState | null;
  entries: ChatEntry[];
  connection: "connecting" | "online" | "offline" | "failed";
  toasts: Toast[];
  /** The message currently prepared behind the in-game key (null = nothing). Only a newer click can replace it. */
  prepared: CfgPrepared | null;
}

type Action =
  | { type: "state"; state: AppState }
  | { type: "event"; event: ServerEvent }
  | { type: "connection"; value: ServerView["connection"] }
  | { type: "dismissToast"; id: number }
  | { type: "prepared"; cfg: CfgPrepared }
  | { type: "settings"; settings: AppState["settings"] };

const MAX_ENTRIES = 500;
let toastSeq = 0;

export function reduce(view: ServerView, action: Action): ServerView {
  switch (action.type) {
    case "state":
      return { ...view, app: action.state, entries: action.state.history, prepared: action.state.prepared, connection: "online" };
    case "connection":
      return { ...view, connection: action.value };
    case "settings":
      return view.app ? { ...view, app: { ...view.app, settings: action.settings } } : view;
    case "dismissToast":
      return { ...view, toasts: view.toasts.filter((t) => t.id !== action.id) };
    case "prepared":
      return { ...view, prepared: newer(view.prepared, action.cfg) };
    case "event":
      return applyEvent(view, action.event);
  }
}

/** Keeps the message from the LATEST click, whatever order the response and the live event arrive in. */
function newer(current: CfgPrepared | null, incoming: CfgPrepared): CfgPrepared {
  return current && current.clickedAt > incoming.clickedAt ? current : incoming;
}

function applyEvent(view: ServerView, e: ServerEvent): ServerView {
  switch (e.type) {
    case "chat": {
      const entry: ChatEntry = { ...e.message, translation: { id: e.message.id, status: "pending" } };
      const entries = [...view.entries, entry];
      return { ...view, entries: entries.length > MAX_ENTRIES ? entries.slice(-MAX_ENTRIES) : entries };
    }
    case "translation":
      return { ...view, entries: view.entries.map((x) => (x.id === e.update.id ? { ...x, translation: e.update } : x)) };
    case "cleared":
      return { ...view, entries: [] };
    case "watcher":
      return view.app ? { ...view, app: { ...view.app, watcher: e.status } } : view;
    case "format":
      return view.app ? { ...view, app: { ...view.app, format: e.status } } : view;
    case "runtime":
      return view.app ? { ...view, app: { ...view.app, runtime: e.status } } : view;
    case "cfg":
      return { ...view, prepared: newer(view.prepared, e.prepared) };
    case "cfg-cleared":
      return { ...view, prepared: null };
    case "identity":
      return view.app ? { ...view, app: { ...view.app, identity: e.identity } } : view;
    case "notice":
      return {
        ...view,
        toasts: [
          ...view.toasts.filter((t) => t.code !== e.code),
          { id: ++toastSeq, level: e.level, code: e.code, ...(e.detail ? { detail: e.detail } : {}) },
        ],
      };
  }
}

const initial: ServerView = { app: null, entries: [], connection: "connecting", toasts: [], prepared: null };

/** Loads the app state, keeps it live over SSE and resyncs after every reconnect. */
export function useServer() {
  const [view, dispatch] = useReducer(reduce, initial);
  const loaded = useRef(false);

  const resync = useCallback(async () => {
    try {
      dispatch({ type: "state", state: await api.state() });
      loaded.current = true;
    } catch {
      dispatch({ type: "connection", value: loaded.current ? "offline" : "failed" });
    }
  }, []);

  useEffect(() => {
    return connectEvents({
      onOpen: () => void resync(),
      onClose: () => dispatch({ type: "connection", value: loaded.current ? "offline" : "connecting" }),
      onEvent: (event) => dispatch({ type: "event", event }),
    });
  }, [resync]);

  return {
    view,
    dismissToast: (id: number) => dispatch({ type: "dismissToast", id }),
    setPrepared: (cfg: CfgPrepared) => dispatch({ type: "prepared", cfg }),
    clearPrepared: () => dispatch({ type: "event", event: { type: "cfg-cleared" } }),
    setSettings: (settings: AppState["settings"]) => dispatch({ type: "settings", settings }),
    resync,
  };
}

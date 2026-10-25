import type { ChatChannel } from "./protocol";

/** How the chat log is laid out. Presentation only: every mode shares the same message list. */
export const CHAT_VIEWS = ["mixed", "team", "all", "split"] as const;
export type ChatView = (typeof CHAT_VIEWS)[number];

export const CHAT_FONT_MIN = 12;
export const CHAT_FONT_MAX = 24;
export const CHAT_FONT_DEFAULT = 15;

export type ChatBucket = "team" | "all" | "other";

/**
 * Strictly by the channel the log parser read from the game's own chat tag. Team chat is the `ct` / `t` channel,
 * all chat is `all`; anything else (spectator, ...) is "other" and is never folded into either side.
 */
export function bucketOf(channel: ChatChannel): ChatBucket {
  if (channel === "ct" || channel === "t") return "team";
  if (channel === "all") return "all";
  return "other";
}

export function clampChatFont(n: number): number {
  return Math.min(CHAT_FONT_MAX, Math.max(CHAT_FONT_MIN, Math.round(n)));
}

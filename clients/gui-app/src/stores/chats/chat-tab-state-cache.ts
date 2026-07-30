import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

/**
 * Reading position a chat tile restores when it remounts (tab switch -
 * decision #17 - or moved between panes). `anchorMessageId`/`offset` are
 * `null`/`0` while `following-end`: the tail is the whole story, so there is
 * nothing to anchor to. While `free-scrolling` they capture exactly which row
 * was at the reading line and how many px into (or past) it the scroll had
 * gone, so restore reproduces the same pixel position, not just "some row is
 * visible" - the `anchoring-new-turn` mode never appears here: a remount
 * mid-anchor has no live anchor/settle sequence left to resume, so the save
 * path collapses it to `free-scrolling` at wherever it had settled (see
 * `chat-messages.tsx`'s unmount effect).
 */
export type ChatTabScrollMode = "following-end" | "free-scrolling";

export interface SavedChatTabScrollState {
  readonly mode: ChatTabScrollMode;
  readonly anchorMessageId: string | null;
  readonly offset: number;
}

const CHAT_TAB_STATE_CACHE_LIMIT = 200;

const DEFAULT_CHAT_TAB_SCROLL_STATE: SavedChatTabScrollState = {
  mode: "following-end",
  anchorMessageId: null,
  offset: 0,
};

// Survives remounts because it lives at module scope, outside the React tree.
// Keyed by the tile instance id; entries are dropped LRU-by-last-save once the
// cap is exceeded, and evicted outright when a tab permanently closes (see the
// canvas store's tile-removal subscriber in `stores/epics/canvas/store.ts`).
const chatTabStateCache = new Map<string, SavedChatTabScrollState>();

/**
 * Whether `key` has a real cache entry, as opposed to `restoreChatTabState`
 * falling back to `DEFAULT_CHAT_TAB_SCROLL_STATE` - the two are
 * indistinguishable from the restored value alone (a genuinely-cached
 * following-end tab has the exact same shape as the default). The
 * controller's fresh-open policy (decision #15) needs this distinction: "no
 * saved state" anchors the last user message; a restored `following-end` tab
 * keeps following the tail.
 */
export function hasSavedChatTabState(key: string): boolean {
  return chatTabStateCache.has(key);
}

export function restoreChatTabState(
  key: string,
  messages: ReadonlyArray<ChatMessageModel>,
): SavedChatTabScrollState {
  const saved = chatTabStateCache.get(key);
  if (saved === undefined) return DEFAULT_CHAT_TAB_SCROLL_STATE;
  if (saved.anchorMessageId === null) return saved;
  if (messages.some((message) => message.id === saved.anchorMessageId)) {
    return saved;
  }
  // The anchored message is gone (branch edit / suffix removal): keep the
  // mode but drop the stale anchor so restore falls back to the default
  // initial layout instead of scrolling to a missing row.
  return { mode: saved.mode, anchorMessageId: null, offset: 0 };
}

export function saveChatTabState(input: {
  readonly key: string;
  readonly mode: ChatTabScrollMode;
  readonly anchorMessageId: string | null;
  readonly offset: number;
}): void {
  // Delete-then-set refreshes insertion order so eviction is LRU, not FIFO.
  chatTabStateCache.delete(input.key);
  chatTabStateCache.set(input.key, {
    mode: input.mode,
    anchorMessageId: input.anchorMessageId,
    offset: input.offset,
  });
  pruneChatTabStateCache();
}

/** Drops entries outright for tabs that closed for good - called from the
 *  canvas store's tile-removal subscriber, never from a component unmount
 *  (a chat tile's own unmount cleanup guards on tile liveness instead, so it
 *  cannot resurrect what this just dropped). */
export function evictChatTabState(keys: ReadonlyArray<string>): void {
  keys.forEach((key) => chatTabStateCache.delete(key));
}

function pruneChatTabStateCache(): void {
  while (chatTabStateCache.size > CHAT_TAB_STATE_CACHE_LIMIT) {
    const oldestKey = chatTabStateCache.keys().next().value;
    if (typeof oldestKey !== "string") return;
    chatTabStateCache.delete(oldestKey);
  }
}

import { viewportActiveUserMessageId } from "@/components/chat/chat-messages-virtuoso-helpers";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

/**
 * Reading position a chat tile restores when it remounts (moved between panes,
 * re-shown past the mounted-tab LRU cap). A tile that was tailing the latest
 * message restores by re-pinning the bottom; an unpinned tile restores by
 * re-anchoring the user message it was parked on.
 */
export interface SavedChatScrollState {
  readonly bottomFollowing: boolean;
  readonly activeUserMessageId: string | null;
}

const CHAT_SCROLL_STATE_CACHE_LIMIT = 200;

const DEFAULT_CHAT_SCROLL_STATE: SavedChatScrollState = {
  bottomFollowing: true,
  activeUserMessageId: null,
};

// Survives remounts because it lives at module scope, outside the React tree.
// Keyed by the tile instance id; entries are dropped LRU-by-last-save once the
// cap is exceeded.
const chatScrollStateCache = new Map<string, SavedChatScrollState>();

export function restoreChatScrollState(
  key: string,
  messages: ReadonlyArray<ChatMessageModel>,
): SavedChatScrollState {
  const saved = chatScrollStateCache.get(key);
  if (saved === undefined) return DEFAULT_CHAT_SCROLL_STATE;
  if (saved.activeUserMessageId === null) return saved;
  if (messages.some((message) => message.id === saved.activeUserMessageId)) {
    return saved;
  }
  // The anchored message is gone (branch edit / suffix removal): keep the
  // follow intent but drop the stale anchor so restore falls back to the
  // default initial layout instead of scrolling to a missing row.
  return { bottomFollowing: saved.bottomFollowing, activeUserMessageId: null };
}

export function saveChatScrollState(input: {
  readonly key: string;
  readonly bottomFollowing: boolean;
  readonly messages: ReadonlyArray<ChatMessageModel>;
  readonly scroller: HTMLElement | null;
  readonly activeUserMessageId: string | null;
}): void {
  // Re-anchoring from the live viewport at save time captures any reading
  // position the last animation-frame update had not yet committed; the passed
  // id is the fallback when the scroller can no longer be measured.
  const activeUserMessageId = input.bottomFollowing
    ? null
    : (viewportActiveUserMessageId(input.scroller, input.messages) ??
      input.activeUserMessageId);
  // Delete-then-set refreshes insertion order so eviction is LRU, not FIFO.
  chatScrollStateCache.delete(input.key);
  chatScrollStateCache.set(input.key, {
    bottomFollowing: input.bottomFollowing,
    activeUserMessageId,
  });
  pruneChatScrollStateCache();
}

function pruneChatScrollStateCache(): void {
  while (chatScrollStateCache.size > CHAT_SCROLL_STATE_CACHE_LIMIT) {
    const oldestKey = chatScrollStateCache.keys().next().value;
    if (typeof oldestKey !== "string") return;
    chatScrollStateCache.delete(oldestKey);
  }
}

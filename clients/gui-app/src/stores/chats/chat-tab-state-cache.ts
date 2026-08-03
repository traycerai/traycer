import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import { createChatDurableCache } from "@/stores/chats/chat-durable-cache";
import {
  chatTabPersistenceTabKey,
  type ChatTabPersistenceIdentity,
} from "@/stores/chats/chat-tab-persistence-key";

/**
 * Reading position a chat tile restores when it remounts (tab switch -
 * decision #17 - or moved between panes), OR when the same chat is reopened
 * in a brand new tab after being fully closed (ticket 15; decision #29 - the
 * durable chat-key fallback). `anchorMessageId`/`offset` are `null`/`0`
 * while `following-end`: the tail is the whole story, so there is nothing to
 * anchor to. While `free-scrolling` they capture exactly which row was at
 * the reading line and how many px into (or past) it the scroll had gone, so
 * restore reproduces the same pixel position, not just "some row is visible"
 * While `anchoring-new-turn`, the anchor is semantic: the current turn's
 * query/setup-card row. Remounting must recreate the reply reserve and anchor
 * engine around that row; reducing it to a free-scrolling pixel snapshot makes
 * the anchored position unreachable once the reserve disappears.
 * `replyReserveMessageId` is deliberately independent of `mode` and
 * `anchorMessageId`: a reader gesture can release scroll-mover ownership while
 * the same streaming turn still owns reserved reply geometry. Persisting those
 * as one state caused each tab switch to discard the reserve, clamp the
 * viewport, and make the shifted landing the next save's baseline. `anchorIndex`
 * is the anchor row's index at save time - kept alongside the id so a stale
 * free-scrolling anchor can clamp to the nearest surviving neighbor instead of
 * falling back to the top of the list. A stale new-turn anchor safely degrades
 * to that same free-scrolling fallback.
 */
export type ChatTabScrollMode =
  "following-end" | "anchoring-new-turn" | "free-scrolling";

export interface SavedChatTabScrollState {
  readonly mode: ChatTabScrollMode;
  readonly anchorMessageId: string | null;
  readonly anchorIndex: number | null;
  readonly offset: number;
  readonly replyReserveMessageId: string | null;
}

const CHAT_TAB_STATE_CACHE_LIMIT = 200;
const CHAT_TAB_STATE_DURABLE_CACHE_LIMIT = 200;

const DEFAULT_CHAT_TAB_SCROLL_STATE: SavedChatTabScrollState = {
  mode: "following-end",
  anchorMessageId: null,
  anchorIndex: null,
  offset: 0,
  replyReserveMessageId: null,
};

// Survives remounts because it lives at module scope, outside the React tree.
// Keyed by the tile instance id; entries are dropped LRU-by-last-save once the
// cap is exceeded, and evicted outright when a tab permanently closes (see the
// canvas store's tile-removal subscriber in `stores/epics/canvas/store.ts`).
const chatTabStateCache = new Map<string, SavedChatTabScrollState>();

// Ticket 15 (decision #29): the durable chat-key half of the dual-key cache -
// survives the tab-key entry being evicted on close, so reopening a chat
// restores its reading position. Last-writer-wins across multiple open views
// of the same chat; memory-only, LRU-bounded like the tab-key side.
const durableChatTabStateCache =
  createChatDurableCache<SavedChatTabScrollState>(
    CHAT_TAB_STATE_DURABLE_CACHE_LIMIT,
  );

/**
 * Whether `identity` has a real cache entry (tab-key OR chat-key), as
 * opposed to `restoreChatTabState` falling back to
 * `DEFAULT_CHAT_TAB_SCROLL_STATE` - the two are indistinguishable from the
 * restored value alone (a genuinely-cached following-end tab has the exact
 * same shape as the default). The controller's fresh-open policy (decision
 * #15) needs this distinction: "no saved state" anchors the last user
 * message (or seeds following-end while streaming - decision #29); a
 * restored `following-end` tab keeps following the tail.
 */
export function hasSavedChatTabState(
  identity: ChatTabPersistenceIdentity,
): boolean {
  return (
    chatTabStateCache.has(chatTabPersistenceTabKey(identity)) ||
    durableChatTabStateCache.get(identity) !== undefined
  );
}

/**
 * Returns the raw, unclamped persisted state. Hydration-aware restoration
 * needs the original row offset as well as its id; `restoreChatTabState`
 * intentionally resets that offset when it substitutes a temporary neighbor.
 */
export function peekSavedChatTabState(
  identity: ChatTabPersistenceIdentity,
): SavedChatTabScrollState | null {
  return (
    chatTabStateCache.get(chatTabPersistenceTabKey(identity)) ??
    durableChatTabStateCache.get(identity) ??
    null
  );
}

export function restoreChatTabState(
  identity: ChatTabPersistenceIdentity,
  messages: ReadonlyArray<ChatMessageModel>,
): SavedChatTabScrollState {
  const saved =
    chatTabStateCache.get(chatTabPersistenceTabKey(identity)) ??
    durableChatTabStateCache.get(identity);
  if (saved === undefined) return DEFAULT_CHAT_TAB_SCROLL_STATE;
  const replyReserveMessageId =
    saved.mode !== "following-end" &&
    saved.replyReserveMessageId !== null &&
    messages.some((message) => message.id === saved.replyReserveMessageId)
      ? saved.replyReserveMessageId
      : null;
  const normalized =
    replyReserveMessageId === saved.replyReserveMessageId
      ? saved
      : { ...saved, replyReserveMessageId };
  if (normalized.anchorMessageId === null) {
    return normalized.mode === "anchoring-new-turn"
      ? { ...normalized, mode: "free-scrolling", offset: 0 }
      : normalized;
  }
  if (messages.some((message) => message.id === normalized.anchorMessageId)) {
    return normalized;
  }
  // The anchored message is gone (branch edit / suffix removal): clamp the
  // saved index into the current list and anchor the nearest surviving
  // neighbor instead of falling back to the top of the list. `offset` resets
  // to 0 - the substituted row's own pixel offset carries no meaning for a
  // different anchor.
  if (messages.length === 0 || normalized.anchorIndex === null) {
    return {
      mode:
        normalized.mode === "anchoring-new-turn"
          ? "free-scrolling"
          : normalized.mode,
      anchorMessageId: null,
      anchorIndex: null,
      offset: 0,
      replyReserveMessageId,
    };
  }
  const clampedIndex = Math.min(
    Math.max(normalized.anchorIndex, 0),
    messages.length - 1,
  );
  const neighbor = messages[clampedIndex];
  return {
    mode:
      normalized.mode === "anchoring-new-turn"
        ? "free-scrolling"
        : normalized.mode,
    anchorMessageId: neighbor.id,
    anchorIndex: clampedIndex,
    offset: 0,
    replyReserveMessageId,
  };
}

export interface SaveChatTabStateInput {
  readonly identity: ChatTabPersistenceIdentity;
  readonly mode: ChatTabScrollMode;
  readonly anchorMessageId: string | null;
  readonly anchorIndex: number | null;
  readonly offset: number;
  /**
   * Required only when geometry cannot be derived from mode: a detached
   * free-scrolling reader retaining a streaming turn's reserve. Anchoring
   * mode derives the reserve from its semantic anchor; all other callers
   * naturally default to no reserve.
   */
  readonly replyReserveMessageId?: string | null;
}

function toSavedChatTabScrollState(
  input: SaveChatTabStateInput,
): SavedChatTabScrollState {
  return {
    mode: input.mode,
    anchorMessageId: input.anchorMessageId,
    anchorIndex: input.anchorIndex,
    offset: input.offset,
    replyReserveMessageId:
      input.mode === "following-end"
        ? null
        : (input.replyReserveMessageId ??
          (input.mode === "anchoring-new-turn" ? input.anchorMessageId : null)),
  };
}

/** Writes BOTH the tab-key and durable chat-key entries - the live-unmount
 *  path (tab switch / pane move), where the tab-key entry legitimately
 *  survives for a same-instanceId remount to restore from. */
export function saveChatTabState(input: SaveChatTabStateInput): void {
  const value = toSavedChatTabScrollState(input);
  const tabKey = chatTabPersistenceTabKey(input.identity);
  // Delete-then-set refreshes insertion order so eviction is LRU, not FIFO.
  chatTabStateCache.delete(tabKey);
  chatTabStateCache.set(tabKey, value);
  pruneChatTabStateCache();
  // Every save also writes the durable chat-key entry (decision #29) -
  // last-writer-wins across multiple open views of the same chat.
  durableChatTabStateCache.set(input.identity, value);
}

/**
 * Ticket 15 review (F1): writes ONLY the durable chat-key entry - the
 * genuine-close path. The canvas store's tile-removal sweep evicts the
 * tab-key entry SYNCHRONOUSLY, before this component's own unmount cleanup
 * ever runs (`isEpicCanvasTileInstanceLive` already reads false by then) -
 * writing the tab-key here would resurrect an entry the sweep just dropped.
 * The durable write still needs to happen: it is the ONLY chance this
 * closing view's final position ever reaches durable storage, since it was
 * never "saved" by the (never-live-again) tab-key path.
 */
export function commitChatTabStateToDurable(
  input: SaveChatTabStateInput,
): void {
  durableChatTabStateCache.set(
    input.identity,
    toSavedChatTabScrollState(input),
  );
}

/**
 * Ticket 15 review round 3: promotes the EXISTING tab-key entry (if any) to
 * durable - called from the canvas close sweep, BEFORE `evictChatTabState`
 * drops the tab-key entry, for every removed chat tile. Fixes the
 * inactive-view gap: an inactive (never-active, but still LIVE/mounted-once)
 * tab's tab-key entry was already written by ticket 5's per-tab persistence
 * the last time it was live, regardless of whether it is the CURRENTLY
 * focused tab - this promotes whatever that entry holds. The scroll
 * cache's own component-owned unmount cleanup (chat-messages.tsx) still
 * runs too and, for an ACTIVE view, writes a fresher value afterward
 * (this promotion runs first in the same synchronous sweep, so the
 * cleanup's later write - for a live component - simply wins by ordering).
 */
export function promoteChatTabStateToDurable(
  identity: ChatTabPersistenceIdentity,
): void {
  const tabValue = chatTabStateCache.get(chatTabPersistenceTabKey(identity));
  if (tabValue === undefined) return;
  durableChatTabStateCache.set(identity, tabValue);
}

/** Drops entries outright for tabs that closed for good - called from the
 *  canvas store's tile-removal subscriber, never from a component unmount
 *  (a chat tile's own unmount cleanup guards on tile liveness instead, so it
 *  cannot resurrect what this just dropped). Tab-key only - the durable
 *  chat-key entry survives a close so a reopen can restore it. */
export function evictChatTabState(keys: ReadonlyArray<string>): void {
  keys.forEach((key) => chatTabStateCache.delete(key));
}

/** Drops the durable chat-key entry - called when the CHAT itself is
 *  deleted, not on an ordinary tab close. */
export function evictChatTabStateForChat(
  identity: Pick<ChatTabPersistenceIdentity, "epicId" | "chatId">,
): void {
  durableChatTabStateCache.deleteChat(identity);
}

/** Drops every durable chat-key entry belonging to a deleted/access-lost
 *  epic. */
export function evictChatTabStateForEpic(epicId: string): void {
  durableChatTabStateCache.deleteEpic(epicId);
}

function pruneChatTabStateCache(): void {
  while (chatTabStateCache.size > CHAT_TAB_STATE_CACHE_LIMIT) {
    const oldestKey = chatTabStateCache.keys().next().value;
    if (typeof oldestKey !== "string") return;
    chatTabStateCache.delete(oldestKey);
  }
}

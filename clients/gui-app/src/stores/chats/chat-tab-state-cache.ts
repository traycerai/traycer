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
 * - the `anchoring-new-turn` mode never appears here: a remount mid-anchor
 * has no live anchor/settle sequence left to resume, so the save path
 * collapses it to `free-scrolling` at wherever it had settled (see
 * `chat-messages.tsx`'s unmount effect). `anchorIndex` is the anchor row's
 * index at save time - kept alongside the id so a stale-anchor restore (the
 * row is gone - branch edit / suffix removal) can clamp to the nearest
 * surviving neighbor instead of falling back to the top of the list.
 */
export type ChatTabScrollMode = "following-end" | "free-scrolling";

export interface SavedChatTabScrollState {
  readonly mode: ChatTabScrollMode;
  readonly anchorMessageId: string | null;
  readonly anchorIndex: number | null;
  readonly offset: number;
}

const CHAT_TAB_STATE_CACHE_LIMIT = 200;
const CHAT_TAB_STATE_DURABLE_CACHE_LIMIT = 200;

const DEFAULT_CHAT_TAB_SCROLL_STATE: SavedChatTabScrollState = {
  mode: "following-end",
  anchorMessageId: null,
  anchorIndex: null,
  offset: 0,
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
 * Ticket 15 review (live pass S5): the RAW saved `anchorMessageId`, with
 * none of `restoreChatTabState`'s messages-dependent clamp logic - lets a
 * caller tell "the mount-time restore found the true saved anchor" apart
 * from "it silently clamped to a neighbor because messages was still
 * mid-hydration", which `restoreChatTabState`'s own return value cannot
 * distinguish (a clamp always returns an id that IS present in whatever
 * `messages` it was given). `null` when there is nothing saved, or the
 * saved state has no anchor (`following-end`, or a genuinely-empty capture).
 */
export function peekSavedChatTabAnchorMessageId(
  identity: ChatTabPersistenceIdentity,
): string | null {
  const saved =
    chatTabStateCache.get(chatTabPersistenceTabKey(identity)) ??
    durableChatTabStateCache.get(identity);
  return saved?.anchorMessageId ?? null;
}

export function restoreChatTabState(
  identity: ChatTabPersistenceIdentity,
  messages: ReadonlyArray<ChatMessageModel>,
): SavedChatTabScrollState {
  const saved =
    chatTabStateCache.get(chatTabPersistenceTabKey(identity)) ??
    durableChatTabStateCache.get(identity);
  if (saved === undefined) return DEFAULT_CHAT_TAB_SCROLL_STATE;
  if (saved.anchorMessageId === null) return saved;
  if (messages.some((message) => message.id === saved.anchorMessageId)) {
    return saved;
  }
  // The anchored message is gone (branch edit / suffix removal): clamp the
  // saved index into the current list and anchor the nearest surviving
  // neighbor instead of falling back to the top of the list. `offset` resets
  // to 0 - the substituted row's own pixel offset carries no meaning for a
  // different anchor.
  if (messages.length === 0 || saved.anchorIndex === null) {
    return {
      mode: saved.mode,
      anchorMessageId: null,
      anchorIndex: null,
      offset: 0,
    };
  }
  const clampedIndex = Math.min(
    Math.max(saved.anchorIndex, 0),
    messages.length - 1,
  );
  const neighbor = messages[clampedIndex];
  return {
    mode: saved.mode,
    anchorMessageId: neighbor.id,
    anchorIndex: clampedIndex,
    offset: 0,
  };
}

export interface SaveChatTabStateInput {
  readonly identity: ChatTabPersistenceIdentity;
  readonly mode: ChatTabScrollMode;
  readonly anchorMessageId: string | null;
  readonly anchorIndex: number | null;
  readonly offset: number;
}

function toSavedChatTabScrollState(
  input: SaveChatTabStateInput,
): SavedChatTabScrollState {
  return {
    mode: input.mode,
    anchorMessageId: input.anchorMessageId,
    anchorIndex: input.anchorIndex,
    offset: input.offset,
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

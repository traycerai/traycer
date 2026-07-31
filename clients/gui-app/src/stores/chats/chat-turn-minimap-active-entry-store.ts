import { createChatDurableCache } from "@/stores/chats/chat-durable-cache";
import {
  chatTabPersistenceTabKey,
  type ChatTabPersistenceIdentity,
} from "@/stores/chats/chat-tab-persistence-key";

/**
 * Ticket 15 (decision #29, closing the ticket-5/decision-#19 gap): the
 * minimap's active (hovered/focused) entry joins the per-tab restoration
 * family. Stored as the active turn's user-message id (not a raw rail
 * index - the rail's `items` array can differ in length across a remount)
 * so restore re-resolves it against whatever items exist at mount.
 */
const tabActiveEntryCache = new Map<string, string | null>();

const CHAT_TURN_MINIMAP_TAB_CACHE_LIMIT = 200;
const CHAT_TURN_MINIMAP_DURABLE_CACHE_LIMIT = 200;

const durableActiveEntryCache = createChatDurableCache<string | null>(
  CHAT_TURN_MINIMAP_DURABLE_CACHE_LIMIT,
);

export function restoreChatTurnMinimapActiveEntry(
  identity: ChatTabPersistenceIdentity,
): string | null {
  const tabKey = chatTabPersistenceTabKey(identity);
  if (tabActiveEntryCache.has(tabKey)) {
    return tabActiveEntryCache.get(tabKey) ?? null;
  }
  return durableActiveEntryCache.get(identity) ?? null;
}

/**
 * Live tab-key write - called on every genuine hover/keyboard-nav change so
 * a switch-away-then-back (same tileInstanceId) restores the active entry.
 * Ticket 15 review round 3: does NOT also write durable - that would give
 * "last-mutation-wins" instead of decision #29's literal "last-CLOSED-wins"
 * (see `promoteChatTurnMinimapActiveEntryToDurable`, called from the canvas
 * close sweep instead).
 */
export function saveChatTurnMinimapActiveEntry(
  identity: ChatTabPersistenceIdentity,
  activeMessageId: string | null,
): void {
  const tabKey = chatTabPersistenceTabKey(identity);
  tabActiveEntryCache.delete(tabKey);
  tabActiveEntryCache.set(tabKey, activeMessageId);
  pruneTabActiveEntryCache();
}

/**
 * Ticket 15 review round 3: promotes the EXISTING tab-key entry (if any) to
 * durable - called from the canvas close sweep, BEFORE
 * `evictChatTurnMinimapActiveEntries` drops the tab-key entry, for every
 * removed chat tile. A no-op if this tab's scope was never touched
 * (`.has()`, not a null check - `null` is itself a legitimate "nothing was
 * ever active" value once touched).
 */
export function promoteChatTurnMinimapActiveEntryToDurable(
  identity: ChatTabPersistenceIdentity,
): void {
  const tabKey = chatTabPersistenceTabKey(identity);
  if (!tabActiveEntryCache.has(tabKey)) return;
  durableActiveEntryCache.set(
    identity,
    tabActiveEntryCache.get(tabKey) ?? null,
  );
}

/** Drops entries outright for tabs that closed for good - called from the
 *  canvas store's tile-removal subscriber alongside the other per-tab
 *  registries. Tab-key only - the durable chat-key entry survives a close
 *  so a reopen can restore it. */
export function evictChatTurnMinimapActiveEntries(
  keys: ReadonlyArray<string>,
): void {
  keys.forEach((key) => tabActiveEntryCache.delete(key));
}

/** Drops the durable chat-key entry - called when the CHAT itself is
 *  deleted, not on an ordinary tab close. */
export function evictChatTurnMinimapActiveEntryForChat(
  identity: Pick<ChatTabPersistenceIdentity, "epicId" | "chatId">,
): void {
  durableActiveEntryCache.deleteChat(identity);
}

/** Drops every durable chat-key entry belonging to a deleted/access-lost
 *  epic. */
export function evictChatTurnMinimapActiveEntriesForEpic(epicId: string): void {
  durableActiveEntryCache.deleteEpic(epicId);
}

function pruneTabActiveEntryCache(): void {
  while (tabActiveEntryCache.size > CHAT_TURN_MINIMAP_TAB_CACHE_LIMIT) {
    const oldestKey = tabActiveEntryCache.keys().next().value;
    if (typeof oldestKey !== "string") return;
    tabActiveEntryCache.delete(oldestKey);
  }
}

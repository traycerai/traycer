import {
  chatTabPersistenceChatKey,
  type ChatTabPersistenceIdentity,
} from "@/stores/chats/chat-tab-persistence-key";
import { isChatKeyTombstoned } from "@/stores/chats/chat-tab-persistence-tombstone";

type ChatIdentity = Pick<ChatTabPersistenceIdentity, "epicId" | "chatId">;

/**
 * The durable (chat-key) half of a ticket-15 dual-key registry: a
 * module-scope, bounded LRU keyed by `(epicId, chatId)` so it survives a
 * tab's tileInstanceId being evicted on close. Memory-only, no persistence -
 * a reload falls through to the streaming-aware fresh-open policy, which is
 * the correct degraded behavior (decision #29).
 */
export interface ChatDurableCache<T> {
  readonly get: (identity: ChatIdentity) => T | undefined;
  readonly set: (identity: ChatIdentity, value: T) => void;
  /** Deleted when the CHAT is deleted (host chat-deletion event). */
  readonly deleteChat: (identity: ChatIdentity) => void;
  /** Deleted when the whole EPIC is deleted/access is lost. */
  readonly deleteEpic: (epicId: string) => void;
  /** Test-only full reset - a registry's own `resetForTests` (where one
   *  exists) must also clear its durable cache, since it lives outside the
   *  reactive store `resetForTests` would otherwise reset alone. */
  readonly clearForTests: () => void;
}

export function createChatDurableCache<T>(limit: number): ChatDurableCache<T> {
  const cache = new Map<string, T>();
  function prune(): void {
    while (cache.size > limit) {
      const oldestKey = cache.keys().next().value;
      if (typeof oldestKey !== "string") return;
      cache.delete(oldestKey);
    }
  }
  return {
    get: (identity) => {
      const key = chatTabPersistenceChatKey(identity);
      const value = cache.get(key);
      // Ticket 15 review (F6): a get() must also refresh recency - without
      // this, insertion order alone means an entry read every reopen but
      // never re-saved (e.g. a chat that is only ever browsed, never
      // scrolled) still ages out on schedule while genuinely idle entries
      // that happened to be saved more recently survive. True LRU, not FIFO.
      if (value !== undefined) {
        cache.delete(key);
        cache.set(key, value);
      }
      return value;
    },
    set: (identity, value) => {
      const key = chatTabPersistenceChatKey(identity);
      // Ticket 15 review round 3: a terminally deleted chat/epic refuses
      // every future write regardless of who runs last - the sweep's
      // promotion and the deletion mutation's own eviction race (the sweep
      // fires synchronously on tab close; the deletion's `onSuccess` fires
      // later, after the host round-trip), and no reordering of those two
      // callbacks can be relied on to always land the delete last.
      if (isChatKeyTombstoned(key)) return;
      // Delete-then-set refreshes insertion order so eviction is LRU.
      cache.delete(key);
      cache.set(key, value);
      prune();
    },
    deleteChat: (identity) => {
      cache.delete(chatTabPersistenceChatKey(identity));
    },
    deleteEpic: (epicId) => {
      const prefix = `${epicId}:`;
      for (const key of cache.keys()) {
        if (key.startsWith(prefix)) cache.delete(key);
      }
    },
    clearForTests: () => {
      cache.clear();
    },
  };
}

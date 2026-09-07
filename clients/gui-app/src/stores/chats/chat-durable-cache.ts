import {
  chatTabPersistenceChatKey,
  type ChatTabPersistenceIdentity,
} from "@/stores/chats/chat-tab-persistence-key";
import { isChatKeyTombstoned } from "@/stores/chats/chat-tab-persistence-tombstone";

type ChatIdentity = Pick<ChatTabPersistenceIdentity, "epicId" | "chatId">;

/**
 * The durable (chat-key) half of a ticket-15 dual-key registry: a module-scope, bounded LRU keyed
 * by `(epicId, chatId)` so it survives a tab's tileInstanceId being evicted on close.
 */
export interface ChatDurableCache<T> {
  readonly get: (identity: ChatIdentity) => T | undefined;
  readonly set: (identity: ChatIdentity, value: T) => void;
  /** Deleted when the CHAT is deleted (host chat-deletion event). */
  readonly deleteChat: (identity: ChatIdentity) => void;
  /** Deleted when the whole EPIC is deleted/access is lost. */
  readonly deleteEpic: (epicId: string) => void;
  /** Test-only full reset. A registry `resetForTests` must also clear this cache. */
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
      // get() must refresh recency; insertion order alone is not LRU.
      if (value !== undefined) {
        cache.delete(key);
        cache.set(key, value);
      }
      return value;
    },
    set: (identity, value) => {
      const key = chatTabPersistenceChatKey(identity);
      // Tombstoned chats refuse every future write, regardless of who runs last.
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

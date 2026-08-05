import {
  chatTabPersistenceTabKey,
  type ChatTabPersistenceIdentity,
} from "@/stores/chats/chat-tab-persistence-key";
import type { SavedChatTabScrollState } from "@/stores/chats/chat-tab-state-cache";

const MAX_PENDING_HYDRATION_RESTORES = 100;

/**
 * The ordinary caches are normalized to a measured surviving neighbor so a
 * deleted anchor cannot hold persistence behind a restore gate forever. Keep
 * the original snapshot separately for the narrower reconnect/backfill race:
 * a rapid remount may still see the missing row later in the same renderer
 * session. Reader/navigation intent and successful catch-up remove the
 * entry; the LRU-style cap prevents abandoned tabs from growing this
 * registry. Module-scope, not component state, so it survives across a
 * same-instance remount the way `chat-tab-state-cache.ts`'s caches do.
 */
const pendingHydrationRestoreByTabKey = new Map<
  string,
  SavedChatTabScrollState
>();

export function rememberPendingHydrationRestore(
  identity: ChatTabPersistenceIdentity,
  saved: SavedChatTabScrollState,
): void {
  const key = chatTabPersistenceTabKey(identity);
  pendingHydrationRestoreByTabKey.delete(key);
  pendingHydrationRestoreByTabKey.set(key, saved);
  const oldestKey = pendingHydrationRestoreByTabKey.keys().next().value;
  if (
    pendingHydrationRestoreByTabKey.size > MAX_PENDING_HYDRATION_RESTORES &&
    oldestKey !== undefined
  ) {
    pendingHydrationRestoreByTabKey.delete(oldestKey);
  }
}

export function pendingHydrationRestore(
  identity: ChatTabPersistenceIdentity,
): SavedChatTabScrollState | null {
  return (
    pendingHydrationRestoreByTabKey.get(chatTabPersistenceTabKey(identity)) ??
    null
  );
}

export function forgetPendingHydrationRestore(
  identity: ChatTabPersistenceIdentity,
): void {
  pendingHydrationRestoreByTabKey.delete(chatTabPersistenceTabKey(identity));
}

export function evictPendingHydrationRestores(
  tileInstanceIds: readonly string[],
): void {
  const removed = new Set(tileInstanceIds);
  for (const key of pendingHydrationRestoreByTabKey.keys()) {
    if (removed.has(key)) {
      pendingHydrationRestoreByTabKey.delete(key);
    }
  }
}

/** Test-only: the registry is module-scope, so a matrix/suite that reuses
 *  fixed tile instance ids across rows/tests needs a way to clear it between
 *  them - otherwise a later row's mount can inherit an earlier row's pending
 *  entry even after every ordinary cache was reset. */
export function resetPendingHydrationRestoreForTesting(): void {
  pendingHydrationRestoreByTabKey.clear();
}

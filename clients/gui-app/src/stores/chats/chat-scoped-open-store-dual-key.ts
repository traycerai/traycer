import { useEffect } from "react";
import type { ChatDurableCache } from "@/stores/chats/chat-durable-cache";
import type { ChatTabPersistenceIdentity } from "@/stores/chats/chat-tab-persistence-key";

interface ScopedOpenState {
  readonly openIds: ReadonlySet<string>;
  readonly setOpen: (scope: string, segmentId: string, open: boolean) => void;
}

interface ScopedOpenStoreApi {
  readonly getState: () => ScopedOpenState;
}

export function readScopedIds(
  openIds: ReadonlySet<string>,
  prefix: string,
): ReadonlySet<string> {
  const scoped = new Set<string>();
  for (const scopedId of openIds) {
    if (scopedId.startsWith(prefix)) scoped.add(scopedId.slice(prefix.length));
  }
  return scoped;
}

export function useChatScopedOpenStoreDualKeySeed(
  store: ScopedOpenStoreApi,
  identity: ChatTabPersistenceIdentity,
  durableCache: ChatDurableCache<ReadonlySet<string>>,
  initializedScopes: Set<string>,
): void {
  useEffect(() => {
    const tabKey = identity.tileInstanceId;
    if (initializedScopes.has(tabKey)) return;
    initializedScopes.add(tabKey);
    const durable = durableCache.get(identity);
    if (durable === undefined) return;
    for (const segmentId of durable) {
      store.getState().setOpen(tabKey, segmentId, true);
    }
  }, [store, identity, durableCache, initializedScopes]);
}

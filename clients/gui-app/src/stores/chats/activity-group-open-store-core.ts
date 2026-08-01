import { createStore, type StoreApi } from "zustand/vanilla";
import { addWithFifoEviction } from "@/lib/bounded-set";
import {
  MAX_ACTIVITY_GROUP_OPEN_IDS,
  type ActivityGroupOpenState,
} from "./activity-group-open-store-context";
import { createChatDurableCache } from "@/stores/chats/chat-durable-cache";
import {
  chatTabPersistenceTabKey,
  type ChatTabPersistenceIdentity,
} from "@/stores/chats/chat-tab-persistence-key";

export function createActivityGroupOpenStore(
  initialOpenIds: ReadonlySet<string> | null,
): StoreApi<ActivityGroupOpenState> {
  return createStore<ActivityGroupOpenState>((set) => ({
    openIds: initialOpenIds ?? new Set<string>(),
    setOpen: (groupId, open) =>
      set((state) => {
        const wasOpen = state.openIds.has(groupId);
        if (wasOpen === open) return state;
        const next = new Set(state.openIds);
        if (open) {
          addWithFifoEviction(next, groupId, MAX_ACTIVITY_GROUP_OPEN_IDS);
        } else {
          next.delete(groupId);
        }
        return { openIds: next };
      }),
  }));
}

// Ticket 5: chat tiles fully remount per tab switch (decision #17). Retaining
// the same store instance across that remount (instead of always creating a
// fresh one) is what makes expanded activity groups survive it. Keyed by tile
// instance id, at module scope so it outlives the React tree; evicted only
// when a tab permanently closes (see the canvas store's tile-removal
// subscriber in `stores/epics/canvas/store.ts`), never on a mere remount.
const activityGroupOpenStoreRegistry = new Map<
  string,
  StoreApi<ActivityGroupOpenState>
>();

// Ticket 15 (decision #29): durable chat-key mirror - survives the tab-key
// store being evicted on close, so a reopened chat's expanded activity
// groups come back. Last-writer-wins across multiple open views of the same
// chat.
//
// Ticket 15 review round 3: promoted explicitly from the canvas close
// sweep's choke point (store.ts) - see the matching comment in
// a2a-open-store-context.ts for why (covers active AND inactive/
// never-mounted views alike).
const durableActivityGroupOpenCache =
  createChatDurableCache<ReadonlySet<string>>(200);

export function getOrCreateActivityGroupOpenStore(
  identity: ChatTabPersistenceIdentity,
): StoreApi<ActivityGroupOpenState> {
  const tabKey = chatTabPersistenceTabKey(identity);
  const existing = activityGroupOpenStoreRegistry.get(tabKey);
  if (existing !== undefined) return existing;
  const store = createActivityGroupOpenStore(
    durableActivityGroupOpenCache.get(identity) ?? null,
  );
  activityGroupOpenStoreRegistry.set(tabKey, store);
  return store;
}

export function evictActivityGroupOpenStores(
  tileInstanceIds: ReadonlyArray<string>,
): void {
  tileInstanceIds.forEach((id) => activityGroupOpenStoreRegistry.delete(id));
}

/** Ticket 15 review round 3: promotes this tab's CURRENT state to durable -
 *  called from the canvas close sweep for every removed chat tile, BEFORE
 *  `evictActivityGroupOpenStores` drops the registry entry. A no-op if no
 *  store was ever created for this tab (never mounted). */
export function promoteActivityGroupOpenStoreToDurable(
  identity: ChatTabPersistenceIdentity,
): void {
  const store = activityGroupOpenStoreRegistry.get(
    chatTabPersistenceTabKey(identity),
  );
  if (store === undefined) return;
  durableActivityGroupOpenCache.set(identity, store.getState().openIds);
}

/** Drops the durable chat-key entry - called when the CHAT itself is
 *  deleted, not on an ordinary tab close. */
export function evictActivityGroupOpenStoreForChat(
  identity: Pick<ChatTabPersistenceIdentity, "epicId" | "chatId">,
): void {
  durableActivityGroupOpenCache.deleteChat(identity);
}

/** Drops every durable chat-key entry belonging to a deleted/access-lost
 *  epic. */
export function evictActivityGroupOpenStoresForEpic(epicId: string): void {
  durableActivityGroupOpenCache.deleteEpic(epicId);
}

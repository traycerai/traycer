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
    // Deliberately NOT seeded from the durable mirror, and entries are never deleted or evicted once
    // added.
    headedIds: new Set<string>(),
    markHeaded: (segmentIds) =>
      set((state) => {
        if (segmentIds.every((id) => state.headedIds.has(id))) return state;
        // UNCAPPED, unlike `openIds`, and the asymmetry is the point.
        const next = new Set(state.headedIds);
        for (const id of segmentIds) next.add(id);
        return { headedIds: next };
      }),
  }));
}

// the SAME tile instance still fully remounts - evicted past its pane's chat retention
// cap, evicted with its owning top-level surface, or losing and regaining hosted eligibility.
const activityGroupOpenStoreRegistry = new Map<
  string,
  StoreApi<ActivityGroupOpenState>
>();

// durable chat-key mirror - survives the tab-key store being evicted on
// close, so a reopened chat's expanded activity groups come back.
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

/**
 * promotes this tab's CURRENT state to durable - called from the canvas close sweep for every
 * removed chat tile, BEFORE `evictActivityGroupOpenStores` drops the registry entry.
 */
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

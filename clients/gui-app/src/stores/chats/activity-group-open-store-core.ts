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
    // Deliberately NOT seeded from the durable mirror, and entries are never
    // deleted or evicted once added.
    // It is a one-way record for as long as the tab lives: nothing that happens
    // to a group can un-show a header it already showed. Reopening a closed chat
    // is a fresh read, so starting empty there is right - the trace has not
    // vanished from under anyone.
    headedIds: new Set<string>(),
    markHeaded: (segmentIds) =>
      set((state) => {
        if (segmentIds.every((id) => state.headedIds.has(id))) return state;
        // UNCAPPED, unlike `openIds`, and the asymmetry is the point. A FIFO cap
        // here is not a cap, it is amnesia: evicting the oldest entry erases the
        // fact that a header was once on screen, so the next remount of that
        // group drops the header and unfolds a completed trace - the exact
        // discontinuity this set exists to prevent, just delayed until the 257th
        // group. A bound that can forget cannot back a latch.
        //
        // The growth is bounded by "reasoning blocks in this tab that have shown
        // a header", which is proportional to the transcript the tab is already
        // holding in memory, and each entry is one short id.
        const next = new Set(state.headedIds);
        for (const id of segmentIds) next.add(id);
        return { headedIds: next };
      }),
  }));
}

// Ticket 5: the SAME tile instance still fully remounts - evicted past its
// pane's chat retention cap, evicted with its owning top-level surface, or
// losing and regaining hosted eligibility. It no longer remounts on every
// inner tab switch (decision #17 was reversed by pane chat retention - see
// `stores/epics/canvas/retained-pane-chats.ts`). A close is NOT one of these:
// it evicts this entry outright, and a reopen mints a fresh `tileInstanceId`.
// Retaining the same store instance across a same-instance remount (instead of
// always creating a fresh one) is what makes expanded activity groups survive
// it. Keyed by tile
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

import { createContext, use } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { updateOpenIds } from "@/stores/chats/open-id-set";
import { createChatDurableCache } from "@/stores/chats/chat-durable-cache";
import {
  chatTabPersistenceTabKey,
  type ChatTabPersistenceIdentity,
} from "@/stores/chats/chat-tab-persistence-key";

export interface A2AOpenState {
  readonly sentOpenIds: ReadonlySet<string>;
  readonly receivedOpenIds: ReadonlySet<string>;
  readonly setSentOpen: (segmentId: string, open: boolean) => void;
  readonly setReceivedOpen: (messageId: string, open: boolean) => void;
}

interface A2AOpenSnapshot {
  readonly sentOpenIds: ReadonlySet<string>;
  readonly receivedOpenIds: ReadonlySet<string>;
}

export function createA2AOpenStore(
  initial: A2AOpenSnapshot | null,
): StoreApi<A2AOpenState> {
  return createStore<A2AOpenState>((set) => ({
    sentOpenIds: initial?.sentOpenIds ?? new Set<string>(),
    receivedOpenIds: initial?.receivedOpenIds ?? new Set<string>(),
    setSentOpen: (segmentId, open) =>
      set((state) => {
        const sentOpenIds = updateOpenIds(state.sentOpenIds, segmentId, open);
        if (sentOpenIds === state.sentOpenIds) return state;
        return { sentOpenIds };
      }),
    setReceivedOpen: (messageId, open) =>
      set((state) => {
        const receivedOpenIds = updateOpenIds(
          state.receivedOpenIds,
          messageId,
          open,
        );
        if (receivedOpenIds === state.receivedOpenIds) return state;
        return { receivedOpenIds };
      }),
  }));
}

// Ticket 5: the SAME tile instance still fully remounts - evicted past its
// pane's chat retention cap, evicted with its owning top-level surface, or
// losing and regaining hosted eligibility. It no longer remounts on every
// inner tab switch (decision #17 was reversed by pane chat retention - see
// `stores/epics/canvas/retained-pane-chats.ts`). A close is NOT one of these:
// it evicts this entry outright, and a reopen mints a fresh `tileInstanceId`,
// so nothing here is expected to survive it. Retaining the same store instance
// across a same-instance remount (instead of always creating a fresh one) is
// what makes expanded A2A send/received cards survive it. Keyed
// by tile instance id, at module scope so it outlives the React tree; evicted
// only when a tab permanently closes (see the canvas store's tile-removal
// subscriber in `stores/epics/canvas/store.ts`), never on a mere remount.
const a2aOpenStoreRegistry = new Map<string, StoreApi<A2AOpenState>>();

// Ticket 15 (decision #29): durable chat-key mirror of a tab-key store's
// open ids - survives the tab-key store being evicted on close, so a
// reopened chat's A2A cards start expanded again. Last-writer-wins across
// multiple open views of the same chat.
//
// Ticket 15 review round 3: promoted explicitly from the canvas close
// sweep's choke point (store.ts), not mirrored continuously and not owned
// by a per-component unmount - the sweep can read this registry directly
// whether or not the owning component ever mounted (an inactive/
// never-rendered tab has no unmount to hook), so it is the one place that
// correctly covers both an active AND an inactive view's close.
const durableA2AOpenCache = createChatDurableCache<A2AOpenSnapshot>(200);

export function getOrCreateA2AOpenStore(
  identity: ChatTabPersistenceIdentity,
): StoreApi<A2AOpenState> {
  const tabKey = chatTabPersistenceTabKey(identity);
  const existing = a2aOpenStoreRegistry.get(tabKey);
  if (existing !== undefined) return existing;
  const store = createA2AOpenStore(durableA2AOpenCache.get(identity) ?? null);
  a2aOpenStoreRegistry.set(tabKey, store);
  return store;
}

export function evictA2AOpenStores(
  tileInstanceIds: ReadonlyArray<string>,
): void {
  tileInstanceIds.forEach((id) => a2aOpenStoreRegistry.delete(id));
}

/**
 * Ticket 15 review round 3: promotes this tab's CURRENT state to durable -
 * called from the canvas close sweep for every removed chat tile, BEFORE
 * `evictA2AOpenStores` drops the registry entry. A no-op if no store was
 * ever created for this tab (never mounted) - nothing of this session's to
 * promote, and there is nothing else to accidentally clobber either (a
 * store is only ever created seeded from whatever durable already held).
 */
export function promoteA2AOpenStoreToDurable(
  identity: ChatTabPersistenceIdentity,
): void {
  const store = a2aOpenStoreRegistry.get(chatTabPersistenceTabKey(identity));
  if (store === undefined) return;
  const state = store.getState();
  durableA2AOpenCache.set(identity, {
    sentOpenIds: state.sentOpenIds,
    receivedOpenIds: state.receivedOpenIds,
  });
}

/** Drops the durable chat-key entry - called when the CHAT itself is
 *  deleted, not on an ordinary tab close. */
export function evictA2AOpenStoreForChat(
  identity: Pick<ChatTabPersistenceIdentity, "epicId" | "chatId">,
): void {
  durableA2AOpenCache.deleteChat(identity);
}

/** Drops every durable chat-key entry belonging to a deleted/access-lost
 *  epic. */
export function evictA2AOpenStoresForEpic(epicId: string): void {
  durableA2AOpenCache.deleteEpic(epicId);
}

export const A2AOpenStoreContext = createContext<StoreApi<A2AOpenState> | null>(
  null,
);

function useA2AOpenStoreFromContext(): StoreApi<A2AOpenState> {
  const store = use(A2AOpenStoreContext);
  if (store === null) {
    throw new Error("A2A open store hook used outside A2AOpenStoreProvider");
  }
  return store;
}

export function useA2ASendOpen(segmentId: string): boolean {
  const store = useA2AOpenStoreFromContext();
  return useStore(store, (state) => state.sentOpenIds.has(segmentId));
}

export function useSetA2ASendOpen(): (
  segmentId: string,
  open: boolean,
) => void {
  const store = useA2AOpenStoreFromContext();
  return store.getState().setSentOpen;
}

export function useA2AReceivedOpen(messageId: string): boolean {
  const store = useA2AOpenStoreFromContext();
  return useStore(store, (state) => state.receivedOpenIds.has(messageId));
}

export function useSetA2AReceivedOpen(): (
  messageId: string,
  open: boolean,
) => void {
  const store = useA2AOpenStoreFromContext();
  return store.getState().setReceivedOpen;
}

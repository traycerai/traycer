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

// the SAME tile instance still fully remounts - evicted past its pane's chat retention
// cap, evicted with its owning top-level surface, or losing and regaining hosted eligibility.
const a2aOpenStoreRegistry = new Map<string, StoreApi<A2AOpenState>>();

// durable chat-key mirror of a tab-key store's open ids - survives the
// tab-key store being evicted on close, so a reopened chat's A2A cards start expanded again.
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
 * promotes this tab's CURRENT state to durable - called from the canvas close sweep for every
 * removed chat tile, BEFORE `evictA2AOpenStores` drops the registry entry.
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

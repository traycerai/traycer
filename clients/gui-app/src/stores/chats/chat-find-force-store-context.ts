import { createContext, use } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { ChatCollapsibleKey } from "@/components/chat/chat-collapsible-key";
import { serializeChatCollapsibleKey } from "@/components/chat/chat-collapsible-key";
import { updateOpenIds } from "@/stores/chats/open-id-set";

export interface ChatFindForceState {
  readonly forcedKeyIds: ReadonlySet<string>;
  readonly setForcedOpen: (key: ChatCollapsibleKey, open: boolean) => void;
}

export function createChatFindForceStore(): StoreApi<ChatFindForceState> {
  return createStore<ChatFindForceState>((set) => ({
    forcedKeyIds: new Set<string>(),
    setForcedOpen: (key, open) =>
      set((state) => {
        const serializedKey = serializeChatCollapsibleKey(key);
        const forcedKeyIds = updateOpenIds(
          state.forcedKeyIds,
          serializedKey,
          open,
        );
        if (forcedKeyIds === state.forcedKeyIds) return state;
        return { forcedKeyIds };
      }),
  }));
}

export const ChatFindForceStoreContext =
  createContext<StoreApi<ChatFindForceState> | null>(null);

export const ChatFindForceTileInstanceIdContext = createContext<string | null>(
  null,
);

function useChatFindForceStoreFromContext(): StoreApi<ChatFindForceState> {
  const store = use(ChatFindForceStoreContext);
  if (store === null) {
    throw new Error(
      "chat find-force store hook used outside ChatFindForceStoreProvider",
    );
  }
  return store;
}

export function useChatCollapsibleTileInstanceId(): string {
  const tileInstanceId = use(ChatFindForceTileInstanceIdContext);
  if (tileInstanceId === null) {
    throw new Error(
      "chat collapsible key hook used outside ChatFindForceStoreProvider",
    );
  }
  return tileInstanceId;
}

export function useChatFindForcedOpen(key: ChatCollapsibleKey): boolean {
  const store = useChatFindForceStoreFromContext();
  const serializedKey = serializeChatCollapsibleKey(key);
  return useStore(store, (state) => state.forcedKeyIds.has(serializedKey));
}

export function useSetChatFindForcedOpen(): (
  key: ChatCollapsibleKey,
  open: boolean,
) => void {
  const store = useChatFindForceStoreFromContext();
  return store.getState().setForcedOpen;
}

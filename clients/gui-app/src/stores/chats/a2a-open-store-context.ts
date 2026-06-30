import { createContext, use } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { updateOpenIds } from "@/stores/chats/open-id-set";

export interface A2AOpenState {
  readonly sentOpenIds: ReadonlySet<string>;
  readonly receivedOpenIds: ReadonlySet<string>;
  readonly setSentOpen: (segmentId: string, open: boolean) => void;
  readonly setReceivedOpen: (messageId: string, open: boolean) => void;
}

export function createA2AOpenStore(): StoreApi<A2AOpenState> {
  return createStore<A2AOpenState>((set) => ({
    sentOpenIds: new Set<string>(),
    receivedOpenIds: new Set<string>(),
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

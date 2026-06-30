import { createContext, use } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { updateOpenIds } from "@/stores/chats/open-id-set";

export interface SubagentOpenState {
  readonly openIds: ReadonlySet<string>;
  readonly setOpen: (segmentId: string, open: boolean) => void;
}

function createSubagentOpenStore(): StoreApi<SubagentOpenState> {
  return createStore<SubagentOpenState>((set) => ({
    openIds: new Set<string>(),
    setOpen: (segmentId, open) =>
      set((state) => {
        const openIds = updateOpenIds(state.openIds, segmentId, open);
        if (openIds === state.openIds) return state;
        return { openIds };
      }),
  }));
}

export const SubagentOpenStoreContext =
  createContext<StoreApi<SubagentOpenState> | null>(null);

export function createSubagentOpenStoreForProvider(): StoreApi<SubagentOpenState> {
  return createSubagentOpenStore();
}

function useSubagentOpenStoreFromContext(): StoreApi<SubagentOpenState> {
  const store = use(SubagentOpenStoreContext);
  if (store === null) {
    throw new Error(
      "subagent-open store hook used outside SubagentOpenStoreProvider",
    );
  }
  return store;
}

export function useSubagentOpen(segmentId: string): boolean {
  const store = useSubagentOpenStoreFromContext();
  return useStore(store, (state) => state.openIds.has(segmentId));
}

export function useSetSubagentOpen(): (
  segmentId: string,
  open: boolean,
) => void {
  const store = useSubagentOpenStoreFromContext();
  return store.getState().setOpen;
}

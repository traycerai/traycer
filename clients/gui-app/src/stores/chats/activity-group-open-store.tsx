import { useState, type ReactNode } from "react";
import { createStore, type StoreApi } from "zustand/vanilla";
import { addWithFifoEviction } from "@/lib/bounded-set";
import {
  ActivityGroupOpenStoreContext,
  MAX_ACTIVITY_GROUP_OPEN_IDS,
  type ActivityGroupOpenState,
} from "./activity-group-open-store-context";

function createActivityGroupOpenStore(): StoreApi<ActivityGroupOpenState> {
  return createStore<ActivityGroupOpenState>((set) => ({
    openIds: new Set<string>(),
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

interface ActivityGroupOpenStoreProviderProps {
  readonly children: ReactNode;
}

export function ActivityGroupOpenStoreProvider(
  props: ActivityGroupOpenStoreProviderProps,
) {
  const [store] = useState(createActivityGroupOpenStore);
  return (
    <ActivityGroupOpenStoreContext.Provider value={store}>
      {props.children}
    </ActivityGroupOpenStoreContext.Provider>
  );
}

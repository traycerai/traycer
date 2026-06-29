import { useState, type ReactNode } from "react";
import type { StoreApi } from "zustand/vanilla";
import { ActivityGroupOpenStoreContext } from "./activity-group-open-store-context";
import type { ActivityGroupOpenState } from "./activity-group-open-store-context";
import { createActivityGroupOpenStore } from "./activity-group-open-store-core";

interface ActivityGroupOpenStoreProviderProps {
  readonly children: ReactNode;
  readonly store: StoreApi<ActivityGroupOpenState> | null;
}

export function ActivityGroupOpenStoreProvider(
  props: ActivityGroupOpenStoreProviderProps,
) {
  const [fallbackStore] = useState(createActivityGroupOpenStore);
  const store = props.store ?? fallbackStore;
  return (
    <ActivityGroupOpenStoreContext.Provider value={store}>
      {props.children}
    </ActivityGroupOpenStoreContext.Provider>
  );
}

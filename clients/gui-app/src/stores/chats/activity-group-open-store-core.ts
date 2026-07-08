import { createStore, type StoreApi } from "zustand/vanilla";
import { addWithFifoEviction } from "@/lib/bounded-set";
import {
  MAX_ACTIVITY_GROUP_OPEN_IDS,
  type ActivityGroupOpenState,
} from "./activity-group-open-store-context";

export function createActivityGroupOpenStore(): StoreApi<ActivityGroupOpenState> {
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

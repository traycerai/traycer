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

// Ticket 5: chat tiles fully remount per tab switch (decision #17). Retaining
// the same store instance across that remount (instead of always creating a
// fresh one) is what makes expanded activity groups survive it. Keyed by tile
// instance id, at module scope so it outlives the React tree; evicted only
// when a tab permanently closes (see the canvas store's tile-removal
// subscriber in `stores/epics/canvas/store.ts`), never on a mere remount.
const activityGroupOpenStoreRegistry = new Map<
  string,
  StoreApi<ActivityGroupOpenState>
>();

export function getOrCreateActivityGroupOpenStore(
  tileInstanceId: string,
): StoreApi<ActivityGroupOpenState> {
  const existing = activityGroupOpenStoreRegistry.get(tileInstanceId);
  if (existing !== undefined) return existing;
  const store = createActivityGroupOpenStore();
  activityGroupOpenStoreRegistry.set(tileInstanceId, store);
  return store;
}

export function evictActivityGroupOpenStores(
  tileInstanceIds: ReadonlyArray<string>,
): void {
  tileInstanceIds.forEach((id) => activityGroupOpenStoreRegistry.delete(id));
}

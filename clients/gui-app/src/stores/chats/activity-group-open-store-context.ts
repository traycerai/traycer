import { createContext, use } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

export interface ActivityGroupOpenState {
  readonly openIds: ReadonlySet<string>;
  readonly setOpen: (groupId: string, open: boolean) => void;
}

/**
 * Cap on remembered "expanded" activity group ids per chat-messages mount.
 * Default state is collapsed, so we only store explicit opens and drop the
 * entry when the user collapses again - this keeps the working set
 * proportional to "currently expanded", not "ever toggled". The FIFO cap
 * is belt-and-braces protection against a session that opens thousands of
 * groups without ever collapsing.
 */
export const MAX_ACTIVITY_GROUP_OPEN_IDS = 256;

export const ActivityGroupOpenStoreContext =
  createContext<StoreApi<ActivityGroupOpenState> | null>(null);

function useActivityGroupStoreFromContext(): StoreApi<ActivityGroupOpenState> {
  const store = use(ActivityGroupOpenStoreContext);
  if (store === null) {
    throw new Error(
      "activity-group-open store hook used outside ActivityGroupOpenStoreProvider",
    );
  }
  return store;
}

export function useActivityGroupOpen(groupId: string): boolean {
  const store = useActivityGroupStoreFromContext();
  return useStore(store, (state) => state.openIds.has(groupId));
}

export function useSetActivityGroupOpen(): (
  groupId: string,
  open: boolean,
) => void {
  const store = useActivityGroupStoreFromContext();
  return store.getState().setOpen;
}

import { createContext, use } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

export interface ActivityGroupOpenState {
  readonly openIds: ReadonlySet<string>;
  readonly setOpen: (groupId: string, open: boolean) => void;
  /** Groups that have RENDERED a nested reasoning header at least once. */
  readonly headedIds: ReadonlySet<string>;
  /** Records that these REASONING SEGMENTS showed a header of their own. */
  readonly markHeaded: (segmentIds: ReadonlyArray<string>) => void;
}

/** Cap on remembered "expanded" activity group ids per chat-messages mount. */
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

/**
 * `null` for a group with no sole reasoning block to ask about - the caller only has a question
 * when the headerless rule is in play, and passing a group id here would silently read the wrong
 */
export function useActivityGroupEverHeaded(segmentId: string | null): boolean {
  const store = useActivityGroupStoreFromContext();
  return useStore(
    store,
    (state) => segmentId !== null && state.headedIds.has(segmentId),
  );
}

export function useMarkActivityGroupHeaded(): (
  segmentIds: ReadonlyArray<string>,
) => void {
  const store = useActivityGroupStoreFromContext();
  return store.getState().markHeaded;
}

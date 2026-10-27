import { useMemo, useSyncExternalStore } from "react";
import {
  notifyManager,
  replaceEqualDeep,
  useQueryClient,
  type Mutation,
  type MutationCache,
  type MutationFilters,
} from "@tanstack/react-query";

function createMutationStateStore<TResult>(
  cache: MutationCache,
  filters: MutationFilters,
  select: (mutation: Mutation) => TResult,
) {
  const read = (): TResult[] => cache.findAll(filters).map(select);
  let result = read();
  return {
    getSnapshot: () => result,
    subscribe: (onStoreChange: () => void) => {
      const update = () => {
        const next = replaceEqualDeep(result, read());
        if (next !== result) {
          result = next;
          notifyManager.schedule(onStoreChange);
        }
      };
      const unsubscribe = cache.subscribe(update);
      // A mutation may have changed between rendering and subscribing.
      update();
      return unsubscribe;
    },
  };
}

/** Cache events and changed filters/selectors both answer for the current render. */
export function useMutationStateOf<TResult>(
  filters: MutationFilters,
  select: (mutation: Mutation) => TResult,
): TResult[] {
  const cache = useQueryClient().getMutationCache();
  const store = useMemo(
    () => createMutationStateStore(cache, filters, select),
    [cache, filters, select],
  );
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}

export function useIsMutatingOf(filters: MutationFilters): number {
  return useMutationStateOf({ ...filters, status: "pending" }, () => true)
    .length;
}

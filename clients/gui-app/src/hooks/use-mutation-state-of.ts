import { useMemo, useState, useSyncExternalStore } from "react";
import {
  hashKey,
  notifyManager,
  replaceEqualDeep,
  useQueryClient,
  type Mutation,
  type MutationCache,
  type MutationFilters,
} from "@tanstack/react-query";

interface MutationCacheSubscription {
  readonly getVersion: () => number;
  readonly subscribe: (onStoreChange: () => void) => () => void;
}

function createMutationCacheSubscription(
  cache: MutationCache,
): MutationCacheSubscription {
  let version = 0;
  return {
    getVersion: () => version,
    subscribe: (onStoreChange) => {
      const unsubscribe = cache.subscribe(() => {
        version += 1;
        notifyManager.schedule(onStoreChange);
      });
      // React rechecks after subscribing, including changes missed since render.
      version += 1;
      return unsubscribe;
    },
  };
}

function createMutationSnapshotGetter<TResult>(
  cache: MutationCache,
  subscription: MutationCacheSubscription,
  options: {
    readonly filters: MutationFilters;
    readonly select: (mutation: Mutation) => TResult;
    readonly baseline: TResult[];
  },
): () => TResult[] {
  let result = options.baseline;
  let lastVersion: number | undefined;
  return () => {
    const version = subscription.getVersion();
    if (lastVersion !== version) {
      result = replaceEqualDeep(
        result,
        cache.findAll(options.filters).map(options.select),
      );
      lastVersion = version;
    }
    return result;
  };
}

/** Cache events and changed filters/selectors both answer for the current render. */
export function useMutationStateOf<TResult>(
  filters: MutationFilters,
  select: (mutation: Mutation) => TResult,
): TResult[] {
  const cache = useQueryClient().getMutationCache();
  const subscription = useMemo(
    () => createMutationCacheSubscription(cache),
    [cache],
  );
  const plainFilters = {
    mutationKey: filters.mutationKey,
    status: filters.status,
    exact: filters.exact,
  };
  const filterKey = hashKey([plainFilters]);
  const [filterState, setFilterState] = useState({ filterKey, plainFilters });
  const filtersChanged = filterState.filterKey !== filterKey;
  const currentPlainFilters = filtersChanged
    ? plainFilters
    : filterState.plainFilters;
  if (filtersChanged) {
    setFilterState({ filterKey, plainFilters });
  }
  const predicate = filters.predicate;
  const currentFilters = useMemo(
    () => ({ ...currentPlainFilters, predicate }),
    [currentPlainFilters, predicate],
  );
  const [baseline, setBaseline] = useState<TResult[]>([]);
  // Each render owns its getter's memo. A suspended render with different
  // filters must not replace the committed render's snapshot.
  const getSnapshot = useMemo(
    () =>
      createMutationSnapshotGetter(cache, subscription, {
        filters: currentFilters,
        select,
        baseline,
      }),
    [cache, subscription, currentFilters, select, baseline],
  );
  const result = useSyncExternalStore(
    subscription.subscribe,
    getSnapshot,
    getSnapshot,
  );
  if (baseline !== result) {
    setBaseline(result);
  }
  return result;
}

/** Stable selector shared by readers of mutation inputs. */
export function selectMutationVariables(mutation: Mutation): unknown {
  return mutation.state.variables;
}

/** Stable selector for the context captured when a mutation starts. */
export function selectMutationContext(mutation: Mutation): unknown {
  return mutation.state.context;
}

const selectPendingMutation = (): boolean => true;

/** Counts matching pending mutations without invalidating selection on render. */
export function useIsMutatingOf(filters: MutationFilters): number {
  return useMutationStateOf(
    { ...filters, status: "pending" },
    selectPendingMutation,
  ).length;
}

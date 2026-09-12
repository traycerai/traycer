import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

export type ResourceSortOption = "memory" | "cpu" | "name" | "tab";

export function isResourceSortOption(
  value: string,
): value is ResourceSortOption {
  return (
    value === "memory" || value === "cpu" || value === "name" || value === "tab"
  );
}

interface ResourceMonitorStoreState {
  /**
   * How the panel's rows are ordered. Persisted because the popover unmounts
   * on every close, so an ordering held by the panel would last exactly one
   * viewing and be re-picked on every open.
   *
   * Not host-scoped — an ordering is a reading preference about the person, not
   * a fact about the machine being read.
   */
  readonly sortOption: ResourceSortOption;
  readonly setSortOption: (sortOption: ResourceSortOption) => void;
}

const RESOURCE_MONITOR_PERSIST_KEY = persistKey(STORE_KEYS.resourceMonitor);

const DEFAULT_SORT_OPTION: ResourceSortOption = "tab";

/**
 * An unrecognized value falls back to the default ordering rather than being
 * carried through: the sort key reaches comparators that switch on it
 * exhaustively, so it has to be one of the four this build knows.
 */
function persistedSortOption(persistedState: unknown): ResourceSortOption {
  if (typeof persistedState !== "object" || persistedState === null) {
    return DEFAULT_SORT_OPTION;
  }
  if (!("sortOption" in persistedState)) return DEFAULT_SORT_OPTION;
  const sortOption = persistedState.sortOption;
  if (typeof sortOption !== "string" || !isResourceSortOption(sortOption)) {
    return DEFAULT_SORT_OPTION;
  }
  return sortOption;
}

export const useResourceMonitorStore = create<ResourceMonitorStoreState>()(
  persist(
    (set, get) => ({
      sortOption: DEFAULT_SORT_OPTION,
      setSortOption: (sortOption) => {
        if (get().sortOption === sortOption) return;
        set({ sortOption });
      },
    }),
    {
      ...basePersistOptions(RESOURCE_MONITOR_PERSIST_KEY),
      storage: createJSONStorage(() => localStorage),
      merge: (persistedState, currentState) => ({
        ...currentState,
        sortOption: persistedSortOption(persistedState),
      }),
      partialize: (state) => ({
        sortOption: state.sortOption,
      }),
    },
  ),
);

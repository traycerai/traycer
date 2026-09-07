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
  /** Which host's processes the resource monitor is READING - never which host the window runs on. */
  readonly scopedHostId: string | null;
  /** `null` returns to following the active host. */
  readonly setScopedHostId: (hostId: string | null) => void;
  /** How the panel's rows are ordered. */
  readonly sortOption: ResourceSortOption;
  readonly setSortOption: (sortOption: ResourceSortOption) => void;
}

const RESOURCE_MONITOR_PERSIST_KEY = persistKey(STORE_KEYS.resourceMonitor);

/**
 * A host id is opaque to this layer, so the only checkable claim is "a non-empty string someone
 * could have picked".
 */
function persistedScopedHostId(persistedState: unknown): string | null {
  if (typeof persistedState !== "object" || persistedState === null) {
    return null;
  }
  if (!("scopedHostId" in persistedState)) return null;
  const scopedHostId = persistedState.scopedHostId;
  if (typeof scopedHostId !== "string" || scopedHostId.length === 0) {
    return null;
  }
  return scopedHostId;
}

const DEFAULT_SORT_OPTION: ResourceSortOption = "tab";

/**
 * An unrecognized value falls back to the default ordering rather than being carried through: the
 * sort key reaches comparators that switch on it exhaustively, so it has to be one of the four
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
      scopedHostId: null,
      setScopedHostId: (scopedHostId) => {
        if (get().scopedHostId === scopedHostId) return;
        set({ scopedHostId });
      },
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
        scopedHostId: persistedScopedHostId(persistedState),
        sortOption: persistedSortOption(persistedState),
      }),
      partialize: (state) => ({
        scopedHostId: state.scopedHostId,
        sortOption: state.sortOption,
      }),
    },
  ),
);

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
   * Which host's processes the resource monitor is READING — never which host
   * the window runs on. Picking here swaps the stream transport the popover's
   * `resources.subscribe` session is opened against and nothing else; where new
   * work lands is still `HostDirectoryService.selectById`'s answer alone.
   *
   * `null` means "follow the active host", which is not the same as "no host":
   * keeping the unset case distinct is what lets a single-host user never see a
   * stale id after their only host is re-registered.
   *
   * Persisted, on the same terms as the usage popover's pick
   * (`rate-limit-popover-store.ts`): this surface only WATCHES, so someone who
   * left it on one machine wants that machine on the next launch rather than a
   * pick they must redo every time. A pick that no longer resolves is still
   * never substituted silently — it surfaces as `vanished` / `unreachable`
   * with a way back to the active host.
   */
  readonly scopedHostId: string | null;
  /** `null` returns to following the active host. */
  readonly setScopedHostId: (hostId: string | null) => void;
  /**
   * How the panel's rows are ordered. Persisted for the same reason the host
   * pick is: the popover unmounts on every close, so an ordering held by the
   * panel would last exactly one viewing and be re-picked on every open.
   *
   * Not host-scoped — an ordering is a reading preference about the person, not
   * a fact about the machine being read.
   */
  readonly sortOption: ResourceSortOption;
  readonly setSortOption: (sortOption: ResourceSortOption) => void;
}

const RESOURCE_MONITOR_PERSIST_KEY = persistKey(STORE_KEYS.resourceMonitor);

/**
 * A host id is opaque to this layer, so the only checkable claim is "a
 * non-empty string someone could have picked". Whether it still names a host
 * this client can reach is `resolveScopedHost`'s question, answered against the
 * live host lists rather than guessed at rehydration time.
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

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

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

export const useResourceMonitorStore = create<ResourceMonitorStoreState>()(
  persist(
    (set, get) => ({
      scopedHostId: null,
      setScopedHostId: (scopedHostId) => {
        if (get().scopedHostId === scopedHostId) return;
        set({ scopedHostId });
      },
    }),
    {
      ...basePersistOptions(RESOURCE_MONITOR_PERSIST_KEY),
      storage: createJSONStorage(() => localStorage),
      merge: (persistedState, currentState) => ({
        ...currentState,
        scopedHostId: persistedScopedHostId(persistedState),
      }),
      partialize: (state) => ({ scopedHostId: state.scopedHostId }),
    },
  ),
);

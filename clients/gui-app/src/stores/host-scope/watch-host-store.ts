import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  basePersistOptions,
  persistKey,
  seedPersistedStateFromLegacyKeys,
  STORE_KEYS,
} from "@/lib/persist";

interface WatchHostStoreState {
  /**
   * Which host every usage/resource surface is READING — never which host the
   * window runs on. Picking here swaps a transient client and the stream
   * transport those surfaces are opened against, and nothing else; where new
   * work lands is still `HostDirectoryService.selectById`'s answer alone.
   *
   * `null` means "follow the active host", which is not the same as "no host":
   * keeping the unset case distinct is what lets a single-host user never see a
   * stale id after their only host is re-registered.
   *
   * Persisted, unlike the Settings viewing scope, because of what each scope
   * can do. Settings is an administration surface whose scope aims destructive
   * verbs, so a pick that outlived a relaunch would point them at a machine
   * last touched days ago. These surfaces only WATCH, and someone who watches
   * one machine's limits wants that same machine on the next launch rather than
   * a pick they must redo every time. A pick that no longer resolves is still
   * never substituted silently — it surfaces as `vanished` / `unreachable`
   * with a way back to the active host.
   *
   * ONE pick serves every watching surface. Only one of them is live at a time,
   * so separate picks per surface could disagree about the machine on screen
   * while nothing on screen explained the difference.
   */
  readonly scopedHostId: string | null;
  /** `null` returns to following the active host. */
  readonly setScopedHostId: (hostId: string | null) => void;
}

const WATCH_HOST_PERSIST_KEY = persistKey(STORE_KEYS.watchHost);

/**
 * The per-surface picks this store supersedes, in precedence order. Both
 * surfaces could be pointed at different machines before there was a single
 * pick, and one of them has to be adopted; the usage gauge is the one that is
 * always mounted in the header, so it is the pick the user has most recently
 * been looking at.
 */
const LEGACY_PICK_KEYS: ReadonlyArray<string> = [
  persistKey(STORE_KEYS.rateLimitPopover),
  persistKey(STORE_KEYS.resourceMonitor),
];

/**
 * A host id is opaque to this layer, so the only checkable claim is "a
 * non-empty string someone could have picked". Whether it still names a host
 * this client can reach is `resolveScopedHost`'s question, answered against the
 * live host lists rather than guessed at rehydration time.
 */
function readScopedHostId(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value;
}

// Runs at module load, BEFORE `create` hydrates the store below: the seed has
// to be a record on disk by the time hydration reads one, or the adoption is
// not a migration at all — merge is not written back, so it would re-run every
// launch and a deliberate return to the active host could never stick. Both
// legacy records are left intact; only this one field of theirs moved.
seedPersistedStateFromLegacyKeys({
  name: WATCH_HOST_PERSIST_KEY,
  legacyNames: LEGACY_PICK_KEYS,
  seedFrom: (legacyState) => {
    const scopedHostId = readScopedHostId(legacyState.scopedHostId);
    return scopedHostId === null ? null : { scopedHostId };
  },
});

export const useWatchHostStore = create<WatchHostStoreState>()(
  persist(
    (set, get) => ({
      scopedHostId: null,
      setScopedHostId: (scopedHostId) => {
        if (get().scopedHostId === scopedHostId) return;
        set({ scopedHostId });
      },
    }),
    {
      ...basePersistOptions(WATCH_HOST_PERSIST_KEY),
      storage: createJSONStorage(() => localStorage),
      merge: (persistedState, currentState) => ({
        ...currentState,
        scopedHostId:
          persistedState !== null &&
          typeof persistedState === "object" &&
          "scopedHostId" in persistedState
            ? readScopedHostId(persistedState.scopedHostId)
            : null,
      }),
      partialize: (state) => ({ scopedHostId: state.scopedHostId }),
    },
  ),
);

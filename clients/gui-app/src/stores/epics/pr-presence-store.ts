import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

/**
 * Whether a given `(hostId, epicId)` is known to have at least one PR - the
 * only signal the rail needs to decide whether the Pull Requests panel earns a
 * slot (`isAutoVisible`).
 *
 * Deliberately NOT fed by an epic-open sweep. Opening an epic costs zero PR
 * traffic; this is written only when the PR panel is actually open and its
 * stream delivers a list frame, and it is persisted so the SECOND and later
 * opens of the same epic show the icon immediately, with no fetch and no
 * flicker while a frame is in flight.
 *
 * The consequence is deliberate and bounded: an epic whose PR panel has never
 * been opened on this machine shows no PR icon until the user reveals the
 * panel once from the rail context menu ("No PRs yet"). That is the cost of
 * keeping the epic-open path free of GitHub work.
 *
 * Scoped per `(hostId, epicId)` so presence never leaks across machines.
 */
export interface PrPresenceStore {
  readonly hasItemsByScopeKey: Readonly<Record<string, boolean>>;
  /**
   * Record what the newest list frame observed. Takes the WHOLE list's
   * emptiness, not "saw a PR", so a PR that stops being derived from the epic
   * flips presence back off rather than pinning the icon on forever.
   */
  readonly recordPrPresence: (
    hostId: string,
    epicId: string,
    hasItems: boolean,
  ) => void;
}

export const PR_PRESENCE_PERSIST_KEY = persistKey(STORE_KEYS.prPresence);

export function prPresenceScopeKey(hostId: string, epicId: string): string {
  // NUL separator: it cannot occur in either id, so no two distinct
  // (hostId, epicId) pairs can collide onto one scope key.
  return `${hostId}\u0000${epicId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function migratePrPresencePersistedState(persisted: unknown): {
  readonly hasItemsByScopeKey: Record<string, boolean>;
} {
  if (!isRecord(persisted) || !isRecord(persisted.hasItemsByScopeKey)) {
    return { hasItemsByScopeKey: {} };
  }
  const hasItemsByScopeKey: Record<string, boolean> = {};
  for (const [scopeKey, value] of Object.entries(
    persisted.hasItemsByScopeKey,
  )) {
    // Only a literal `true` survives: anything else (a stale shape, a null, a
    // truthy non-boolean) reads as "not known to have PRs", which is the safe
    // default - it hides an icon rather than showing an empty panel.
    if (value === true) hasItemsByScopeKey[scopeKey] = true;
  }
  return { hasItemsByScopeKey };
}

export const usePrPresenceStore = create<PrPresenceStore>()(
  persist(
    (set) => ({
      hasItemsByScopeKey: {},

      recordPrPresence: (hostId, epicId, hasItems) => {
        const scopeKey = prPresenceScopeKey(hostId, epicId);
        set((state) => {
          const current = state.hasItemsByScopeKey[scopeKey] ?? false;
          // Identity-stable no-op on an unchanged frame. The panel re-emits on
          // every poll tick, and returning a fresh object each time would
          // re-render every rail consumer once a minute for nothing.
          if (current === hasItems) return state;
          return {
            hasItemsByScopeKey: {
              ...state.hasItemsByScopeKey,
              [scopeKey]: hasItems,
            },
          };
        });
      },
    }),
    {
      ...basePersistOptions(PR_PRESENCE_PERSIST_KEY),
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({
        hasItemsByScopeKey: state.hasItemsByScopeKey,
      }),
      migrate: (persisted) => migratePrPresencePersistedState(persisted),
      // `migrate` runs ONLY on a version mismatch, and `basePersistOptions`
      // already pins this store at the current version - so the ordinary
      // rehydrate path skips it entirely and zustand's default shallow merge
      // would adopt whatever shape `localStorage` holds, corruption included.
      // Sanitizing in `merge` puts the same guard on EVERY rehydration.
      // `migratePrPresencePersistedState` is idempotent, so the version-bump
      // path applying it twice is harmless.
      merge: (persisted, current) => ({
        ...current,
        ...migratePrPresencePersistedState(persisted),
      }),
    },
  ),
);

/**
 * Whether this `(hostId, epicId)` last observed at least one PR.
 *
 * Reading the persisted value rather than the live subscription is what keeps
 * the rail stable across a reload - the panel does not vanish and reappear
 * while the first frame is still in flight.
 */
export function selectPrScopeHasItems(hostId: string | null, epicId: string) {
  return (s: PrPresenceStore): boolean => {
    if (hostId === null) return false;
    return s.hasItemsByScopeKey[prPresenceScopeKey(hostId, epicId)] ?? false;
  };
}

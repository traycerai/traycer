import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { PrState } from "@traycer/protocol/host/pr-schemas";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

/** Which pull requests the panel lists: one wire state, or every row. */
export type PrStateFilter = PrState | "all";

/** Every filter, in the order the panel's menu offers them. */
export const PR_STATE_FILTERS: readonly PrStateFilter[] = [
  "open",
  "merged",
  "closed",
  "all",
];

const DEFAULT_PR_STATE_FILTER: PrStateFilter = "open";

/**
 * Pull Requests panel preferences. App-wide rather than per epic: "show me
 * only open work" is how a person reads the panel, not a fact about one epic.
 */
export interface PrPanelStore {
  readonly stateFilter: PrStateFilter;
  readonly setStateFilter: (stateFilter: PrStateFilter) => void;
}

export const PR_PANEL_PERSIST_KEY = persistKey(STORE_KEYS.prPanel);
/** v2 replaces v1's `openOnly` boolean - see `migrateOpenOnly`. */
const PR_PANEL_PERSIST_VERSION = 2;

interface PrPanelPersistedState {
  readonly stateFilter: PrStateFilter;
}

function coercePrPanelPersistedState(
  persisted: unknown,
): PrPanelPersistedState {
  if (
    typeof persisted !== "object" ||
    persisted === null ||
    !("stateFilter" in persisted)
  ) {
    return { stateFilter: DEFAULT_PR_STATE_FILTER };
  }
  const stored = persisted.stateFilter;
  return {
    stateFilter:
      PR_STATE_FILTERS.find((filter) => filter === stored) ??
      DEFAULT_PR_STATE_FILTER,
  };
}

/**
 * A v1 blob kept `openOnly`: on hid merged and closed rows, off listed every
 * state, so each becomes the filter that lists the same rows.
 */
function migrateOpenOnly(persisted: unknown): PrPanelPersistedState {
  const openOnly =
    typeof persisted === "object" &&
    persisted !== null &&
    "openOnly" in persisted
      ? persisted.openOnly
      : undefined;
  if (openOnly === true) return { stateFilter: "open" };
  if (openOnly === false) return { stateFilter: "all" };
  return { stateFilter: DEFAULT_PR_STATE_FILTER };
}

export const usePrPanelStore = create<PrPanelStore>()(
  persist(
    (set) => ({
      stateFilter: DEFAULT_PR_STATE_FILTER,
      setStateFilter: (stateFilter) => {
        set((state) =>
          state.stateFilter === stateFilter ? state : { stateFilter },
        );
      },
    }),
    {
      ...basePersistOptions(PR_PANEL_PERSIST_KEY),
      version: PR_PANEL_PERSIST_VERSION,
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state): PrPanelPersistedState => ({
        stateFilter: state.stateFilter,
      }),
      // Runs once per older blob; the result is written back at v2.
      migrate: (persisted, version) =>
        version < PR_PANEL_PERSIST_VERSION
          ? migrateOpenOnly(persisted)
          : coercePrPanelPersistedState(persisted),
      // A blob at the current version skips `migrate`, so a hand-edited or
      // corrupted value is coerced here too rather than trusted.
      merge: (persisted, current) => ({
        ...current,
        ...coercePrPanelPersistedState(persisted),
      }),
    },
  ),
);

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

/**
 * Pull Requests panel preferences. App-wide rather than per epic: "show me
 * only open work" is how a person reads the panel, not a fact about one epic.
 */
export interface PrPanelStore {
  /** Hide merged and closed pull requests. */
  readonly openOnly: boolean;
  readonly setOpenOnly: (openOnly: boolean) => void;
  readonly toggleOpenOnly: () => void;
}

export const PR_PANEL_PERSIST_KEY = persistKey(STORE_KEYS.prPanel);

interface PrPanelPersistedState {
  readonly openOnly: boolean;
}

export function migratePrPanelPersistedState(
  persisted: unknown,
): PrPanelPersistedState {
  if (typeof persisted !== "object" || persisted === null) {
    return { openOnly: false };
  }
  const openOnly = "openOnly" in persisted ? persisted.openOnly : undefined;
  return { openOnly: typeof openOnly === "boolean" ? openOnly : false };
}

export const usePrPanelStore = create<PrPanelStore>()(
  persist(
    (set) => ({
      openOnly: false,
      setOpenOnly: (openOnly) => {
        set((state) => (state.openOnly === openOnly ? state : { openOnly }));
      },
      toggleOpenOnly: () => {
        set((state) => ({ openOnly: !state.openOnly }));
      },
    }),
    {
      ...basePersistOptions(PR_PANEL_PERSIST_KEY),
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state): PrPanelPersistedState => ({
        openOnly: state.openOnly,
      }),
      migrate: (persisted) => migratePrPanelPersistedState(persisted),
      // A blob at the current version skips `migrate`, so a hand-edited or
      // corrupted value is coerced here too rather than trusted.
      merge: (persisted, current) => ({
        ...current,
        ...migratePrPanelPersistedState(persisted),
      }),
    },
  ),
);

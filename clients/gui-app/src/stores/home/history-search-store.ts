import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import {
  DEFAULT_HISTORY_SEARCH,
  normalizePersistedHistorySearch,
  patchHistorySearch,
  type HistorySearchPatch,
  type HistorySearchState,
} from "@/lib/history-search";

/**
 * Search / filter / sort state for the *ambient* history surfaces - the history modal overlay and
 * the home page's embedded recent-epics list.
 */
interface HistorySearchStoreState {
  readonly search: HistorySearchState;
  readonly update: (patch: HistorySearchPatch) => void;
  readonly clear: () => void;
}

const HISTORY_SEARCH_PERSIST_KEY = persistKey(STORE_KEYS.historySearch);

export const useHistorySearchStore = create<HistorySearchStoreState>()(
  persist(
    (set, get) => ({
      search: DEFAULT_HISTORY_SEARCH,
      update: (patch) => {
        set({ search: patchHistorySearch(get().search, patch) });
      },
      clear: () => {
        if (get().search === DEFAULT_HISTORY_SEARCH) return;
        set({ search: DEFAULT_HISTORY_SEARCH });
      },
    }),
    {
      ...basePersistOptions(HISTORY_SEARCH_PERSIST_KEY),
      storage: createJSONStorage(() => localStorage),
      // Persist only the data; the actions come from the initializer on rehydrate.
      partialize: (state) => ({ search: state.search }),
      // The default shallow merge takes the persisted `search` verbatim, so a value written before a
      // `HistorySearchState` field existed rehydrates without it and every `.length` read on the new
      merge: (persistedState, currentState) => ({
        ...currentState,
        search: normalizePersistedHistorySearch(
          isRecord(persistedState) ? persistedState.search : undefined,
        ),
      }),
    },
  ),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

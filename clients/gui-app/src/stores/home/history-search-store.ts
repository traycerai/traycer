import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import {
  DEFAULT_HISTORY_SEARCH,
  patchHistorySearch,
  type HistorySearchPatch,
  type HistorySearchState,
} from "@/lib/history-search";

/**
 * Search / filter / sort state for the *ambient* history surfaces - the
 * history modal overlay and the home page's embedded recent-epics list.
 *
 * These surfaces are rendered as root-level siblings of the page content, so
 * routing their high-frequency search/filter through the URL (as the `/epics`
 * strip-tab route legitimately does) lands it on the **root route's** search
 * params - and re-renders the entire shell (the page behind the modal) on every
 * keystroke. Owning the state here instead keeps interaction scoped to the list,
 * while `persist` preserves "restore where I left off" across a refresh.
 *
 * The `/epics` route is unaffected: it keeps the URL as its source of truth
 * (deep-linkable + loader-prefetched) - see `useRouteHistorySearchState`.
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
    },
  ),
);

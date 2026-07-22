import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  WORKTREE_TIER_ORDER,
  type WorktreeTier,
} from "@traycer-clients/shared/worktree/classify-worktree";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

export type WorktreeSortMode = "newest" | "oldest";

interface WorktreesSettingsViewStoreState {
  readonly searchText: string;
  readonly sortMode: WorktreeSortMode;
  readonly tierFilters: readonly WorktreeTier[];
  readonly setSearchText: (searchText: string) => void;
  readonly setSortMode: (sortMode: WorktreeSortMode) => void;
  readonly toggleTierFilter: (tier: WorktreeTier) => void;
  readonly clearTierFilters: () => void;
}

export const DEFAULT_WORKTREE_SORT_MODE: WorktreeSortMode = "newest";
export const EMPTY_WORKTREE_TIER_FILTERS: readonly WorktreeTier[] =
  Object.freeze([]);

const WORKTREES_SETTINGS_VIEW_PERSIST_KEY = persistKey(
  STORE_KEYS.worktreesSettingsView,
);

function persistedField(
  persistedState: unknown,
  field: "searchText" | "sortMode" | "tierFilters",
): unknown {
  if (typeof persistedState !== "object" || persistedState === null) {
    return undefined;
  }
  if (field === "searchText") {
    return "searchText" in persistedState
      ? persistedState.searchText
      : undefined;
  }
  if (field === "sortMode") {
    return "sortMode" in persistedState ? persistedState.sortMode : undefined;
  }
  return "tierFilters" in persistedState
    ? persistedState.tierFilters
    : undefined;
}

function persistedSearchText(persistedState: unknown): string {
  const searchText = persistedField(persistedState, "searchText");
  return typeof searchText === "string" ? searchText : "";
}

function persistedSortMode(persistedState: unknown): WorktreeSortMode {
  const sortMode = persistedField(persistedState, "sortMode");
  return sortMode === "oldest" ? "oldest" : DEFAULT_WORKTREE_SORT_MODE;
}

function persistedTierFilters(
  persistedState: unknown,
): readonly WorktreeTier[] {
  const tierFilters = persistedField(persistedState, "tierFilters");
  if (!Array.isArray(tierFilters)) return EMPTY_WORKTREE_TIER_FILTERS;
  const restored = WORKTREE_TIER_ORDER.filter((tier) =>
    tierFilters.includes(tier),
  );
  return restored.length === 0 ? EMPTY_WORKTREE_TIER_FILTERS : restored;
}

export const useWorktreesSettingsViewStore =
  create<WorktreesSettingsViewStoreState>()(
    persist(
      (set, get) => ({
        searchText: "",
        sortMode: DEFAULT_WORKTREE_SORT_MODE,
        tierFilters: EMPTY_WORKTREE_TIER_FILTERS,
        setSearchText: (searchText) => {
          if (get().searchText === searchText) return;
          set({ searchText });
        },
        setSortMode: (sortMode) => {
          if (get().sortMode === sortMode) return;
          set({ sortMode });
        },
        toggleTierFilter: (tier) => {
          const current = get().tierFilters;
          set({
            tierFilters: current.includes(tier)
              ? current.filter((entry) => entry !== tier)
              : [...current, tier],
          });
        },
        clearTierFilters: () => {
          if (get().tierFilters.length === 0) return;
          set({ tierFilters: EMPTY_WORKTREE_TIER_FILTERS });
        },
      }),
      {
        ...basePersistOptions(WORKTREES_SETTINGS_VIEW_PERSIST_KEY),
        storage: createJSONStorage(() => localStorage),
        merge: (persistedState, currentState) => ({
          ...currentState,
          searchText: persistedSearchText(persistedState),
          sortMode: persistedSortMode(persistedState),
          tierFilters: persistedTierFilters(persistedState),
        }),
        partialize: (state) => ({
          searchText: state.searchText,
          sortMode: state.sortMode,
          tierFilters: state.tierFilters,
        }),
      },
    ),
  );

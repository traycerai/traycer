import { create } from "zustand";
import type { HistoryItem } from "@/components/home/data/home-page.data";

/**
 * Last unfiltered history snapshot keyed by epicId. Written by
 * `useHistoryQuery` so display surfaces that cannot host-bind (header tabs)
 * still apply project-profile membership without calling host hooks.
 *
 * `hydrated` flips true on the first `setMembershipItems` call (including an
 * empty list). Profile launch landing waits on this flag — not map size —
 * so a brand-new profile with zero epics does not sit on a black `/` forever
 * while the cold empty Map is indistinguishable from "history not loaded".
 */
export interface HistoryMembershipCacheState {
  readonly itemsByEpicId: ReadonlyMap<string, HistoryItem>;
  /** True after the first membership snapshot from history has landed. */
  readonly hydrated: boolean;
  readonly setMembershipItems: (
    items: ReadonlyArray<HistoryItem>,
  ) => void;
  readonly resetForTests: () => void;
}

export const useHistoryMembershipCacheStore =
  create<HistoryMembershipCacheState>()((set) => ({
    itemsByEpicId: new Map(),
    hydrated: false,
    setMembershipItems: (items) => {
      const next = new Map<string, HistoryItem>();
      for (const item of items) {
        next.set(item.epicId, item);
      }
      set({ itemsByEpicId: next, hydrated: true });
    },
    resetForTests: () => {
      set({ itemsByEpicId: new Map(), hydrated: false });
    },
  }));

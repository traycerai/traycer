import { create } from "zustand";
import type { HistoryItem } from "@/components/home/data/home-page.data";

/**
 * Last unfiltered history snapshot keyed by epicId. Written by
 * `useHistoryQuery` so display surfaces that cannot host-bind (header tabs)
 * still apply project-profile membership without calling host hooks.
 */
export interface HistoryMembershipCacheState {
  readonly itemsByEpicId: ReadonlyMap<string, HistoryItem>;
  readonly setMembershipItems: (
    items: ReadonlyArray<HistoryItem>,
  ) => void;
  readonly resetForTests: () => void;
}

export const useHistoryMembershipCacheStore =
  create<HistoryMembershipCacheState>()((set) => ({
    itemsByEpicId: new Map(),
    setMembershipItems: (items) => {
      const next = new Map<string, HistoryItem>();
      for (const item of items) {
        next.set(item.epicId, item);
      }
      set({ itemsByEpicId: next });
    },
    resetForTests: () => {
      set({ itemsByEpicId: new Map() });
    },
  }));

import { create } from "zustand";

/**
 * Every currently-mounted horizontal rail's own unclamped content width (its
 * `scrollWidth`), keyed by the tab it belongs to.
 *
 * The sidebar's width (`left-panel-store.ts`'s `sidebarWidthPx`) is ONE value
 * shared by every open tab, so no single tab's icon count can be baked into a
 * static floor - a task with a stacked pull-requests panel needs more room on
 * its rail than one without, and the same width has to cover whichever tab is
 * actually showing. Ephemeral and unpersisted on purpose: this describes what
 * is on screen right now, not a user preference.
 */
interface SidebarRailWidthStore {
  readonly naturalWidthPxByTabId: Readonly<Record<string, number>>;
  readonly setRailNaturalWidthPx: (tabId: string, widthPx: number) => void;
  readonly clearRailNaturalWidthPx: (tabId: string) => void;
}

export const useSidebarRailWidthStore = create<SidebarRailWidthStore>()(
  (set) => ({
    naturalWidthPxByTabId: {},
    setRailNaturalWidthPx: (tabId, widthPx) => {
      set((state) => {
        if (state.naturalWidthPxByTabId[tabId] === widthPx) return state;
        return {
          naturalWidthPxByTabId: {
            ...state.naturalWidthPxByTabId,
            [tabId]: widthPx,
          },
        };
      });
    },
    clearRailNaturalWidthPx: (tabId) => {
      set((state) => {
        if (!Object.hasOwn(state.naturalWidthPxByTabId, tabId)) return state;
        const next = { ...state.naturalWidthPxByTabId };
        delete next[tabId];
        return { naturalWidthPxByTabId: next };
      });
    },
  }),
);

function maxOf(
  naturalWidthPxByTabId: Readonly<Record<string, number>>,
): number {
  return Object.values(naturalWidthPxByTabId).reduce(
    (max, width) => Math.max(max, width),
    0,
  );
}

/** The widest currently-mounted rail, reactively - `0` while none is mounted. */
export function useMaxRailNaturalWidthPx(): number {
  return useSidebarRailWidthStore((state) =>
    maxOf(state.naturalWidthPxByTabId),
  );
}

/** The same reading, for a store action that cannot call a hook. */
export function currentMaxRailNaturalWidthPx(): number {
  return maxOf(useSidebarRailWidthStore.getState().naturalWidthPxByTabId);
}

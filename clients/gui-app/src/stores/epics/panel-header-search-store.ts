/**
 * Ephemeral per-tab, per-panel "header search" state for the Epic left sidebar.
 *
 * A panel that opts in (`supportsHeaderSearch`) trades its whole header row -
 * chevron, icon, title, actions - for a search input while searching, instead
 * of stacking a permanently-visible box underneath it. That keeps the resting
 * panel one row taller and stops a rarely-used mode from carrying constant
 * visual weight.
 *
 * State lives here rather than in `left-panel-store` because none of it should
 * persist: reopening the app should land you in browse mode, never in a
 * half-typed search. Each retained top-level tab owns a distinct open flag,
 * query, and live portal target, so a hidden Epic can never steal or clear the
 * visible Epic's header. The owning search component can still keep its input,
 * results, refs, and combobox ARIA wiring in ONE component while the input's DOM
 * renders up in the header.
 */
import { create } from "zustand";
import type { LeftPanelId } from "@/stores/epics/left-panel-store";

type SurfaceRecord<T> = Readonly<Partial<Record<string, T>>>;

interface PanelHeaderSearchStore {
  readonly openBySurfaceKey: SurfaceRecord<boolean>;
  readonly queryBySurfaceKey: SurfaceRecord<string>;
  readonly slotBySurfaceKey: SurfaceRecord<HTMLElement>;

  /**
   * Enter search mode. `seed` is the character that triggered it for the
   * type-to-filter path (the keystroke would otherwise be swallowed by the
   * focus handoff), or "" when opened from the header icon.
   */
  readonly openSearch: (
    tabId: string,
    panelId: LeftPanelId,
    seed: string,
  ) => void;
  readonly closeSearch: (tabId: string, panelId: LeftPanelId) => void;
  readonly setSearchQuery: (
    tabId: string,
    panelId: LeftPanelId,
    query: string,
  ) => void;
  readonly registerSearchSlot: (
    tabId: string,
    panelId: LeftPanelId,
    element: HTMLElement,
  ) => void;
  readonly unregisterSearchSlot: (
    tabId: string,
    panelId: LeftPanelId,
    element: HTMLElement,
  ) => void;
}

function withoutKey<T>(
  record: SurfaceRecord<T>,
  key: string,
): SurfaceRecord<T> {
  if (!Object.hasOwn(record, key)) return record;
  const { [key]: _dropped, ...rest } = record;
  return rest;
}

/** One retained top-level Epic tab owns one independent header-search surface. */
export function panelHeaderSearchSurfaceKey(
  tabId: string,
  panelId: LeftPanelId,
): string {
  return JSON.stringify([tabId, panelId]);
}

export const usePanelHeaderSearchStore = create<PanelHeaderSearchStore>(
  (set) => ({
    openBySurfaceKey: {},
    queryBySurfaceKey: {},
    slotBySurfaceKey: {},

    openSearch: (tabId, panelId, seed) => {
      const key = panelHeaderSearchSurfaceKey(tabId, panelId);
      set((state) => ({
        openBySurfaceKey: { ...state.openBySurfaceKey, [key]: true },
        queryBySurfaceKey: { ...state.queryBySurfaceKey, [key]: seed },
      }));
    },

    closeSearch: (tabId, panelId) => {
      const key = panelHeaderSearchSurfaceKey(tabId, panelId);
      set((state) => ({
        openBySurfaceKey: withoutKey(state.openBySurfaceKey, key),
        queryBySurfaceKey: withoutKey(state.queryBySurfaceKey, key),
      }));
    },

    setSearchQuery: (tabId, panelId, query) => {
      const key = panelHeaderSearchSurfaceKey(tabId, panelId);
      set((state) => ({
        queryBySurfaceKey: { ...state.queryBySurfaceKey, [key]: query },
      }));
    },

    registerSearchSlot: (tabId, panelId, element) => {
      const key = panelHeaderSearchSurfaceKey(tabId, panelId);
      set((state) => ({
        slotBySurfaceKey: { ...state.slotBySurfaceKey, [key]: element },
      }));
    },

    unregisterSearchSlot: (tabId, panelId, element) => {
      const key = panelHeaderSearchSurfaceKey(tabId, panelId);
      set((state) => {
        if (state.slotBySurfaceKey[key] !== element) return state;
        return {
          slotBySurfaceKey: withoutKey(state.slotBySurfaceKey, key),
        };
      });
    },
  }),
);

export function usePanelHeaderSearchOpen(
  tabId: string,
  panelId: LeftPanelId,
): boolean {
  const key = panelHeaderSearchSurfaceKey(tabId, panelId);
  return usePanelHeaderSearchStore(
    (state) => state.openBySurfaceKey[key] === true,
  );
}

export function usePanelHeaderSearchQuery(
  tabId: string,
  panelId: LeftPanelId,
): string {
  const key = panelHeaderSearchSurfaceKey(tabId, panelId);
  return usePanelHeaderSearchStore(
    (state) => state.queryBySurfaceKey[key] ?? "",
  );
}

export function usePanelHeaderSearchSlot(
  tabId: string,
  panelId: LeftPanelId,
): HTMLElement | null {
  const key = panelHeaderSearchSurfaceKey(tabId, panelId);
  return usePanelHeaderSearchStore(
    (state) => state.slotBySurfaceKey[key] ?? null,
  );
}

/** Ephemeral per-tab, per-panel "header search" state for the Epic left sidebar. */
import { create } from "zustand";
import type { LeftPanelId } from "@/stores/epics/left-panel-store";

type SurfaceRecord<T> = Readonly<Partial<Record<string, T>>>;

interface PanelHeaderSearchStore {
  readonly openBySurfaceKey: SurfaceRecord<boolean>;
  readonly queryBySurfaceKey: SurfaceRecord<string>;
  readonly slotBySurfaceKey: SurfaceRecord<HTMLElement>;

  /** Enter search mode. */
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

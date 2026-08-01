import { create } from "zustand";
import type { LeftPanelId } from "@/stores/epics/left-panel-store";

export type PanelHeaderMenuId = "create" | "filter" | "more";

interface PanelHeaderMenuStore {
  readonly openBySurfaceKey: Readonly<Partial<Record<string, boolean>>>;
  readonly setMenuOpen: (
    tabId: string,
    panelId: LeftPanelId,
    menuId: PanelHeaderMenuId,
    open: boolean,
  ) => void;
}

function panelHeaderMenuSurfaceKey(
  tabId: string,
  panelId: LeftPanelId,
  menuId: PanelHeaderMenuId,
): string {
  return JSON.stringify([tabId, panelId, menuId]);
}

export const usePanelHeaderMenuStore = create<PanelHeaderMenuStore>((set) => ({
  openBySurfaceKey: {},
  setMenuOpen: (tabId, panelId, menuId, open) => {
    const key = panelHeaderMenuSurfaceKey(tabId, panelId, menuId);
    set((state) => {
      if (open) {
        return {
          openBySurfaceKey: { ...state.openBySurfaceKey, [key]: true },
        };
      }
      if (!Object.hasOwn(state.openBySurfaceKey, key)) return state;
      const { [key]: _dropped, ...openBySurfaceKey } = state.openBySurfaceKey;
      return { openBySurfaceKey };
    });
  },
}));

export function usePanelHeaderMenuOpen(
  tabId: string,
  panelId: LeftPanelId,
  menuId: PanelHeaderMenuId,
): boolean {
  const key = panelHeaderMenuSurfaceKey(tabId, panelId, menuId);
  return usePanelHeaderMenuStore(
    (state) => state.openBySurfaceKey[key] === true,
  );
}

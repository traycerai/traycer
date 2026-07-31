/**
 * Persisted width of the communication-graph detail panel.
 *
 * One px width shared by every comm-graph tile, the same bargain the epic
 * sidebar strikes (`left-panel-store`): the panel is one surface wherever it
 * appears, so its width is a user layout preference, not per-tile view
 * chrome. The resize handle additionally caps the live drag at half the tile
 * so the canvas always keeps space; the render-time `max-w-[50%]` mirrors it.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

/** Matches the shell's previous fixed cap (`max-w-sm`), so nothing moves for
 * a user who never drags. */
export const DEFAULT_COMM_GRAPH_PANEL_WIDTH_PX = 384;
export const MIN_COMM_GRAPH_PANEL_WIDTH_PX = 280;
export const MAX_COMM_GRAPH_PANEL_WIDTH_PX = 640;

export function clampCommGraphPanelWidthPx(widthPx: number): number {
  if (!Number.isFinite(widthPx)) return DEFAULT_COMM_GRAPH_PANEL_WIDTH_PX;
  return Math.min(
    MAX_COMM_GRAPH_PANEL_WIDTH_PX,
    Math.max(MIN_COMM_GRAPH_PANEL_WIDTH_PX, Math.round(widthPx)),
  );
}

interface CommGraphPanelStore {
  readonly panelWidthPx: number;
  readonly setPanelWidthPx: (widthPx: number) => void;
}

const PERSIST_KEY = persistKey(STORE_KEYS.commGraphPanel);

export const useCommGraphPanelStore = create<CommGraphPanelStore>()(
  persist(
    (set) => ({
      panelWidthPx: DEFAULT_COMM_GRAPH_PANEL_WIDTH_PX,

      setPanelWidthPx: (widthPx) =>
        set((state) => {
          const next = clampCommGraphPanelWidthPx(widthPx);
          if (next === state.panelWidthPx) return state;
          return { panelWidthPx: next };
        }),
    }),
    {
      ...basePersistOptions(PERSIST_KEY),
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({ panelWidthPx: state.panelWidthPx }),
      merge: (persisted, current) => {
        const widthPx =
          typeof persisted === "object" &&
          persisted !== null &&
          "panelWidthPx" in persisted &&
          typeof persisted.panelWidthPx === "number"
            ? clampCommGraphPanelWidthPx(persisted.panelWidthPx)
            : current.panelWidthPx;
        return { ...current, panelWidthPx: widthPx };
      },
    },
  ),
);

export function useCommGraphPanelWidthPx(): number {
  return useCommGraphPanelStore((state) => state.panelWidthPx);
}

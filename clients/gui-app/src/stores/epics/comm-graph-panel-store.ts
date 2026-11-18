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

/** The persisted blob as something readable, without trusting a field of it. */
function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) return {};
  return { ...value };
}

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
  /**
   * Whether the office's directory panel is showing. One flag for every tile,
   * the same bargain the width above strikes: the directory is one surface
   * wherever it appears, so having it open is a layout preference rather than
   * per-tile view chrome.
   *
   * Open by default - a scaled office is unreadable without the list of who is
   * in it, and a person who does not want it closes it once.
   */
  readonly directoryOpen: boolean;
  readonly setDirectoryOpen: (open: boolean) => void;
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

      directoryOpen: true,

      setDirectoryOpen: (open) =>
        set((state) =>
          state.directoryOpen === open ? state : { directoryOpen: open },
        ),
    }),
    {
      ...basePersistOptions(PERSIST_KEY),
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({
        panelWidthPx: state.panelWidthPx,
        directoryOpen: state.directoryOpen,
      }),
      merge: (persisted, current) => {
        const stored = asRecord(persisted);
        const widthPx = stored.panelWidthPx;
        const directoryOpen = stored.directoryOpen;
        return {
          ...current,
          panelWidthPx:
            typeof widthPx === "number"
              ? clampCommGraphPanelWidthPx(widthPx)
              : current.panelWidthPx,
          // A non-boolean cannot be believed either way round, and "the
          // directory is missing and I cannot get it back" is the worse of the
          // two failures - so anything unreadable opens it.
          directoryOpen:
            typeof directoryOpen === "boolean"
              ? directoryOpen
              : current.directoryOpen,
        };
      },
    },
  ),
);

export function useCommGraphPanelWidthPx(): number {
  return useCommGraphPanelStore((state) => state.panelWidthPx);
}

export function useCommGraphDirectoryOpen(): boolean {
  return useCommGraphPanelStore((state) => state.directoryOpen);
}

/**
 * Persisted width of the artifact version history panel.
 *
 * One px width shared by every artifact tile, the same bargain the
 * comm-graph detail panel strikes (`comm-graph-panel-store`): the panel is
 * one surface wherever it appears, so its width is a user layout preference,
 * not per-tile view chrome. The resize handle additionally caps the live
 * drag at 70% of the tile so the artifact body always keeps space; the
 * render-time `max-w-[70%]` mirrors it. The maximize toggle is deliberately
 * NOT persisted — it is a transient reading mode, not a layout preference.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

/** Wide enough for the list + a word-wrapped markdown diff side by side. */
export const DEFAULT_ARTIFACT_VERSION_HISTORY_PANEL_WIDTH_PX = 560;
export const MIN_ARTIFACT_VERSION_HISTORY_PANEL_WIDTH_PX = 400;
export const MAX_ARTIFACT_VERSION_HISTORY_PANEL_WIDTH_PX = 960;

export function clampArtifactVersionHistoryPanelWidthPx(
  widthPx: number,
): number {
  if (!Number.isFinite(widthPx)) {
    return DEFAULT_ARTIFACT_VERSION_HISTORY_PANEL_WIDTH_PX;
  }
  return Math.min(
    MAX_ARTIFACT_VERSION_HISTORY_PANEL_WIDTH_PX,
    Math.max(MIN_ARTIFACT_VERSION_HISTORY_PANEL_WIDTH_PX, Math.round(widthPx)),
  );
}

interface ArtifactVersionHistoryPanelStore {
  readonly panelWidthPx: number;
  readonly setPanelWidthPx: (widthPx: number) => void;
}

const PERSIST_KEY = persistKey(STORE_KEYS.artifactVersionHistoryPanel);

export const useArtifactVersionHistoryPanelStore =
  create<ArtifactVersionHistoryPanelStore>()(
    persist(
      (set) => ({
        panelWidthPx: DEFAULT_ARTIFACT_VERSION_HISTORY_PANEL_WIDTH_PX,

        setPanelWidthPx: (widthPx) =>
          set((state) => {
            const next = clampArtifactVersionHistoryPanelWidthPx(widthPx);
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
              ? clampArtifactVersionHistoryPanelWidthPx(persisted.panelWidthPx)
              : current.panelWidthPx;
          return { ...current, panelWidthPx: widthPx };
        },
      },
    ),
  );

export function useArtifactVersionHistoryPanelWidthPx(): number {
  return useArtifactVersionHistoryPanelStore((state) => state.panelWidthPx);
}

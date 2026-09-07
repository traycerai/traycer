import { useTileFindStore } from "@/stores/tile-find";
import type { TileFindActiveOwner } from "@/stores/tile-find/types";

/** Pane-scoped key owner. Do not re-derive from isActive + paneFocused; that misses overlay blockers. */
export type ActiveTileOwner = TileFindActiveOwner;

export function getActiveTileOwner(): ActiveTileOwner | null {
  return useTileFindStore.getState().activeOwner;
}

/** True when a blocker holds keys while canvas tiles are still mounted; native select-all would sweep the hidden tiles. */
export function isCanvasCoveredByBlocker(): boolean {
  const state = useTileFindStore.getState();
  if (state.ownerBlocker === null) return false;
  return Object.keys(state.targetsByTileInstanceId).length > 0;
}

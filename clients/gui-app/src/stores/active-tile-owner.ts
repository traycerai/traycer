import { useTileFindStore } from "@/stores/tile-find";
import type { TileFindActiveOwner } from "@/stores/tile-find/types";

/**
 * The tile that owns pane-scoped global keys right now, or `null` when nothing
 * does.
 *
 * Ownership is NOT find-specific, even though it currently lives in the
 * tile-find store - find was simply its first consumer. Two inputs decide it,
 * and both are generic:
 *
 *  - every tile registers a target through `TileFindScope` with
 *    `isEligible: isActive && paneFocused`, so the owner is the active tile of
 *    the focused pane (most recent registration wins a tie);
 *  - `TileFindOwnerBridge` clears the owner outright while a command palette,
 *    system overlay, app/desktop/migration dialog, notification popover, native
 *    `<dialog>`, or non-canvas route holds global keys.
 *
 * Any feature answering "which tile does this keystroke belong to" must resolve
 * it HERE. Re-deriving from `isActive` + `usePaneFocused` in the feature looks
 * equivalent and is not: it cannot see that blocker policy, so it keeps claiming
 * keys underneath an open overlay.
 *
 * This module is the seam. If owner resolution is ever lifted out of the find
 * store into its own registry, this file changes and its consumers do not.
 */
export type ActiveTileOwner = TileFindActiveOwner;

export function getActiveTileOwner(): ActiveTileOwner | null {
  return useTileFindStore.getState().activeOwner;
}

/**
 * True when a blocker holds global keys while canvas tiles are still mounted
 * behind it.
 *
 * The distinction matters for any key whose browser default is destructive at
 * document scope. Under an open overlay there is no owner, but the canvas is
 * still in the document, so letting Chromium's document-wide select-all run
 * would sweep up the hidden tiles - the same defect as #592 wearing an overlay.
 * With no tiles registered (signed out, onboarding, an empty window) nothing of
 * ours is behind the overlay and the native default is the correct behavior.
 */
export function isCanvasCoveredByBlocker(): boolean {
  const state = useTileFindStore.getState();
  if (state.ownerBlocker === null) return false;
  return Object.keys(state.targetsByTileInstanceId).length > 0;
}

import { useTileFindStore } from "@/stores/tile-find";

// Canonical command surface for active-owner tile-find. Keyboard dispatch and
// the desktop menu both route through these functions so owner resolution,
// blocker policy, and replace-expansion live in one place instead of being
// re-implemented across `lib/keybindings/dispatch.ts` and the menu listener.

export function openActiveTileFind(): boolean {
  return useTileFindStore.getState().openActiveOwner();
}

export function advanceActiveTileFind(direction: 1 | -1): boolean {
  return useTileFindStore.getState().advanceActiveOwner(direction);
}

export function openActiveTileFindWithReplace(): boolean {
  const state = useTileFindStore.getState();
  const activeOwner = state.activeOwner;
  if (activeOwner === null) return false;
  if (!state.openForTile(activeOwner.tileInstanceId)) return false;
  state.setReplaceExpanded(activeOwner.tileInstanceId, true);
  return true;
}

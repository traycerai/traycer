import { getActiveTileOwner } from "@/stores/active-tile-owner";

// Canonical command surface for active-owner select-all, mirroring `lib/commands/tile-find.ts`: owner resolution and scope policy live here, not re-implemented at each call site.

/**
 * The opt-in a tile writes to declare what Ctrl/Cmd+A should select.
 * Put it on the tile's CONTENT root only - not the tile wrapper - so headers, toolbars and absolutely-positioned chrome (a chat composer overlay, an approval dock) stay out of the selection.
 */
const TILE_SELECTION_ROOT_ATTRIBUTE = "data-selection-root";

/** Confines select-all to the active tile's content. */
export function selectAllInActiveTile(): boolean {
  const owner = getActiveTileOwner();
  if (owner === null) return false;
  const root = findTileSelectionRoot(owner.tileInstanceId);
  if (root === null) return false;
  const selection = window.getSelection();
  if (selection === null) return false;
  const range = document.createRange();
  range.selectNodeContents(root);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/**
 * Matched by walking up from each declared root rather than by interpolating the instance id into a selector - tile instance ids are opaque strings, and an attribute-selector match would need escaping to stay correct for all of them.
 */
function findTileSelectionRoot(tileInstanceId: string): HTMLElement | null {
  const roots = document.querySelectorAll<HTMLElement>(
    `[${TILE_SELECTION_ROOT_ATTRIBUTE}]`,
  );
  for (const root of roots) {
    const owner = root.closest<HTMLElement>("[data-tile-instance-id]");
    if (owner !== null && owner.dataset.tileInstanceId === tileInstanceId) {
      return root;
    }
  }
  return null;
}

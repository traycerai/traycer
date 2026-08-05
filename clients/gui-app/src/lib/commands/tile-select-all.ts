import { getActiveTileOwner } from "@/stores/active-tile-owner";

// Canonical command surface for active-owner select-all, mirroring
// `lib/commands/tile-find.ts`: owner resolution and scope policy live here, not
// re-implemented at each call site.

/**
 * The opt-in a tile writes to declare what Ctrl/Cmd+A should select. Put it on
 * the tile's CONTENT root only - not the tile wrapper - so headers, toolbars and
 * absolutely-positioned chrome (a chat composer overlay, an approval dock) stay
 * out of the selection. First match inside the owning tile wins, so an outer
 * root shadows any nested one. A tile that declares none keeps the browser
 * default.
 */
const TILE_SELECTION_ROOT_ATTRIBUTE = "data-selection-root";

/**
 * Confines select-all to the active tile's content.
 *
 * Without this, Ctrl/Cmd+A outside a text field falls through to Chromium's
 * document-wide select-all, which sweeps up the sidebar, the tab strip and every
 * other tile (traycerai/traycer#592).
 *
 * Returns false when no tile owns the key or the owner declares no selection
 * root, so the caller can let the browser default through untouched - that is
 * what keeps select-all working normally on non-canvas routes and under an open
 * overlay.
 */
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
 * Matched by walking up from each declared root rather than by interpolating the
 * instance id into a selector - tile instance ids are opaque strings, and an
 * attribute-selector match would need escaping to stay correct for all of them.
 * Document order, so an outer root wins over a nested one.
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

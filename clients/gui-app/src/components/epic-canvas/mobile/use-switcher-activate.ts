import { useCallback } from "react";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

export type SwitcherActivate = (buildRef: () => EpicCanvasTileRef) => void;

/**
 * Shared row-tap handler for the switcher's flat lists.
 *
 * A tap is a single click, and that is exactly what the intent carries: the
 * resolver turns a `single` gesture into the destination pane's PREVIEW tile,
 * replacing whatever preview was there. That is what keeps a viewport showing
 * ONE tile at a time from accumulating tiles it never displays and offers no
 * way to close - these lists enumerate CONTENT, never open tiles, so a
 * permanently-opened tile whose content has no row is unreachable once
 * something else takes the screen.
 *
 * The already-open case needs no branch here: `dedupe` focuses the existing
 * tab in place and focusing an already-open tab never demotes it to preview,
 * so a kept tile stays kept and only the pane's activation moves. That dedupe
 * matches by REF - content id AND host - which is the only correct rule for
 * host-bound kinds, where two fleet items can share a content id across hosts
 * and "focus the one already open" must not hand back the other machine's
 * tile.
 *
 * Replacing is not destroying: an evicted preview's payload is preserved for
 * the back/forward history path, and a tile the user kept is never the one
 * evicted.
 *
 * The sheet closes either way, so the chosen tile becomes the full-screen
 * mobile tile.
 */
export function useSwitcherActivate(
  tabId: string,
  onClose: () => void,
): SwitcherActivate {
  const { openTile } = useEpicTileNavigation();

  return useCallback(
    (buildRef) => {
      openTile({
        node: buildRef(),
        target: { tabId },
        gesture: "single",
        modifiers: null,
        placement: null,
        dedupe: true,
        source: "direct_ui",
      });
      onClose();
    },
    [onClose, openTile, tabId],
  );
}

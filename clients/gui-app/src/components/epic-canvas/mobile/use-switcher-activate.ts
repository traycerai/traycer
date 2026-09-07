import { useCallback } from "react";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import { tileIntent } from "@/lib/canvas/tile-open/intent";

export type SwitcherActivate = (buildRef: () => EpicCanvasTileRef) => void;

/**
 * That is what keeps a viewport showing ONE tile at a time from accumulating tiles it never displays and offers no way to close - these lists enumerate CONTENT, never open tiles, so a permanently-opened tile whose content has no row is unreachable once something else takes the screen.
 * The already-open case needs no branch here: `dedupe` focuses the existing tab in place and focusing an already-open tab never demotes it to preview, so a kept tile stays kept and only the pane's activation moves.
 */
export function useSwitcherActivate(
  tabId: string,
  onClose: () => void,
): SwitcherActivate {
  const { openTile } = useEpicTileNavigation();

  return useCallback(
    (buildRef) => {
      openTile(tileIntent(buildRef(), { tabId }, "single", "direct_ui"));
      onClose();
    },
    [onClose, openTile, tabId],
  );
}

import { use, useCallback, useMemo } from "react";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";
import {
  MANUAL_TILE_OPEN,
  openTileWithNavigation,
} from "@/lib/canvas/tile-open/open-tile";
import { MobileTileOpenTargetContext } from "@/lib/canvas/tile-open/mobile-tile-open-target-context";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";

export interface EpicTileNavigation {
  /**
   * The one way a tile enters or is focused on a canvas (decision C1): the
   * intent plus the placement settings, the live canvas and the viewport go
   * through the pure resolver, and the resulting plan through the
   * nested-focus boundary. Returns the committed focus target, or `null` when
   * nothing was focused (a background open, a PiP, a no-op).
   */
  readonly openTile: (intent: TileOpenIntent) => NestedFocusTarget | null;
}

export function useEpicTileNavigation(): EpicTileNavigation {
  const navigateNested = useEpicNestedFocusNavigation();
  const mobileTarget = use(MobileTileOpenTargetContext);

  const openTile = useCallback(
    (intent: TileOpenIntent): NestedFocusTarget | null =>
      openTileWithNavigation(intent, navigateNested, {
        ...MANUAL_TILE_OPEN,
        mobileTarget,
      }),
    [mobileTarget, navigateNested],
  );

  return useMemo(() => ({ openTile }), [openTile]);
}

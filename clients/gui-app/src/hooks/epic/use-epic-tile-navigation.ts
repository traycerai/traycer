import { use, useCallback, useMemo } from "react";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";
import {
  MANUAL_TILE_OPEN,
  openTileWithNavigation,
} from "@/lib/canvas/tile-open/open-tile";
import { MobileTileOpenTargetContext } from "@/lib/canvas/tile-open/mobile-tile-open-target-context";
import type { NestedFocusProvenance } from "@/lib/epic-nested-focus-navigation";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";

export interface EpicTileNavigation {
  /**
   * The one way a tile enters or is focused on a canvas (decision C1): the
   * intent plus the placement settings, the live canvas and the viewport go
   * through the pure resolver, and the resulting plan through the
   * nested-focus boundary. Returns the committed focus target, or `null` when
   * nothing was focused (a background open, a PiP, a no-op).
   *
   * `provenance` is required, and this hook deliberately supplies no default.
   * It used to hand every open `MANUAL_TILE_OPEN`, which says `"user"`, and
   * most of its consumers are indeed a person clicking - but not all: a setup
   * binding registering its terminal tabs and a scripted `window.open`
   * arriving over the desktop IPC both open tiles with nobody asking, and both
   * inherited a human's authority from this one line. A commit that claims the
   * person acted retires an artifact request the route is still waiting on, so
   * the claim has to be made by whoever knows, not by the hook they share.
   *
   * Classify the CALLER, not the placement: a background open can be a
   * person's (open-in-background is a gesture) and a foreground one can be
   * automatic, so `mode: "background"` is not evidence either way.
   */
  readonly openTile: (
    intent: TileOpenIntent,
    provenance: NestedFocusProvenance,
  ) => NestedFocusTarget | null;
}

export function useEpicTileNavigation(): EpicTileNavigation {
  const navigateNested = useEpicNestedFocusNavigation();
  const mobileTarget = use(MobileTileOpenTargetContext);

  const openTile = useCallback(
    (
      intent: TileOpenIntent,
      provenance: NestedFocusProvenance,
    ): NestedFocusTarget | null =>
      openTileWithNavigation(intent, navigateNested, {
        ...MANUAL_TILE_OPEN,
        provenance,
        mobileTarget,
      }),
    [mobileTarget, navigateNested],
  );

  return useMemo(() => ({ openTile }), [openTile]);
}

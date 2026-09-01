import { useCallback, useMemo } from "react";
import {
  flattenMobileTiles,
  selectMobileTile,
  type MobileEpicTile,
} from "@/components/epic-canvas/mobile/mobile-tile-selection";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useEpicCanvas, useEpicCanvasStore } from "@/stores/epics/canvas/store";

export interface MobileEpicTilesApi {
  /** Every open tile across every pane, in tree order. */
  readonly tiles: ReadonlyArray<MobileEpicTile>;
  /** The instanceId of the tile currently shown full-screen, or null. */
  readonly currentInstanceId: string | null;
  /** Switch the shown tile to `{ paneId, instanceId }`. */
  readonly selectTile: (paneId: string, instanceId: string) => void;
}

/**
 * Tile-switch contract for the mobile epic view. The current-tile bar and
 * Phase 2's "Switch tab" bottom sheet both read `tiles` + `currentInstanceId`
 * and switch via `selectTile` from here, so there is one source of truth for
 * "which tiles exist and which is current".
 *
 * `currentInstanceId` is derived from the SAME {@link selectMobileTile} rule
 * that `MobileEpicTileView` renders, so the bar/sheet highlight always matches
 * the tile on screen.
 */
export function useMobileEpicTiles(tabId: string): MobileEpicTilesApi {
  const canvas = useEpicCanvas(tabId);
  const epicId = useEpicCanvasStore((s) => s.tabsById[tabId]?.epicId ?? null);
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareSetActiveTileTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareSetActiveTileTabFocusTarget,
  );

  const tiles = useMemo(() => flattenMobileTiles(canvas), [canvas]);
  const currentInstanceId = useMemo(
    () => selectMobileTile(canvas)?.ref.instanceId ?? null,
    [canvas],
  );

  const selectTile = useCallback(
    (paneId: string, instanceId: string) => {
      // Reuse desktop tab-selection exactly (same call TabGroupView makes):
      // `setActiveTab` sets the pane's active tab AND makes that pane the
      // globally-active one, and `navigateNested` commits the resulting focus
      // to the route. Accepted tradeoff (user-approved): this moves desktop's
      // active pane/tab too, so a tile picked on a phone is where the desktop
      // reopens ("resume where you left off"). It writes activation only - the
      // split-tree shape and `sizesByGroupId` are never touched, so the
      // persisted desktop layout is unchanged.
      const prepare = () =>
        prepareSetActiveTileTabFocusTarget(tabId, paneId, instanceId);
      if (epicId === null) {
        prepare();
        return;
      }
      navigateNested(epicId, tabId, prepare);
    },
    [epicId, navigateNested, prepareSetActiveTileTabFocusTarget, tabId],
  );

  return useMemo(
    () => ({ tiles, currentInstanceId, selectTile }),
    [tiles, currentInstanceId, selectTile],
  );
}

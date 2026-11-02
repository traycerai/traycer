import { collectPanes, findPaneById } from "@/stores/epics/canvas/tile-tree";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
  TilePane,
  TilesByInstanceId,
} from "@/stores/epics/canvas/types";

export interface MobileTileSelection {
  readonly paneId: string;
  readonly ref: EpicCanvasTileRef;
}

export interface MobileEpicTile {
  readonly paneId: string;
  readonly instanceId: string;
  readonly ref: EpicCanvasTileRef;
}

const EMPTY_TILES: ReadonlyArray<MobileEpicTile> = [];

/**
 * Every open tile across every pane, in tree order, as
 * `{ paneId, instanceId, ref }`. InstanceIds with no resolved payload are
 * skipped. Read-only - the Phase-2 "Switch tab" sheet and the current-tile bar
 * list from this.
 */
export function flattenMobileTiles(
  canvas: EpicCanvasState,
): ReadonlyArray<MobileEpicTile> {
  const { root, tilesByInstanceId } = canvas;
  if (root === null) return EMPTY_TILES;
  return collectPanes(root).flatMap((pane) =>
    pane.tabInstanceIds.flatMap((instanceId) => {
      const ref = tilesByInstanceId[instanceId];
      return ref === undefined ? [] : [{ paneId: pane.id, instanceId, ref }];
    }),
  );
}

/**
 * Deterministic "the one tile to show on mobile" rule. Read-only: it inspects
 * `activePaneId` / `root` / `tilesByInstanceId` and NEVER writes `root` or
 * `sizesByGroupId`, so viewing an epic on a phone leaves the persisted desktop
 * split layout untouched.
 *
 * Rule: the active pane's active tab, else the first pane's active tab, else
 * that pane's first tab instance. Panes are walked in tree order (active pane
 * first) and the first one that still resolves a live tile wins, so an emptied
 * active pane still yields a tile instead of a blank screen.
 */
export function selectMobileTile(
  canvas: EpicCanvasState,
): MobileTileSelection | null {
  const { root, activePaneId, tilesByInstanceId } = canvas;
  if (root === null) return null;
  const orderedPanes = collectPanes(root);
  const activePane =
    activePaneId === null ? null : findPaneById(root, activePaneId);
  const candidatePanes =
    activePane === null
      ? orderedPanes
      : [
          activePane,
          ...orderedPanes.filter((pane) => pane.id !== activePane.id),
        ];
  for (const pane of candidatePanes) {
    const instanceId = resolvePaneTileInstanceId(pane, tilesByInstanceId);
    if (instanceId === null) continue;
    const ref = tilesByInstanceId[instanceId];
    if (ref !== undefined) return { paneId: pane.id, ref };
  }
  return null;
}

function resolvePaneTileInstanceId(
  pane: TilePane,
  tiles: TilesByInstanceId,
): string | null {
  if (pane.activeTabId !== null && tiles[pane.activeTabId] !== undefined) {
    return pane.activeTabId;
  }
  return pane.tabInstanceIds.find((id) => tiles[id] !== undefined) ?? null;
}

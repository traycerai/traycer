/**
 * Neutral `EpicCanvasState` construction + invariant repair.
 *
 * Lives between `tile-tree.ts` (pure tree) and `actions.ts` (runtime
 * mutations) so the parse layer (`migrate-canvas.ts`) can rebuild state
 * without importing the action layer.
 */
import type { EpicCanvasState } from "./types";
import type { TileLayoutNode } from "./tile-tree";
import {
  collectPanes,
  findPaneById,
  firstPaneId,
  pruneSizes,
  replacePane,
} from "./tile-tree";
import { pruneActivationHistory } from "./activation-history";

export const EMPTY_CANVAS: EpicCanvasState = {
  root: null,
  activePaneId: null,
  tilesByInstanceId: {},
  sizesByGroupId: {},
};

export function createEmptyCanvas(): EpicCanvasState {
  return EMPTY_CANVAS;
}

type CanvasByTabId = Readonly<Record<string, EpicCanvasState | undefined>>;

/** Every tile `instanceId` currently mounted across all open canvases. */
export function collectLiveTileInstanceIds(
  canvasByTabId: CanvasByTabId,
): Set<string> {
  return new Set(
    Object.values(canvasByTabId)
      .filter((canvas): canvas is EpicCanvasState => canvas !== undefined)
      .flatMap((canvas) => Object.keys(canvas.tilesByInstanceId)),
  );
}

/** Whether `instanceId` is still a live tile in any open canvas. */
export function isTileInstanceLive(
  canvasByTabId: CanvasByTabId,
  instanceId: string,
): boolean {
  return Object.values(canvasByTabId).some(
    (canvas) =>
      canvas !== undefined &&
      canvas.tilesByInstanceId[instanceId] !== undefined,
  );
}

/**
 * Re-establish the tiles/tree invariant after parsing untrusted input:
 * drops payloads with no tree entry, drops tree tabs with no payload, and
 * prunes orphaned sizes. Used by the persistence layer, not by runtime
 * actions (which maintain the invariant incrementally).
 */
export function reconcileCanvasInvariants(
  state: EpicCanvasState,
): EpicCanvasState {
  if (state.root === null) {
    if (
      Object.keys(state.tilesByInstanceId).length === 0 &&
      Object.keys(state.sizesByGroupId).length === 0 &&
      state.activePaneId === null
    ) {
      return state;
    }
    return createEmptyCanvas();
  }

  let root: TileLayoutNode = state.root;
  for (const pane of collectPanes(state.root)) {
    const kept = pane.tabInstanceIds.filter((id) =>
      Object.hasOwn(state.tilesByInstanceId, id),
    );
    const activationHistory = pruneActivationHistory(
      pane.activationHistory,
      kept,
    );
    if (
      kept.length === pane.tabInstanceIds.length &&
      activationHistory.length === pane.activationHistory.length
    ) {
      continue;
    }
    root = replacePane(root, pane.id, (current) => ({
      ...current,
      tabInstanceIds: kept,
      activeTabId:
        current.activeTabId !== null && kept.includes(current.activeTabId)
          ? current.activeTabId
          : (kept[0] ?? null),
      previewTabId:
        current.previewTabId !== null && kept.includes(current.previewTabId)
          ? current.previewTabId
          : null,
      activationHistory,
    }));
  }

  const reachable = new Set(
    collectPanes(root).flatMap((pane) => [...pane.tabInstanceIds]),
  );
  const orphanIds = Object.keys(state.tilesByInstanceId).filter(
    (id) => !reachable.has(id),
  );
  const tiles =
    orphanIds.length === 0
      ? state.tilesByInstanceId
      : Object.fromEntries(
          Object.entries(state.tilesByInstanceId).filter(
            ([id]) => !orphanIds.includes(id),
          ),
        );
  const sizes = pruneSizes(root, state.sizesByGroupId);
  const activePaneId =
    state.activePaneId !== null &&
    findPaneById(root, state.activePaneId) !== null
      ? state.activePaneId
      : firstPaneId(root);

  if (
    root === state.root &&
    tiles === state.tilesByInstanceId &&
    sizes === state.sizesByGroupId &&
    activePaneId === state.activePaneId
  ) {
    return state;
  }
  return {
    root,
    activePaneId,
    tilesByInstanceId: tiles,
    sizesByGroupId: sizes,
  };
}

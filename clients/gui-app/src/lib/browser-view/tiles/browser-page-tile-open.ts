import { findPaneById } from "@/stores/epics/canvas/tile-tree";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";

/**
 * Where a page-opened tab lands. `split-right` puts it beside the page the
 * popup came from, which is the point of opening in-app on a canvas showing
 * several tiles at once. A viewport that shows exactly one tile has no
 * beside: the split would leave a second pane the user cannot see and cannot
 * close, so `same-pane` takes over the pane instead.
 */
export type BrowserPageTilePlacement = "split-right" | "same-pane";

interface BrowserPageOpenTileRequest {
  readonly viewTabId: string;
  readonly paneId: string;
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
  readonly url: string;
  readonly placement: BrowserPageTilePlacement;
}

export function openBrowserSessionTileFromPage(
  request: BrowserPageOpenTileRequest,
): boolean {
  const store = useEpicCanvasStore.getState();
  const canvas = store.canvasByTabId[request.viewTabId];
  if (canvas === undefined || canvas.root === null) return false;
  const targetPane = findPaneById(canvas.root, request.paneId);
  if (targetPane === null) return false;
  const tile = makeBrowserSessionTileRef({
    hostId: request.hostId,
    sessionId: request.sessionId,
    tabId: request.tabId,
  });
  if (request.placement === "split-right") {
    store.splitPaneWithNode(request.viewTabId, request.paneId, "right", tile);
    const nextCanvas =
      useEpicCanvasStore.getState().canvasByTabId[request.viewTabId];
    if (
      nextCanvas !== undefined &&
      nextCanvas.tilesByInstanceId[tile.instanceId] !== undefined
    ) {
      return true;
    }
  }
  store.openTileInPane(request.viewTabId, request.paneId, tile, {
    mode: "permanent",
    index: null,
  });
  return true;
}

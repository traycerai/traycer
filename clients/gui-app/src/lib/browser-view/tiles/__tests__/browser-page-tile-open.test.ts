import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBrowserSessionTileFromPage } from "@/lib/browser-view/tiles/browser-page-tile-open";
import { createSingleTileCanvas } from "@/stores/epics/canvas/actions";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  isBrowserSessionTileRef,
  type BrowserSessionTileRef,
  type EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";

const VIEW_TAB_ID = "view-tab-page-open";
const HOST_ID = "host-page-open";
const SOURCE_TILE: EpicCanvasTileRef = {
  id: "ticket-page-open",
  instanceId: "ticket-page-open-instance",
  type: "ticket",
  name: "Ticket",
  hostId: HOST_ID,
};

function resetStore(): void {
  useEpicCanvasStore.setState({ canvasByTabId: {}, tabsById: {} });
}

function seedCanvas(): { readonly paneId: string } {
  const canvas = createSingleTileCanvas(SOURCE_TILE);
  const pane = collectPanes(canvas.root).at(0);
  if (pane === undefined) throw new Error("expected a pane");
  useEpicCanvasStore.setState({
    tabsById: {
      [VIEW_TAB_ID]: {
        tabId: VIEW_TAB_ID,
        epicId: "epic-page-open",
        name: "Page open",
      },
    },
    canvasByTabId: { [VIEW_TAB_ID]: canvas },
  });
  return { paneId: pane.id };
}

function paneCount(): number {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
  if (canvas === undefined) return 0;
  return collectPanes(canvas.root).length;
}

function browserSessionTiles(): ReadonlyArray<BrowserSessionTileRef> {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
  if (canvas === undefined) return [];
  return Object.values(canvas.tilesByInstanceId).filter(
    (tile): tile is BrowserSessionTileRef =>
      tile !== undefined && isBrowserSessionTileRef(tile),
  );
}

describe("openBrowserSessionTileFromPage", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("places a host-created popup as a browser-session pointer", () => {
    const { paneId } = seedCanvas();

    const opened = openBrowserSessionTileFromPage({
      viewTabId: VIEW_TAB_ID,
      paneId,
      hostId: HOST_ID,
      sessionId: "session-popup",
      tabId: "tab-popup",
      url: "https://popup.example/oauth",
      placement: "split-right",
    });

    expect(opened).toBe(true);
    expect(browserSessionTiles()).toMatchObject([
      {
        type: "browser-session",
        hostId: HOST_ID,
        sessionId: "session-popup",
        tabId: "tab-popup",
        viewportPreset: "responsive",
      },
    ]);
    expect(paneCount()).toBe(2);
  });

  it("takes over the pane rather than splitting it on a one-tile viewport", () => {
    const { paneId } = seedCanvas();

    const opened = openBrowserSessionTileFromPage({
      viewTabId: VIEW_TAB_ID,
      paneId,
      hostId: HOST_ID,
      sessionId: "session-popup",
      tabId: "tab-popup",
      url: "https://popup.example/oauth",
      placement: "same-pane",
    });

    expect(opened).toBe(true);
    expect(browserSessionTiles()).toHaveLength(1);
    // A second pane on a viewport that shows one tile is a tile the user can
    // neither see nor close.
    expect(paneCount()).toBe(1);
  });
});

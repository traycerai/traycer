import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { epicCanvasKey } from "@/lib/persist";
import {
  useTileScrollAnchorStore,
  type TileScrollAnchor,
} from "@/stores/epics/canvas/tile-scroll-anchor-store";
import { SPEC_A } from "./canvas-test-fixtures";

const ANCHOR: TileScrollAnchor = {
  kind: "native",
  scrollTop: 240,
  scrollLeft: 0,
  scrollHeight: 1200,
  scrollWidth: 600,
};

beforeEach(() => {
  window.localStorage.clear();
  useEpicCanvasStore.persist.setOptions({ name: epicCanvasKey(null) });
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useTileScrollAnchorStore.setState({ anchors: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
  useEpicCanvasStore.getState().clearAllTitleGenerationPending();
});

describe("canvas store scroll-anchor sweep", () => {
  it("evicts a tile's anchor when its canvas is permanently removed", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-evict", "Evict Me");
    store.openTileInTab(tabId, SPEC_A);
    useTileScrollAnchorStore.getState().setAnchor(SPEC_A.instanceId, ANCHOR);

    useEpicCanvasStore.getState().closeTabsForEpics(["epic-evict"]);

    expect(
      useTileScrollAnchorStore.getState().getAnchor(SPEC_A.instanceId),
    ).toBeUndefined();
  });

  it("preserves the anchor across a hide-for-reopen close (tile stays live)", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-hide", "Hide Me");
    store.openTileInTab(tabId, SPEC_A);
    useTileScrollAnchorStore.getState().setAnchor(SPEC_A.instanceId, ANCHOR);

    // closeTab hides the tab but keeps its canvas (and tiles) for reopen, so the
    // instanceId never leaves the live set and the sweep must NOT clear it.
    store.closeTab(tabId);

    expect(
      useTileScrollAnchorStore.getState().getAnchor(SPEC_A.instanceId),
    ).toEqual(ANCHOR);
  });
});

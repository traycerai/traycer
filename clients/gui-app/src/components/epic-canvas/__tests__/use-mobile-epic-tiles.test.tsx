import "../../../../__tests__/test-browser-apis";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useMobileEpicTiles } from "@/components/epic-canvas/mobile/use-mobile-epic-tiles";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes, findPaneById } from "@/stores/epics/canvas/tile-tree";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
  TileGroup,
  TileLayoutNode,
  TilePane,
} from "@/stores/epics/canvas/types";

const VIEW_TAB_ID = "view-tab-1";

function spec(n: number): EpicCanvasTileRef {
  return {
    id: `spec-${n}`,
    instanceId: `inst-${n}`,
    type: "spec",
    name: `Spec ${n}`,
    hostId: "host-A",
  };
}

function makePane(
  id: string,
  tiles: ReadonlyArray<EpicCanvasTileRef>,
  activeTabId: string,
): TilePane {
  return {
    kind: "pane",
    id,
    tabInstanceIds: tiles.map((tile) => tile.instanceId),
    activeTabId,
    previewTabId: null,
    activationHistory: [activeTabId],
  };
}

function twoPaneCanvas(activePaneId: string): EpicCanvasState {
  const root: TileGroup = {
    kind: "group",
    id: "root-group",
    direction: "horizontal",
    children: [
      makePane("pane-A", [spec(1), spec(2)], "inst-1"),
      makePane("pane-B", [spec(3)], "inst-3"),
    ],
  };
  return {
    root,
    activePaneId,
    tilesByInstanceId: {
      "inst-1": spec(1),
      "inst-2": spec(2),
      "inst-3": spec(3),
    },
    sizesByGroupId: { "root-group": [0.5, 0.5] },
  };
}

function seed(canvas: EpicCanvasState): void {
  useEpicCanvasStore.setState({
    tabsById: {
      [VIEW_TAB_ID]: { tabId: VIEW_TAB_ID, epicId: "epic-1", name: "Epic 1" },
    },
    canvasByTabId: { [VIEW_TAB_ID]: canvas },
  });
}

function paneIds(root: TileLayoutNode | null): ReadonlyArray<string> {
  return collectPanes(root).map((pane) => pane.id);
}

describe("useMobileEpicTiles", () => {
  afterEach(() => {
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("lists every tile across panes in tree order with the current one flagged", () => {
    seed(twoPaneCanvas("pane-A"));
    const { result } = renderHook(() => useMobileEpicTiles(VIEW_TAB_ID));
    expect(result.current.tiles.map((tile) => tile.instanceId)).toEqual([
      "inst-1",
      "inst-2",
      "inst-3",
    ]);
    expect(result.current.tiles.map((tile) => tile.paneId)).toEqual([
      "pane-A",
      "pane-A",
      "pane-B",
    ]);
    expect(result.current.currentInstanceId).toBe("inst-1");
  });

  it("tracks the active pane for currentInstanceId", () => {
    seed(twoPaneCanvas("pane-B"));
    const { result } = renderHook(() => useMobileEpicTiles(VIEW_TAB_ID));
    expect(result.current.currentInstanceId).toBe("inst-3");
  });

  it("selectTile switches activation but leaves the split layout intact", () => {
    seed(twoPaneCanvas("pane-A"));
    const before = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
    const { result } = renderHook(() => useMobileEpicTiles(VIEW_TAB_ID));

    act(() => {
      result.current.selectTile("pane-B", "inst-3");
    });

    const after = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
    // Activation moved to the picked tile...
    expect(after?.activePaneId).toBe("pane-B");
    expect(findPaneById(after?.root ?? null, "pane-B")?.activeTabId).toBe(
      "inst-3",
    );
    expect(result.current.currentInstanceId).toBe("inst-3");
    // ...but the split STRUCTURE and sizes are unchanged (activation-only).
    expect(after?.root?.kind).toBe("group");
    expect(paneIds(after?.root ?? null)).toEqual(["pane-A", "pane-B"]);
    expect(after?.sizesByGroupId).toEqual(before?.sizesByGroupId);
  });
});

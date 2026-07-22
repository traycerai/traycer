import "../../../../__tests__/test-browser-apis";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileEpicTileView } from "@/components/epic-canvas/mobile/mobile-epic-tile-view";
import { selectMobileTile } from "@/components/epic-canvas/mobile/mobile-tile-selection";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
  TileGroup,
  TileLayoutNode,
  TilePane,
} from "@/stores/epics/canvas/types";

const VIEW_TAB_ID = "view-tab-1";

// ActiveTabBody reads permission/snapshot/artifact state through epic-selectors;
// stub them so the shared tile body mounts without a HostRuntimeProvider /
// EpicSessionProvider (mirrors tab-group-view.test).
vi.mock("@/lib/epic-selectors", () => ({
  useEpicArtifact: (id: string) => ({ id }),
  useEpicTabDisplayTitle: (node: { readonly name: string }) => node.name,
  useEpicLiveArtifactTitleGenerating: () => false,
  useEpicPermissionRole: () => "owner",
  useEpicSnapshotLoaded: () => true,
  useMaybeEpicTuiAgentHarnessId: () => null,
}));

// The real tile bodies pull the full chat/host machinery; the single-tile view
// only needs to prove WHICH tile renders, so stub the render seam to a marker.
vi.mock("@/components/epic-canvas/renderers/epic-node-tile", () => ({
  EpicNodeTile: ({ node }: { readonly node: EpicCanvasTileRef }) => (
    <div data-testid={`tile-${node.id}`} />
  ),
}));

// The empty-pane opener pulls the command-palette router/provider stack; stub
// it to a marker so the empty-canvas branch is observable in isolation.
vi.mock("@/components/epic-canvas/canvas/pane-opener", () => ({
  PaneOpener: () => <div data-testid="pane-opener" />,
}));

// The current-tile bar is covered by its own test; stub it here to a marker
// carrying the tile it was handed, so the view test can assert WHICH tile the
// bar reflects without pulling the bar's host/title hooks.
vi.mock("@/components/epic-canvas/mobile/mobile-current-tile-bar", () => ({
  MobileCurrentTileBar: ({ tile }: { readonly tile: EpicCanvasTileRef }) => (
    <div data-testid="current-tile-bar" data-tile-id={tile.id} />
  ),
}));

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
  activeTabId: string | null,
): TilePane {
  return {
    kind: "pane",
    id,
    tabInstanceIds: tiles.map((tile) => tile.instanceId),
    activeTabId,
    previewTabId: null,
    activationHistory: activeTabId === null ? [] : [activeTabId],
  };
}

// A persisted TWO-pane split: pane-A (spec-1 active, spec-2) beside pane-B
// (spec-3 active). Mobile must pick exactly one without touching the tree.
function twoPaneCanvas(activePaneId: string | null): EpicCanvasState {
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

function renderView() {
  return render(<MobileEpicTileView epicId="epic-1" tabId={VIEW_TAB_ID} />);
}

function renderedTileCount(): number {
  return document.querySelectorAll('[data-testid^="tile-"]').length;
}

function paneIds(root: TileLayoutNode | null): ReadonlyArray<string> {
  return collectPanes(root).map((pane) => pane.id);
}

describe("selectMobileTile", () => {
  it("returns null for an empty (rootless) canvas", () => {
    expect(
      selectMobileTile({
        root: null,
        activePaneId: null,
        tilesByInstanceId: {},
        sizesByGroupId: {},
      }),
    ).toBeNull();
  });

  it("picks the active pane's active tab", () => {
    const selection = selectMobileTile(twoPaneCanvas("pane-B"));
    expect(selection?.paneId).toBe("pane-B");
    expect(selection?.ref.id).toBe("spec-3");
  });

  it("falls back to the first pane when there is no active pane", () => {
    const selection = selectMobileTile(twoPaneCanvas(null));
    expect(selection?.paneId).toBe("pane-A");
    expect(selection?.ref.id).toBe("spec-1");
  });

  it("falls back to the first tab instance when the pane has no active tab", () => {
    const selection = selectMobileTile({
      root: makePane("pane-A", [spec(1), spec(2)], null),
      activePaneId: "pane-A",
      tilesByInstanceId: { "inst-1": spec(1), "inst-2": spec(2) },
      sizesByGroupId: {},
    });
    expect(selection?.ref.id).toBe("spec-1");
  });

  it("skips an emptied active pane and picks the next pane holding a tile", () => {
    const root: TileGroup = {
      kind: "group",
      id: "g",
      direction: "horizontal",
      children: [makePane("pane-A", [], null), makePane("pane-B", [spec(3)], "inst-3")],
    };
    const selection = selectMobileTile({
      root,
      activePaneId: "pane-A",
      tilesByInstanceId: { "inst-3": spec(3) },
      sizesByGroupId: {},
    });
    expect(selection?.paneId).toBe("pane-B");
    expect(selection?.ref.id).toBe("spec-3");
  });
});

describe("<MobileEpicTileView />", () => {
  afterEach(() => {
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("renders exactly one tile - the active pane's active tile", () => {
    seed(twoPaneCanvas("pane-A"));
    renderView();
    expect(screen.queryByTestId("tile-spec-1")).not.toBeNull();
    expect(screen.queryByTestId("tile-spec-2")).toBeNull();
    expect(screen.queryByTestId("tile-spec-3")).toBeNull();
    expect(renderedTileCount()).toBe(1);
  });

  it("shows the active pane's tile in a multi-split layout (picks exactly one)", () => {
    seed(twoPaneCanvas("pane-B"));
    renderView();
    expect(screen.queryByTestId("tile-spec-3")).not.toBeNull();
    expect(renderedTileCount()).toBe(1);
  });

  it("performs zero writes to the persisted split layout when viewed", () => {
    seed(twoPaneCanvas("pane-A"));
    const before = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
    renderView();
    const after = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
    // Reference-identical: rendering the mobile view mutates neither the split
    // tree nor the group sizes.
    expect(after).toBe(before);
    expect(after?.root).toBe(before?.root);
    expect(after?.sizesByGroupId).toBe(before?.sizesByGroupId);
  });

  it("hands the current tile to the current-tile bar", () => {
    seed(twoPaneCanvas("pane-B"));
    renderView();
    expect(
      screen.getByTestId("current-tile-bar").getAttribute("data-tile-id"),
    ).toBe("spec-3");
  });

  it("swaps the rendered tile when activation moves to another pane", () => {
    seed(twoPaneCanvas("pane-A"));
    renderView();
    expect(screen.queryByTestId("tile-spec-1")).not.toBeNull();
    const before = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];

    // Same store transition `useMobileEpicTiles.selectTile` drives.
    act(() => {
      useEpicCanvasStore
        .getState()
        .prepareSetActiveTileTabFocusTarget(VIEW_TAB_ID, "pane-B", "inst-3");
    });

    expect(screen.queryByTestId("tile-spec-3")).not.toBeNull();
    expect(renderedTileCount()).toBe(1);
    const after = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
    // The split STRUCTURE + sizes are unchanged - only activation moved.
    expect(paneIds(after?.root ?? null)).toEqual(["pane-A", "pane-B"]);
    expect(after?.sizesByGroupId).toEqual(before?.sizesByGroupId);
  });

  it("renders the inline opener (not a blank screen) for an empty pane", () => {
    // A non-null root whose only pane holds no tiles - the user closed the last
    // tab. selectMobileTile returns null; the view must still offer an
    // affordance, not a dead-end.
    seed({
      root: makePane("pane-A", [], null),
      activePaneId: "pane-A",
      tilesByInstanceId: {},
      sizesByGroupId: {},
    });
    renderView();
    expect(screen.queryByTestId("pane-opener")).not.toBeNull();
    expect(renderedTileCount()).toBe(0);
  });
});

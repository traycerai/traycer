import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSwitcherActivate } from "@/components/epic-canvas/mobile/use-switcher-activate";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { makeSelectActiveEpicArtifactId } from "@/stores/epics/canvas/canvas-selectors";
import type {
  EpicArtifactRef,
  EpicCanvasState,
  TilePane,
} from "@/stores/epics/canvas/types";

// Run the prepared focus mutation synchronously and skip route focus routing,
// so the real canvas store transitions run in the test (mirrors the tile-view
// test's direct-prepare approach).
vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation:
    () => (_epicId: string, _tabId: string, prepare: () => unknown) => {
      prepare();
    },
}));

const TAB_ID = "tab-activate";
const EPIC_ID = "epic-1";
const HOST_A = "host-A";
const HOST_B = "host-B";

function spec(n: number, instanceId: string): EpicArtifactRef {
  return {
    id: `spec-${n}`,
    instanceId,
    type: "spec",
    name: `Spec ${n}`,
    hostId: HOST_A,
  };
}

function chat(id: string, instanceId: string, hostId: string): EpicArtifactRef {
  return { id, instanceId, type: "chat", name: id, hostId };
}

/**
 * `inst-1` is a KEPT tile and `inst-2` the pane's preview - the two states a
 * tap has to tell apart.
 */
function singlePaneCanvas(): EpicCanvasState {
  const root: TilePane = {
    kind: "pane",
    id: "pane-A",
    tabInstanceIds: ["inst-1", "inst-2"],
    activeTabId: "inst-2",
    previewTabId: "inst-2",
    activationHistory: ["inst-2", "inst-1"],
  };
  return {
    root,
    activePaneId: "pane-A",
    tilesByInstanceId: {
      "inst-1": spec(1, "inst-1"),
      "inst-2": spec(2, "inst-2"),
    },
    sizesByGroupId: {},
  };
}

function seed(canvas: EpicCanvasState): void {
  useEpicCanvasStore.setState({
    tabsById: { [TAB_ID]: { tabId: TAB_ID, epicId: EPIC_ID, name: "Epic 1" } },
    canvasByTabId: { [TAB_ID]: canvas },
  });
}

function activeArtifactId(): string | null {
  return makeSelectActiveEpicArtifactId(TAB_ID)(useEpicCanvasStore.getState());
}

function pane(): TilePane {
  const root = useEpicCanvasStore.getState().canvasByTabId[TAB_ID]?.root;
  if (root?.kind !== "pane") throw new Error("expected a single-pane root");
  return root;
}

function renderActivate(onClose: () => void) {
  return renderHook(() => useSwitcherActivate(EPIC_ID, TAB_ID, onClose));
}

describe("useSwitcherActivate", () => {
  afterEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("recycles the pane's preview rather than stacking another tile", () => {
    seed(singlePaneCanvas());
    const onClose = vi.fn();
    const { result } = renderActivate(onClose);

    act(() => {
      result.current(() => spec(3, "inst-3"));
    });

    // The tab COUNT is the assertion: a permanent open would make this three.
    expect(pane().tabInstanceIds).toEqual(["inst-1", "inst-3"]);
    expect(pane().previewTabId).toBe("inst-3");
    expect(activeArtifactId()).toBe("spec-3");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("preserves the replaced tile's payload so back/forward can re-present it", () => {
    seed(singlePaneCanvas());
    const { result } = renderActivate(vi.fn());

    act(() => {
      result.current(() => spec(3, "inst-3"));
    });

    // Replacing is not destroying: the evicted preview is recoverable by the
    // exact instance id its history entry addresses.
    const preserved =
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[TAB_ID];
    expect(preserved?.["inst-2"]?.node.id).toBe("spec-2");
  });

  it("never evicts a kept tile, only the preview beside it", () => {
    seed(singlePaneCanvas());
    const { result } = renderActivate(vi.fn());

    act(() => {
      result.current(() => spec(3, "inst-3"));
    });
    act(() => {
      result.current(() => spec(4, "inst-4"));
    });

    // `inst-1` was never the preview, so no number of taps reaches it - which
    // is what keeps a kept chat inside the pane's retention window.
    expect(pane().tabInstanceIds).toEqual(["inst-1", "inst-4"]);
    expect(pane().activationHistory).toContain("inst-1");
  });

  it("focuses an already-open tile without demoting it to preview", () => {
    seed(singlePaneCanvas());
    const onClose = vi.fn();
    const before = useEpicCanvasStore.getState().canvasByTabId[TAB_ID];
    const { result } = renderActivate(onClose);

    act(() => {
      // spec-1 is open and KEPT; the fresh instanceId is never used, because
      // dedup finds the existing tab first.
      result.current(() => spec(1, "unused"));
    });

    expect(activeArtifactId()).toBe("spec-1");
    expect(pane().previewTabId).toBe("inst-2");
    // Only activation moved: same tabs in the same order, sizes untouched.
    expect(pane().tabInstanceIds).toEqual(["inst-1", "inst-2"]);
    expect(
      useEpicCanvasStore.getState().canvasByTabId[TAB_ID]?.sizesByGroupId,
    ).toEqual(before?.sizesByGroupId);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dedups by host, so a shared content id on another host opens its own tile", () => {
    const root: TilePane = {
      kind: "pane",
      id: "pane-A",
      tabInstanceIds: ["inst-a"],
      activeTabId: "inst-a",
      previewTabId: null,
      activationHistory: ["inst-a"],
    };
    seed({
      root,
      activePaneId: "pane-A",
      tilesByInstanceId: { "inst-a": chat("chat-1", "inst-a", HOST_A) },
      sizesByGroupId: {},
    });
    const { result } = renderActivate(vi.fn());

    act(() => {
      result.current(() => chat("chat-1", "inst-b", HOST_B));
    });

    // A cross-host clone carries the source's chat id verbatim, so matching on
    // the id alone would hand back the other machine's tile.
    expect(pane().tabInstanceIds).toEqual(["inst-a", "inst-b"]);
    const opened =
      useEpicCanvasStore.getState().canvasByTabId[TAB_ID]?.tilesByInstanceId[
        "inst-b"
      ];
    if (opened?.type !== "chat") throw new Error("expected a chat tile");
    expect(opened.hostId).toBe(HOST_B);
  });
});

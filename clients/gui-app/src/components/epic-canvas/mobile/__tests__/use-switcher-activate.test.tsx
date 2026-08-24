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

function spec(n: number, instanceId: string): EpicArtifactRef {
  return {
    id: `spec-${n}`,
    instanceId,
    type: "spec",
    name: `Spec ${n}`,
    hostId: "host-A",
  };
}

function singlePaneCanvas(): EpicCanvasState {
  const root: TilePane = {
    kind: "pane",
    id: "pane-A",
    tabInstanceIds: ["inst-1", "inst-2"],
    activeTabId: "inst-1",
    previewTabId: null,
    activationHistory: ["inst-1"],
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

function seed(): void {
  useEpicCanvasStore.setState({
    tabsById: { [TAB_ID]: { tabId: TAB_ID, epicId: EPIC_ID, name: "Epic 1" } },
    canvasByTabId: { [TAB_ID]: singlePaneCanvas() },
  });
}

function activeArtifactId(): string | null {
  return makeSelectActiveEpicArtifactId(TAB_ID)(useEpicCanvasStore.getState());
}

describe("useSwitcherActivate", () => {
  afterEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("activates an already-open tile without disturbing the split structure or sizes, then closes", () => {
    seed();
    const onClose = vi.fn();
    const before = useEpicCanvasStore.getState().canvasByTabId[TAB_ID];
    const { result } = renderHook(() =>
      useSwitcherActivate(EPIC_ID, TAB_ID, onClose),
    );

    act(() => {
      // spec-2 is already open (inst-2) - never used the buildRef path.
      result.current("spec-2", () => spec(2, "unused"));
    });

    expect(activeArtifactId()).toBe("spec-2");
    const after = useEpicCanvasStore.getState().canvasByTabId[TAB_ID];
    const beforePane = before?.root;
    const afterPane = after?.root;
    if (beforePane?.kind !== "pane" || afterPane?.kind !== "pane") {
      throw new Error("expected a single-pane root");
    }
    // Only activation moved: same tabs in the same order, sizes untouched.
    expect(afterPane.tabInstanceIds).toEqual(beforePane.tabInstanceIds);
    expect(after?.sizesByGroupId).toEqual(before?.sizesByGroupId);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opens a not-yet-open item as a new tile, then closes", () => {
    seed();
    const onClose = vi.fn();
    const { result } = renderHook(() =>
      useSwitcherActivate(EPIC_ID, TAB_ID, onClose),
    );

    act(() => {
      result.current("spec-3", () => spec(3, "inst-3"));
    });

    expect(activeArtifactId()).toBe("spec-3");
    const after = useEpicCanvasStore.getState().canvasByTabId[TAB_ID];
    expect(after?.tilesByInstanceId["inst-3"]?.id).toBe("spec-3");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

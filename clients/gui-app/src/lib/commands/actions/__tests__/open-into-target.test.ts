import { afterEach, describe, expect, it, vi } from "vitest";
import { openTileIntoTargetGroup } from "@/lib/commands/actions/open-into-target";
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";
import { paneTabRefs } from "@/stores/epics/canvas/actions";
import { findPaneById } from "@/stores/epics/canvas/tile-tree";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type {
  EpicCanvasTileRef,
  EpicNodeRef,
} from "@/stores/epics/canvas/types";

const REF: EpicNodeRef = {
  id: "art-a",
  instanceId: "inst-a",
  type: "spec",
  name: "Spec A",
  hostId: "host-A",
};

function resetCanvasStore(): void {
  window.localStorage.clear();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
}

function installOpenTileInGroupMock() {
  const mock =
    vi.fn<(tabId: string, groupId: string, ref: EpicCanvasTileRef) => void>();
  useEpicCanvasStore.setState({ openTileInPane: mock });
  return mock;
}

/**
 * A seeded tab with an active pane, so a `splitPaneEmptyRightInTab` target
 * group can be carved out - mirrors `new-chat.test.ts`'s `seedActiveGroup`.
 */
function seedTabWithEmptyTargetGroup(): {
  readonly tabId: string;
  readonly targetGroupId: string;
} {
  const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic 1");
  useEpicCanvasStore.getState().openTileInTab(tabId, {
    id: "existing-spec",
    instanceId: "inst-existing-spec",
    type: "spec",
    name: "Existing spec",
    hostId: "test-host",
  });
  const sourceGroupId =
    useEpicCanvasStore.getState().canvasByTabId[tabId]?.activePaneId ?? null;
  if (sourceGroupId === null) {
    throw new Error("Expected active group after seeding canvas.");
  }
  const targetGroupId = useEpicCanvasStore
    .getState()
    .splitPaneEmptyRightInTab(tabId, sourceGroupId);
  if (targetGroupId === null) {
    throw new Error("Expected a new empty group after split.");
  }
  return { tabId, targetGroupId };
}

interface NestedFocusCall {
  readonly epicId: string;
  readonly tabId: string;
  readonly target: NestedFocusTarget | null;
}

function nestedFocusRecorder(): {
  readonly calls: NestedFocusCall[];
  readonly navigateNestedFocus: NavigateNestedFocus;
} {
  const calls: NestedFocusCall[] = [];
  return {
    calls,
    navigateNestedFocus: (epicId, tabId, prepare) => {
      const target = prepare();
      calls.push({ epicId, tabId, target });
      return target;
    },
  };
}

afterEach(() => {
  resetCanvasStore();
});

describe("openTileIntoTargetGroup", () => {
  it("routes to canvas openTileInPane with the bound tab + group", () => {
    const mock = installOpenTileInGroupMock();
    openTileIntoTargetGroup({
      tabId: "tab-1",
      groupId: "group-1",
      ref: REF,
      navigateNestedFocus: undefined,
    });
    expect(mock).toHaveBeenCalledWith("tab-1", "group-1", REF);
  });

  it("no-ops when the tab id is missing", () => {
    const mock = installOpenTileInGroupMock();
    openTileIntoTargetGroup({
      tabId: null,
      groupId: "group-1",
      ref: REF,
      navigateNestedFocus: undefined,
    });
    expect(mock).not.toHaveBeenCalled();
  });

  it("no-ops when the target group id is missing", () => {
    const mock = installOpenTileInGroupMock();
    openTileIntoTargetGroup({
      tabId: "tab-1",
      groupId: null,
      ref: REF,
      navigateNestedFocus: undefined,
    });
    expect(mock).not.toHaveBeenCalled();
  });

  it("routes the open through the nested-focus navigation boundary when the tab resolves to an epic", () => {
    const { tabId, targetGroupId } = seedTabWithEmptyTargetGroup();
    const navigation = nestedFocusRecorder();

    openTileIntoTargetGroup({
      tabId,
      groupId: targetGroupId,
      ref: REF,
      navigateNestedFocus: navigation.navigateNestedFocus,
    });

    // The boundary was invoked (proving the open routes through it), the
    // `prepare` callback it ran resolved a real focus target, and the raw
    // canvas mutation underneath still happened.
    expect(navigation.calls).toHaveLength(1);
    const call = navigation.calls[0];
    expect(call.epicId).toBe("epic-1");
    expect(call.tabId).toBe(tabId);
    expect(call.target?.paneId).toBe(targetGroupId);
    expect(typeof call.target?.tileInstanceId).toBe("string");
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    if (canvas === undefined) throw new Error("expected a resolvable canvas");
    const targetPane = findPaneById(canvas.root, targetGroupId);
    if (targetPane === null) throw new Error("expected a resolvable pane");
    expect(paneTabRefs(canvas, targetPane).map((tab) => tab.id)).toEqual([
      "art-a",
    ]);
  });

  it("falls back to a raw canvas mutation without navigating when no navigation seam is available", () => {
    const { tabId, targetGroupId } = seedTabWithEmptyTargetGroup();
    const mock = installOpenTileInGroupMock();

    openTileIntoTargetGroup({
      tabId,
      groupId: targetGroupId,
      ref: REF,
      navigateNestedFocus: undefined,
    });

    expect(mock).toHaveBeenCalledWith(tabId, targetGroupId, REF);
  });

  it("falls back to a raw canvas mutation without navigating when the tab has no resolvable epic", () => {
    const mock = installOpenTileInGroupMock();
    const navigation = nestedFocusRecorder();

    openTileIntoTargetGroup({
      tabId: "unknown-tab",
      groupId: "group-1",
      ref: REF,
      navigateNestedFocus: navigation.navigateNestedFocus,
    });

    expect(navigation.calls).toHaveLength(0);
    expect(mock).toHaveBeenCalledWith("unknown-tab", "group-1", REF);
  });
});

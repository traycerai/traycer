import { describe, expect, it } from "vitest";
import {
  closeTab,
  dropOnTabStrip,
  openTile,
  resizeSplit,
  splitPaneEmpty,
} from "@/stores/epics/canvas/actions";
import { collectPanes, findPaneById } from "@/stores/epics/canvas/tile-tree";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";
import type { TileLayoutNode } from "@/stores/epics/canvas/tile-tree";
import {
  group,
  pane,
  TEST_HOST_ID,
} from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";
import { restoreClosedCanvas } from "../restore-canvas";

const A: EpicCanvasTileRef = {
  id: "content-a",
  instanceId: "instance-a",
  type: "spec",
  name: "A",
  hostId: TEST_HOST_ID,
};
const A_OTHER_INSTANCE: EpicCanvasTileRef = {
  ...A,
  instanceId: "instance-a-other",
};
const B: EpicCanvasTileRef = {
  id: "content-b",
  instanceId: "instance-b",
  type: "spec",
  name: "B",
  hostId: TEST_HOST_ID,
};
const C: EpicCanvasTileRef = {
  id: "content-c",
  instanceId: "instance-c",
  type: "spec",
  name: "C",
  hostId: TEST_HOST_ID,
};
const D: EpicCanvasTileRef = {
  id: "content-d",
  instanceId: "instance-d",
  type: "spec",
  name: "D",
  hostId: TEST_HOST_ID,
};
const E: EpicCanvasTileRef = {
  id: "content-e",
  instanceId: "instance-e",
  type: "spec",
  name: "E",
  hostId: TEST_HOST_ID,
};

function canvas(
  root: TileLayoutNode,
  tiles: ReadonlyArray<EpicCanvasTileRef>,
  activePaneId: string,
  sizesByGroupId: EpicCanvasState["sizesByGroupId"],
): EpicCanvasState {
  return {
    root,
    activePaneId,
    tilesByInstanceId: Object.fromEntries(
      tiles.map((tile) => [tile.instanceId, tile]),
    ),
    sizesByGroupId,
  };
}

function paneFor(state: EpicCanvasState, paneId: string) {
  if (state.root === null) throw new Error("expected a canvas root");
  const result = findPaneById(state.root, paneId);
  if (result === null) throw new Error(`missing pane ${paneId}`);
  return result;
}

function paneTabIds(
  state: EpicCanvasState,
  paneId: string,
): ReadonlyArray<string> {
  return paneFor(state, paneId).tabInstanceIds;
}

describe("restoreClosedCanvas", () => {
  it("restores into the original pane and keeps the recovered tab permanent", () => {
    const before = canvas(
      {
        ...pane("p1", [A.instanceId, B.instanceId, C.instanceId]),
        activeTabId: C.instanceId,
        activationHistory: [C.instanceId, A.instanceId, B.instanceId],
        previewTabId: C.instanceId,
      },
      [A, B, C],
      "p1",
      {},
    );
    const after = closeTab(before, "p1", B.instanceId);

    const restored = restoreClosedCanvas(after, before, after, {
      instanceIds: [B.instanceId],
      focus: true,
    });

    expect(paneTabIds(restored, "p1")).toEqual([
      A.instanceId,
      B.instanceId,
      C.instanceId,
    ]);
    expect(paneFor(restored, "p1").activeTabId).toBe(B.instanceId);
    // Recovery is an explicit reopen; it must not turn the tab into a preview.
    expect(paneFor(restored, "p1").previewTabId).toBe(C.instanceId);
  });

  it("reconstructs a split immediately after closing its only tab", () => {
    const before = canvas(
      group("g1", "horizontal", [
        pane("p1", [A.instanceId]),
        pane("p2", [B.instanceId]),
      ]),
      [A, B],
      "p2",
      { g1: [0.3, 0.7] },
    );
    const after = closeTab(before, "p2", B.instanceId);

    const restored = restoreClosedCanvas(after, before, after, {
      instanceIds: [B.instanceId],
      focus: true,
    });

    expect(restored.root).toEqual(
      group("g1", "horizontal", [
        pane("p1", [A.instanceId]),
        expect.objectContaining({
          kind: "pane",
          id: "p2",
          tabInstanceIds: [B.instanceId],
          activeTabId: B.instanceId,
        }),
      ]),
    );
    expect(restored.activePaneId).toBe("p2");
    expect(restored.sizesByGroupId.g1).toEqual([0.3, 0.7]);
  });

  it("restores an explicitly closed empty split without adding a blank tile", () => {
    const before = canvas(
      group("g1", "horizontal", [
        pane("p1", [A.instanceId]),
        pane("p2", [B.instanceId]),
      ]),
      [A, B],
      "p1",
      { g1: [0.4, 0.6] },
    );
    const after = closeTab(before, "p2", B.instanceId);

    const restored = restoreClosedCanvas(after, before, after, {
      instanceIds: [],
      paneIds: ["p2"],
      focus: false,
    });

    expect(paneTabIds(restored, "p1")).toEqual([A.instanceId]);
    expect(paneTabIds(restored, "p2")).toEqual([]);
    expect(restored.tilesByInstanceId[B.instanceId]).toBeUndefined();
    expect(restored.activePaneId).toBe("p1");
    expect(restored.sizesByGroupId.g1).toEqual([0.4, 0.6]);
  });

  it("preserves a surviving sibling tab and resize while inserting at the old position", () => {
    const before = canvas(
      group("g1", "horizontal", [
        pane("p1", [A.instanceId, B.instanceId]),
        pane("p2", [C.instanceId]),
      ]),
      [A, B, C],
      "p1",
      { g1: [0.25, 0.75] },
    );
    const after = closeTab(before, "p1", B.instanceId);
    const withNewTab = openTile(after, D, false, "p1");
    const current = resizeSplit(withNewTab, "g1", [0.65, 0.35]);

    const restored = restoreClosedCanvas(current, before, after, {
      instanceIds: [B.instanceId],
      focus: false,
    });

    expect(paneTabIds(restored, "p1")).toEqual([
      A.instanceId,
      B.instanceId,
      D.instanceId,
    ]);
    expect(paneTabIds(restored, "p2")).toEqual([C.instanceId]);
    expect(restored.sizesByGroupId.g1).toEqual(current.sizesByGroupId.g1);
    expect(restored.activePaneId).toBe(current.activePaneId);
    expect(paneFor(restored, "p1").activeTabId).toBe(
      paneFor(current, "p1").activeTabId,
    );
  });

  it("reconstructs the closed tab despite an unrelated nested split", () => {
    const before = canvas(
      group("g1", "horizontal", [
        pane("p1", [A.instanceId, B.instanceId]),
        pane("p2", [C.instanceId]),
      ]),
      [A, B, C],
      "p1",
      {},
    );
    const after = closeTab(before, "p1", B.instanceId);
    const current = splitPaneEmpty(after, "p2", "vertical");
    const nestedGroupId =
      current.root !== null && current.root.kind === "group"
        ? current.root.children.find(
            (child) => child.kind === "group" && child.id !== "g1",
          )?.id
        : undefined;
    if (nestedGroupId === undefined) throw new Error("expected nested split");

    const restored = restoreClosedCanvas(current, before, after, {
      instanceIds: [B.instanceId],
      focus: false,
    });

    expect(paneTabIds(restored, "p1")).toEqual([A.instanceId, B.instanceId]);
    if (restored.root === null || restored.root.kind !== "group") {
      throw new Error("expected restored group");
    }
    expect(restored.root.id).toBe("g1");
    expect(
      restored.root.children.some(
        (child) => child.kind === "group" && child.id === nestedGroupId,
      ),
    ).toBe(true);
    expect(collectPanes(restored.root).map((item) => item.id)).toContain("p1");
  });

  it("falls back to the active pane when the original pane was moved away", () => {
    const before = canvas(
      group("g1", "horizontal", [
        pane("p1", [A.instanceId, B.instanceId]),
        pane("p2", [C.instanceId]),
      ]),
      [A, B, C],
      "p1",
      {},
    );
    const after = closeTab(before, "p1", B.instanceId);
    const current = dropOnTabStrip(
      after,
      { kind: "tab", sourcePaneId: "p1", tabId: A.instanceId, node: A },
      "p2",
      1,
    );

    const restored = restoreClosedCanvas(current, before, after, {
      instanceIds: [B.instanceId],
      focus: true,
    });

    expect(paneTabIds(restored, "p2")).toEqual([
      C.instanceId,
      A.instanceId,
      B.instanceId,
    ]);
    expect(restored.activePaneId).toBe("p2");
    expect(paneFor(restored, "p2").activeTabId).toBe(B.instanceId);
  });

  it("deduplicates an exact instance while allowing another instance of the same content", () => {
    const before = canvas(
      pane("p1", [A.instanceId, A_OTHER_INSTANCE.instanceId, B.instanceId]),
      [A, A_OTHER_INSTANCE, B],
      "p1",
      {},
    );
    const root = before.root;
    if (root === null || root.kind !== "pane") {
      throw new Error("expected a pane");
    }
    const after = closeTab(before, root.id, A.instanceId);
    const restoredOnce = restoreClosedCanvas(after, before, after, {
      instanceIds: [A.instanceId],
      focus: true,
    });

    expect(paneTabIds(restoredOnce, root.id)).toEqual([
      A.instanceId,
      A_OTHER_INSTANCE.instanceId,
      B.instanceId,
    ]);
    expect(restoredOnce.tilesByInstanceId[A.instanceId]?.id).toBe(A.id);

    const restoredTwice = restoreClosedCanvas(restoredOnce, before, after, {
      instanceIds: [A.instanceId],
      focus: true,
    });
    expect(restoredTwice).toBe(restoredOnce);
  });

  it("restores a bulk close without changing current selection when focus is false", () => {
    const before = canvas(
      group("g1", "horizontal", [
        pane("p1", [A.instanceId, B.instanceId]),
        pane("p2", [C.instanceId, D.instanceId]),
      ]),
      [A, B, C, D],
      "p2",
      {},
    );
    const afterA = closeTab(before, "p1", A.instanceId);
    const after = closeTab(afterA, "p2", C.instanceId);
    const current = openTile(after, E, false, "p2");
    const currentSelection = {
      activePaneId: current.activePaneId,
      activeTabId: paneFor(current, "p2").activeTabId,
    };

    const restored = restoreClosedCanvas(current, before, after, {
      instanceIds: [A.instanceId, C.instanceId],
      focus: false,
    });

    expect(paneTabIds(restored, "p1")).toEqual([A.instanceId, B.instanceId]);
    expect(paneTabIds(restored, "p2")).toEqual([
      C.instanceId,
      D.instanceId,
      E.instanceId,
    ]);
    expect(restored.activePaneId).toBe(currentSelection.activePaneId);
    expect(paneFor(restored, "p2").activeTabId).toBe(
      currentSelection.activeTabId,
    );
  });
});

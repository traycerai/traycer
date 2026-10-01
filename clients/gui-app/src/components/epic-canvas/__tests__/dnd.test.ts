import { describe, expect, it } from "vitest";
import {
  getArtifactTabDropIndexFromPoint,
  getEdgeDropPositionFromPoint,
  getEmptyShellDropId,
  getEpicCanvasDropPreview,
  getLeftPanelRailDropPositionOnAxis,
  getSidebarReparentPanelDropId,
  getSidebarReparentRowDropId,
  readEpicCanvasDragSourceData,
  readEpicCanvasDropTargetData,
} from "@/components/epic-canvas/dnd/dnd";
describe("getEdgeDropPositionFromPoint", () => {
  const rect = {
    left: 20,
    top: 30,
    width: 100,
    height: 100,
  };

  it("returns center for the middle region", () => {
    expect(getEdgeDropPositionFromPoint({ x: 70, y: 80 }, rect)).toBe("center");
  });

  it("returns edge positions relative to the provided rect", () => {
    expect(getEdgeDropPositionFromPoint({ x: 21, y: 80 }, rect)).toBe("left");
    expect(getEdgeDropPositionFromPoint({ x: 119, y: 80 }, rect)).toBe("right");
    expect(getEdgeDropPositionFromPoint({ x: 70, y: 31 }, rect)).toBe("top");
    expect(getEdgeDropPositionFromPoint({ x: 70, y: 129 }, rect)).toBe(
      "bottom",
    );
  });

  it("falls back to the nearest edge in the dead zone between edge bands and the center box", () => {
    // Relative (20, 50): past the 15% edge band but outside the centered
    // 40% box - nearest edge is left.
    expect(getEdgeDropPositionFromPoint({ x: 40, y: 80 }, rect)).toBe("left");
    // Relative (50, 75): nearest edge is bottom.
    expect(getEdgeDropPositionFromPoint({ x: 70, y: 105 }, rect)).toBe(
      "bottom",
    );
  });
});

describe("empty shell drop ids", () => {
  it("scopes empty-shell droppables by epic and tab", () => {
    expect(getEmptyShellDropId("epic-1", "tab-1")).toBe(
      "empty-shell:epic-1:tab-1",
    );
    expect(getEmptyShellDropId("epic-1", "tab-1")).not.toBe(
      getEmptyShellDropId("epic-1", "tab-2"),
    );
  });
});

describe("sidebar reparent drop ids", () => {
  it("scopes a reparent row droppable by nodeId", () => {
    expect(getSidebarReparentRowDropId("node-1")).toBe(
      "sidebar-reparent-row:node-1",
    );
    expect(getSidebarReparentRowDropId("node-1")).not.toBe(
      getSidebarReparentRowDropId("node-2"),
    );
  });

  it("scopes a reparent panel droppable by panelId", () => {
    expect(getSidebarReparentPanelDropId("chats")).toBe(
      "sidebar-reparent-panel:chats",
    );
    expect(getSidebarReparentPanelDropId("artifacts")).toBe(
      "sidebar-reparent-panel:artifacts",
    );
  });
});

describe("epic canvas dnd-kit data guards", () => {
  it("accepts artifact tab drag source data", () => {
    expect(
      readEpicCanvasDragSourceData({
        kind: "artifact-tab",
        epicId: "epic-1",
        viewTabId: "view-1",
        sourceGroupId: "group-1",
        tabId: "tab-1",
        isPreview: true,
      }),
    ).toEqual({
      kind: "artifact-tab",
      epicId: "epic-1",
      viewTabId: "view-1",
      sourceGroupId: "group-1",
      tabId: "tab-1",
      isPreview: true,
    });
  });

  it("rejects malformed artifact tab drag source data", () => {
    expect(readEpicCanvasDragSourceData(null)).toBeNull();
    expect(
      readEpicCanvasDragSourceData({
        kind: "artifact-tab",
        epicId: "epic-1",
        viewTabId: "view-1",
        sourceGroupId: "",
        tabId: "tab-1",
        isPreview: true,
      }),
    ).toBeNull();
    expect(
      readEpicCanvasDragSourceData({
        kind: "artifact-tab",
        epicId: "epic-1",
        viewTabId: "view-1",
        sourceGroupId: "group-1",
        tabId: "tab-1",
        isPreview: "true",
      }),
    ).toBeNull();
    // Sources without their owning epic/view-tab scope cannot be committed
    // from the root context and must be rejected.
    expect(
      readEpicCanvasDragSourceData({
        kind: "artifact-tab",
        sourceGroupId: "group-1",
        tabId: "tab-1",
        isPreview: false,
      }),
    ).toBeNull();
  });

  it("accepts sidebar node drag source data", () => {
    expect(
      readEpicCanvasDragSourceData({
        kind: "sidebar-node",
        epicId: "epic-1",
        viewTabId: "view-1",
        hostId: "host-1",
        nodeId: "node-1",
      }),
    ).toEqual({
      kind: "sidebar-node",
      epicId: "epic-1",
      viewTabId: "view-1",
      hostId: "host-1",
      nodeId: "node-1",
    });
  });

  it("rejects malformed sidebar node drag source data", () => {
    expect(readEpicCanvasDragSourceData({ kind: "sidebar-node" })).toBeNull();
    expect(
      readEpicCanvasDragSourceData({
        kind: "sidebar-node",
        epicId: "epic-1",
        viewTabId: "view-1",
        nodeId: "",
      }),
    ).toBeNull();
    expect(
      readEpicCanvasDragSourceData({
        kind: "sidebar-node",
        epicId: "epic-1",
        viewTabId: "view-1",
        nodeId: 1,
      }),
    ).toBeNull();
    expect(
      readEpicCanvasDragSourceData({
        kind: "sidebar-node",
        nodeId: "node-1",
      }),
    ).toBeNull();
  });

  it("accepts terminal tile drag source data", () => {
    const tile = {
      id: "term-1",
      instanceId: "inst-term-1",
      type: "terminal",
      name: "Terminal",
      titleSource: "manual",
      hostId: "host-1",
      cwd: "/repo",
    };
    expect(
      readEpicCanvasDragSourceData({
        kind: "terminal-tile",
        epicId: "epic-1",
        viewTabId: "view-1",
        tile,
      }),
    ).toEqual({
      kind: "terminal-tile",
      epicId: "epic-1",
      viewTabId: "view-1",
      tile,
    });
  });

  it("rejects malformed terminal tile drag source data", () => {
    expect(readEpicCanvasDragSourceData({ kind: "terminal-tile" })).toBeNull();
    expect(
      readEpicCanvasDragSourceData({
        kind: "terminal-tile",
        epicId: "epic-1",
        viewTabId: "view-1",
        tile: {
          id: "chat-1",
          instanceId: "inst-chat-1",
          type: "chat",
          name: "Chat",
          hostId: "host-1",
        },
      }),
    ).toBeNull();
    expect(
      readEpicCanvasDragSourceData({
        kind: "terminal-tile",
        epicId: "epic-1",
        viewTabId: "view-1",
        tile: {
          id: "term-1",
          instanceId: "inst-term-1",
          type: "terminal",
          name: "Terminal",
        },
      }),
    ).toBeNull();
  });

  it("accepts workspace file drag source data", () => {
    const ref = {
      id: "workspace-file:host-1:/ws:src/a.ts",
      instanceId: "inst-a",
      type: "workspace-file",
      name: "a.ts",
      hostId: "host-1",
      workspacePath: "/ws",
      filePath: "src/a.ts",
    };
    expect(
      readEpicCanvasDragSourceData({
        kind: "workspace-file",
        epicId: "epic-1",
        viewTabId: "view-1",
        ref,
      }),
    ).toEqual({
      kind: "workspace-file",
      epicId: "epic-1",
      viewTabId: "view-1",
      ref,
    });
  });

  it("rejects malformed workspace file drag source data", () => {
    expect(readEpicCanvasDragSourceData({ kind: "workspace-file" })).toBeNull();
    // A ref of a different tile kind must not pass the workspace-file guard.
    expect(
      readEpicCanvasDragSourceData({
        kind: "workspace-file",
        epicId: "epic-1",
        viewTabId: "view-1",
        ref: {
          id: "chat-1",
          type: "chat",
          name: "Chat",
          hostId: "host-1",
        },
      }),
    ).toBeNull();
    // A workspace-file ref missing required path fields fails parsing.
    expect(
      readEpicCanvasDragSourceData({
        kind: "workspace-file",
        epicId: "epic-1",
        viewTabId: "view-1",
        ref: {
          id: "workspace-file:host-1:/ws:src/a.ts",
          type: "workspace-file",
          name: "a.ts",
          hostId: "host-1",
          workspacePath: "/ws",
        },
      }),
    ).toBeNull();
  });

  it("accepts left panel rail drag source data", () => {
    expect(
      readEpicCanvasDragSourceData({
        kind: "left-panel-rail-item",
        viewTabId: "tab-a",
        panelId: "chats",
        origin: "rail",
      }),
    ).toEqual({
      kind: "left-panel-rail-item",
      viewTabId: "tab-a",
      panelId: "chats",
      origin: "rail",
    });
    expect(
      readEpicCanvasDragSourceData({
        kind: "left-panel-rail-item",
        viewTabId: "tab-a",
        panelId: "artifacts",
        origin: "panel-section",
      }),
    ).toEqual({
      kind: "left-panel-rail-item",
      viewTabId: "tab-a",
      panelId: "artifacts",
      origin: "panel-section",
    });
  });

  it("rejects malformed left panel rail drag source data", () => {
    expect(
      readEpicCanvasDragSourceData({
        kind: "left-panel-rail-item",
        viewTabId: "tab-b",
        panelId: "",
        origin: "rail",
      }),
    ).toBeNull();
    expect(
      readEpicCanvasDragSourceData({
        kind: "left-panel-rail-item",
        viewTabId: "tab-b",
        panelId: "source-control",
        origin: "rail",
      }),
    ).toBeNull();
    expect(
      readEpicCanvasDragSourceData({
        kind: "left-panel-rail-item",
        panelId: "chats",
      }),
    ).toBeNull();
  });

  it("accepts artifact tab drop target data", () => {
    expect(
      readEpicCanvasDropTargetData({
        kind: "empty-shell",
        epicId: "epic-1",
        viewTabId: "view-1",
      }),
    ).toEqual({
      kind: "empty-shell",
      epicId: "epic-1",
      viewTabId: "view-1",
    });
    expect(
      readEpicCanvasDropTargetData({
        kind: "artifact-tab",
        viewTabId: "view-1",
        groupId: "group-1",
        tabId: "tab-1",
        index: 0,
      }),
    ).toEqual({
      kind: "artifact-tab",
      viewTabId: "view-1",
      groupId: "group-1",
      tabId: "tab-1",
      index: 0,
    });
    expect(
      readEpicCanvasDropTargetData({
        kind: "artifact-tab-strip-end",
        viewTabId: "view-1",
        groupId: "group-1",
        index: 2,
      }),
    ).toEqual({
      kind: "artifact-tab-strip-end",
      viewTabId: "view-1",
      groupId: "group-1",
      index: 2,
    });
    expect(
      readEpicCanvasDropTargetData({
        kind: "artifact-tab-group-body",
        viewTabId: "view-1",
        groupId: "group-1",
        tabCount: 3,
      }),
    ).toEqual({
      kind: "artifact-tab-group-body",
      viewTabId: "view-1",
      groupId: "group-1",
      tabCount: 3,
    });
    expect(
      readEpicCanvasDropTargetData({
        kind: "left-panel-rail-item",
        viewTabId: "tab-a",
        panelId: "artifacts",
        orientation: "vertical",
      }),
    ).toEqual({
      kind: "left-panel-rail-item",
      viewTabId: "tab-a",
      panelId: "artifacts",
      orientation: "vertical",
    });
    expect(
      readEpicCanvasDropTargetData({
        kind: "left-panel-rail-item",
        viewTabId: "tab-a",
        panelId: "artifacts",
        orientation: "horizontal",
      }),
    ).toEqual({
      kind: "left-panel-rail-item",
      viewTabId: "tab-a",
      panelId: "artifacts",
      orientation: "horizontal",
    });
    expect(
      readEpicCanvasDropTargetData({
        kind: "left-panel-rail-list",
        viewTabId: "tab-a",
      }),
    ).toEqual({
      kind: "left-panel-rail-list",
      viewTabId: "tab-a",
    });
    expect(
      readEpicCanvasDropTargetData({
        kind: "left-panel-body",
        viewTabId: "tab-a",
        panelId: "chats",
      }),
    ).toEqual({
      kind: "left-panel-body",
      viewTabId: "tab-a",
      panelId: "chats",
    });
  });

  it("accepts sidebar reparent row + panel drop target data", () => {
    expect(
      readEpicCanvasDropTargetData({
        kind: "sidebar-reparent-row",
        epicId: "epic-1",
        viewTabId: "view-1",
        nodeId: "node-1",
        panelId: "chats",
      }),
    ).toEqual({
      kind: "sidebar-reparent-row",
      epicId: "epic-1",
      viewTabId: "view-1",
      nodeId: "node-1",
      panelId: "chats",
    });
    expect(
      readEpicCanvasDropTargetData({
        kind: "sidebar-reparent-panel",
        epicId: "epic-1",
        viewTabId: "view-1",
        panelId: "artifacts",
      }),
    ).toEqual({
      kind: "sidebar-reparent-panel",
      epicId: "epic-1",
      viewTabId: "view-1",
      panelId: "artifacts",
    });
  });

  it("rejects malformed sidebar reparent drop target data", () => {
    // Missing nodeId on a row target.
    expect(
      readEpicCanvasDropTargetData({
        kind: "sidebar-reparent-row",
        epicId: "epic-1",
        viewTabId: "view-1",
        panelId: "chats",
      }),
    ).toBeNull();
    // A non-root-create panelId (the reparent target only spans chats/artifacts).
    expect(
      readEpicCanvasDropTargetData({
        kind: "sidebar-reparent-row",
        epicId: "epic-1",
        viewTabId: "view-1",
        nodeId: "node-1",
        panelId: "git-diff",
      }),
    ).toBeNull();
    expect(
      readEpicCanvasDropTargetData({
        kind: "sidebar-reparent-panel",
        epicId: "epic-1",
        viewTabId: "view-1",
        panelId: "terminals",
      }),
    ).toBeNull();
    // Missing scope.
    expect(
      readEpicCanvasDropTargetData({
        kind: "sidebar-reparent-panel",
        panelId: "chats",
      }),
    ).toBeNull();
  });

  it("rejects malformed artifact tab drop target data", () => {
    expect(readEpicCanvasDropTargetData(null)).toBeNull();
    expect(
      readEpicCanvasDropTargetData({
        kind: "artifact-tab",
        viewTabId: "view-1",
        groupId: "",
        tabId: "tab-1",
        index: 0,
      }),
    ).toBeNull();
    expect(
      readEpicCanvasDropTargetData({
        kind: "artifact-tab",
        viewTabId: "view-1",
        groupId: "group-1",
        tabId: "tab-1",
        index: "0",
      }),
    ).toBeNull();
    expect(
      readEpicCanvasDropTargetData({
        kind: "artifact-tab",
        viewTabId: "view-1",
        groupId: "group-1",
        tabId: "tab-1",
        index: 1.5,
      }),
    ).toBeNull();
    // Targets without their owning view-tab scope cannot be committed from
    // the root context and must be rejected.
    expect(
      readEpicCanvasDropTargetData({
        kind: "artifact-tab",
        groupId: "group-1",
        tabId: "tab-1",
        index: 0,
      }),
    ).toBeNull();
    expect(
      readEpicCanvasDropTargetData({
        kind: "empty-shell",
      }),
    ).toBeNull();
    expect(
      readEpicCanvasDropTargetData({
        kind: "artifact-tab-strip-end",
        viewTabId: "view-1",
        groupId: "group-1",
        index: -1,
      }),
    ).toBeNull();
    expect(
      readEpicCanvasDropTargetData({
        kind: "artifact-tab-strip-end",
        viewTabId: "view-1",
        groupId: "group-1",
        index: 1.5,
      }),
    ).toBeNull();
    expect(
      readEpicCanvasDropTargetData({
        kind: "artifact-tab-group-body",
        viewTabId: "view-1",
        groupId: "group-1",
      }),
    ).toBeNull();
    expect(
      readEpicCanvasDropTargetData({
        kind: "artifact-tab-group-body",
        viewTabId: "view-1",
        groupId: "group-1",
        tabCount: Number.POSITIVE_INFINITY,
      }),
    ).toBeNull();
    expect(
      readEpicCanvasDropTargetData({
        kind: "artifact-tab-group-body",
        viewTabId: "view-1",
        groupId: "group-1",
        tabCount: 1.5,
      }),
    ).toBeNull();
    expect(
      readEpicCanvasDropTargetData({
        kind: "left-panel-rail-item",
        panelId: "source-control",
      }),
    ).toBeNull();
    // No orientation is no axis to band the drop along, so the target is
    // unusable rather than silently vertical.
    expect(
      readEpicCanvasDropTargetData({
        kind: "left-panel-rail-item",
        viewTabId: "tab-a",
        panelId: "artifacts",
      }),
    ).toBeNull();
    expect(
      readEpicCanvasDropTargetData({
        kind: "left-panel-rail-item",
        viewTabId: "tab-a",
        panelId: "artifacts",
        orientation: "sideways",
      }),
    ).toBeNull();
    expect(
      readEpicCanvasDropTargetData({
        kind: "left-panel-body",
        viewTabId: "tab-a",
        panelId: "source-control",
      }),
    ).toBeNull();
    expect(
      readEpicCanvasDropTargetData({
        kind: "left-panel-body",
        panelId: "chats",
      }),
    ).toBeNull();
  });
});

describe("getLeftPanelRailDropPositionOnAxis", () => {
  // Width (36) and height (30) deliberately differ, so a call site that reads
  // the wrong extent for its axis lands on the wrong band instead of silently
  // agreeing.
  const rect = {
    left: 0,
    top: 10,
    width: 36,
    height: 30,
  };

  it("splits the x axis at the rect's WIDTH bands, not its height", () => {
    // 30% / 70% of the 36px width is 10.8 / 25.2; of the 30px height it is
    // 9 / 21. Offset 10 sits in the width's "before" band but the height's
    // "combine" band, and offset 22 sits in the width's "combine" band but
    // the height's "after" band - so a call site that reads the wrong extent
    // for its axis lands on the wrong band instead of silently agreeing.
    expect(
      getLeftPanelRailDropPositionOnAxis({ x: 10, y: 25 }, rect, "x"),
    ).toBe("before");
    expect(
      getLeftPanelRailDropPositionOnAxis({ x: 22, y: 25 }, rect, "x"),
    ).toBe("combine");
  });

  it("splits the y axis at the rect's HEIGHT into three bands - before, combine, after (L-168)", () => {
    // The outer 30% at each end reorders, and the middle 40% answers
    // "combine" - joining the two panels into a stack. Of the 30px height
    // that is offsets 0-8 before, 9-21 combine and 22-29 after; the width
    // (36px) would put the edges at 10.8 and 25.2 instead, so the boundary
    // rows also catch a call site reading the wrong extent.
    const expectedByOffset = [
      [0, "before"],
      [8, "before"],
      [9, "combine"],
      [21, "combine"],
      [22, "after"],
      [29, "after"],
    ] as const;
    for (const [offset, expected] of expectedByOffset) {
      expect(
        getLeftPanelRailDropPositionOnAxis(
          { x: 10, y: rect.top + offset },
          rect,
          "y",
        ),
      ).toBe(expected);
    }
  });
});

describe("getArtifactTabDropIndexFromPoint", () => {
  const rect = {
    left: 10,
    top: 0,
    width: 80,
    height: 20,
  };

  it("uses target tab midpoint for artifact tab targets", () => {
    const target = {
      kind: "artifact-tab",
      viewTabId: "view-1",
      groupId: "group-1",
      tabId: "tab-1",
      index: 2,
    } as const;
    expect(getArtifactTabDropIndexFromPoint(target, rect, 20)).toBe(2);
    expect(getArtifactTabDropIndexFromPoint(target, rect, 80)).toBe(3);
  });

  it("uses provided index for strip end targets", () => {
    expect(
      getArtifactTabDropIndexFromPoint(
        {
          kind: "artifact-tab-strip-end",
          viewTabId: "view-1",
          groupId: "group-1",
          index: 4,
        },
        null,
        0,
      ),
    ).toBe(4);
  });

  it("returns null for targets without tab strip indices", () => {
    expect(
      getArtifactTabDropIndexFromPoint(
        {
          kind: "left-panel-rail-list",
        },
        rect,
        20,
      ),
    ).toBeNull();
    expect(
      getArtifactTabDropIndexFromPoint(
        {
          kind: "left-panel-body",
          panelId: "chats",
        },
        rect,
        20,
      ),
    ).toBeNull();
    expect(
      getArtifactTabDropIndexFromPoint(
        {
          kind: "artifact-tab-group-body",
          viewTabId: "view-1",
          groupId: "group-1",
          tabCount: 4,
        },
        rect,
        20,
      ),
    ).toBeNull();
    expect(
      getArtifactTabDropIndexFromPoint(
        { kind: "empty-shell", epicId: "epic-1", viewTabId: "view-1" },
        rect,
        20,
      ),
    ).toBeNull();
  });
});

describe("getEpicCanvasDropPreview", () => {
  const rect = {
    left: 0,
    top: 0,
    width: 100,
    height: 100,
  };

  it("resolves tab strip preview from an artifact tab target", () => {
    expect(
      getEpicCanvasDropPreview(
        {
          kind: "artifact-tab",
          viewTabId: "view-1",
          groupId: "group-1",
          tabId: "tab-1",
          index: 1,
        },
        rect,
        { x: 80, y: 50 },
        false,
      ),
    ).toEqual({
      kind: "artifact-tab-strip",
      groupId: "group-1",
      index: 2,
    });
  });

  it("resolves group body preview from pointer edge position", () => {
    expect(
      getEpicCanvasDropPreview(
        {
          kind: "artifact-tab-group-body",
          viewTabId: "view-1",
          groupId: "group-1",
          tabCount: 2,
        },
        rect,
        { x: 5, y: 50 },
        false,
      ),
    ).toEqual({
      kind: "artifact-tab-group-body",
      groupId: "group-1",
      position: "left",
    });
  });

  it("resolves empty shell preview", () => {
    expect(
      getEpicCanvasDropPreview(
        { kind: "empty-shell", epicId: "epic-1", viewTabId: "view-1" },
        null,
        { x: 0, y: 0 },
        false,
      ),
    ).toEqual({
      kind: "empty-shell",
      viewTabId: "view-1",
    });
  });

  it("resolves left panel rail preview", () => {
    expect(
      getEpicCanvasDropPreview(
        {
          kind: "left-panel-rail-item",
          panelId: "artifacts",
          orientation: "vertical",
        },
        rect,
        { x: 20, y: 80 },
        false,
      ),
    ).toEqual({
      kind: "left-panel-rail",
      panelId: "artifacts",
      position: "after",
    });
    expect(
      getEpicCanvasDropPreview(
        {
          kind: "left-panel-rail-list",
        },
        rect,
        { x: 20, y: 50 },
        false,
      ),
    ).toEqual({
      kind: "left-panel-rail-list",
    });
    // A drop anywhere on the open body means INTO the displayed stack
    // (L-182): the same combine preview a middle-band drop on its rail icon
    // takes, aimed at the target's own panelId (the stack's top).
    expect(
      getEpicCanvasDropPreview(
        {
          kind: "left-panel-body",
          panelId: "chats",
        },
        rect,
        { x: 20, y: 50 },
        false,
      ),
    ).toEqual({
      kind: "left-panel-rail",
      panelId: "chats",
      position: "combine",
    });
  });

  // R5R-08: an unmeasured rail slot commits nothing rather than defaulting to
  // "before" - the caller could not read where the pointer actually was.
  it("returns no preview for a left panel rail item with no measured rect", () => {
    expect(
      getEpicCanvasDropPreview(
        {
          kind: "left-panel-rail-item",
          panelId: "artifacts",
          orientation: "vertical",
        },
        null,
        { x: 20, y: 50 },
        false,
      ),
    ).toBeNull();
  });

  /**
   * The corridor's WIRING, not its geometry.
   *
   * `pane-corridor-geometry.test.ts` covers the pure function exhaustively, but
   * nothing asserted that `getEpicCanvasDropPreview` actually consults it - the
   * `useNeutralCorridor === true` branch had no direct test, so the pure
   * geometry could have been correct while the consumer ignored it. These are
   * the two answers that differ between the branches.
   */
  describe("neutral corridor wiring", () => {
    const paneRect = { left: 0, top: 0, width: 600, height: 600 };
    const bodyTarget = {
      kind: "artifact-tab-group-body",
      viewTabId: "view-1",
      groupId: "group-1",
      tabCount: 2,
    } as const;

    it("returns NULL in the corridor when the corridor is enabled", () => {
      // Between the 48px edge band and the 140px centre box on a 600px pane.
      const corridorPoint = { x: 120, y: 300 };
      expect(
        getEpicCanvasDropPreview(bodyTarget, paneRect, corridorPoint, true),
      ).toBeNull();
    });

    it("still commits a split at the same point with the corridor disabled", () => {
      // The same coordinates under the legacy nearest-edge fallback resolve to
      // a position - which is precisely the behaviour change the corridor makes,
      // and why the flag has to be passed explicitly at every call site.
      const corridorPoint = { x: 120, y: 300 };
      expect(
        getEpicCanvasDropPreview(bodyTarget, paneRect, corridorPoint, false),
      ).not.toBeNull();
    });

    it("resolves the centre box to center with the corridor enabled", () => {
      expect(
        getEpicCanvasDropPreview(
          bodyTarget,
          paneRect,
          { x: 300, y: 300 },
          true,
        ),
      ).toEqual({
        kind: "artifact-tab-group-body",
        groupId: "group-1",
        position: "center",
      });
    });

    it("resolves the edge band to a split with the corridor enabled", () => {
      expect(
        getEpicCanvasDropPreview(bodyTarget, paneRect, { x: 10, y: 300 }, true),
      ).toEqual({
        kind: "artifact-tab-group-body",
        groupId: "group-1",
        position: "left",
      });
    });
  });
});

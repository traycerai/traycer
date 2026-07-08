import { describe, expect, it } from "vitest";
import {
  getArtifactTabDropIndexFromPoint,
  getEdgeDropPositionFromPoint,
  getEmptyShellDropId,
  getEpicCanvasDropPreview,
  getLeftPanelGroupDropPreview,
  getLeftPanelRailDropPositionFromPoint,
  getSidebarReparentPanelDropId,
  getSidebarReparentRowDropId,
  readEpicCanvasDragSourceData,
  readEpicCanvasDropTargetData,
  type EpicCanvasDropTargetData,
  type LeftPanelSectionRect,
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
        nodeId: "node-1",
      }),
    ).toEqual({
      kind: "sidebar-node",
      epicId: "epic-1",
      viewTabId: "view-1",
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
        panelId: "chats",
        origin: "rail",
      }),
    ).toEqual({
      kind: "left-panel-rail-item",
      panelId: "chats",
      origin: "rail",
    });
    expect(
      readEpicCanvasDragSourceData({
        kind: "left-panel-rail-item",
        panelId: "artifacts",
        origin: "panel-section",
      }),
    ).toEqual({
      kind: "left-panel-rail-item",
      panelId: "artifacts",
      origin: "panel-section",
    });
  });

  it("rejects malformed left panel rail drag source data", () => {
    expect(
      readEpicCanvasDragSourceData({
        kind: "left-panel-rail-item",
        panelId: "",
        origin: "rail",
      }),
    ).toBeNull();
    expect(
      readEpicCanvasDragSourceData({
        kind: "left-panel-rail-item",
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
        panelId: "artifacts",
      }),
    ).toEqual({
      kind: "left-panel-rail-item",
      panelId: "artifacts",
    });
    expect(
      readEpicCanvasDropTargetData({
        kind: "left-panel-rail-list",
      }),
    ).toEqual({
      kind: "left-panel-rail-list",
    });
    expect(
      readEpicCanvasDropTargetData({
        kind: "left-panel-group",
        panelIds: ["chats", "git-diff"],
      }),
    ).toEqual({
      kind: "left-panel-group",
      panelIds: ["chats", "git-diff"],
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
    expect(
      readEpicCanvasDropTargetData({
        kind: "left-panel-group",
        panelIds: ["chats", "source-control"],
      }),
    ).toBeNull();
    expect(
      readEpicCanvasDropTargetData({
        kind: "left-panel-group",
        panelIds: ["chats", "chats"],
      }),
    ).toBeNull();
  });
});

describe("getLeftPanelRailDropPositionFromPoint", () => {
  const rect = {
    left: 0,
    top: 10,
    width: 36,
    height: 30,
  };

  it("uses top and bottom bands for reorder positions", () => {
    expect(getLeftPanelRailDropPositionFromPoint({ x: 10, y: 11 }, rect)).toBe(
      "before",
    );
    expect(getLeftPanelRailDropPositionFromPoint({ x: 10, y: 39 }, rect)).toBe(
      "after",
    );
  });

  it("uses the middle band for combine", () => {
    expect(getLeftPanelRailDropPositionFromPoint({ x: 10, y: 25 }, rect)).toBe(
      "combine",
    );
    expect(getLeftPanelRailDropPositionFromPoint({ x: 10, y: 25 }, null)).toBe(
      "combine",
    );
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
          kind: "left-panel-group",
          panelIds: ["chats", "git-diff"],
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
      ),
    ).toEqual({
      kind: "empty-shell",
    });
  });

  it("resolves left panel rail preview", () => {
    expect(
      getEpicCanvasDropPreview(
        {
          kind: "left-panel-rail-item",
          panelId: "artifacts",
        },
        rect,
        { x: 20, y: 50 },
      ),
    ).toEqual({
      kind: "left-panel-rail",
      panelId: "artifacts",
      position: "combine",
    });
    expect(
      getEpicCanvasDropPreview(
        {
          kind: "left-panel-rail-list",
        },
        rect,
        { x: 20, y: 50 },
      ),
    ).toEqual({
      kind: "left-panel-rail-list",
    });
    expect(
      getEpicCanvasDropPreview(
        {
          kind: "left-panel-group",
          panelIds: ["chats", "git-diff"],
        },
        rect,
        { x: 20, y: 50 },
      ),
    ).toBeNull();
  });

  it("resolves grouped left panel insertion by nearest section boundary", () => {
    const target: Extract<
      EpicCanvasDropTargetData,
      { readonly kind: "left-panel-group" }
    > = {
      kind: "left-panel-group",
      panelIds: ["chats", "git-diff", "file-tree"],
    };
    const sectionRects: ReadonlyArray<LeftPanelSectionRect> = [
      {
        panelId: "chats",
        rect: { left: 0, top: 0, width: 320, height: 700 },
      },
      {
        panelId: "git-diff",
        rect: { left: 0, top: 700, width: 320, height: 420 },
      },
      {
        panelId: "file-tree",
        rect: { left: 0, top: 1120, width: 320, height: 300 },
      },
    ];

    expect(
      getLeftPanelGroupDropPreview(target, sectionRects, { x: 20, y: 620 }),
    ).toEqual({
      kind: "left-panel-section",
      panelId: "git-diff",
      position: "before",
    });
    expect(
      getLeftPanelGroupDropPreview(target, sectionRects, { x: 20, y: 1370 }),
    ).toEqual({
      kind: "left-panel-section",
      panelId: "file-tree",
      position: "after",
    });
    expect(
      getLeftPanelGroupDropPreview(target, sectionRects, { x: 20, y: 1080 }),
    ).toEqual({
      kind: "left-panel-section",
      panelId: "file-tree",
      position: "before",
    });
  });

  it("resolves grouped left panel insertion when the dragged source section is omitted", () => {
    const target: Extract<
      EpicCanvasDropTargetData,
      { readonly kind: "left-panel-group" }
    > = {
      kind: "left-panel-group",
      panelIds: ["chats", "artifacts"],
    };

    expect(
      getLeftPanelGroupDropPreview(
        target,
        [
          {
            panelId: "artifacts",
            rect: { left: 0, top: 300, width: 320, height: 400 },
          },
        ],
        { x: 20, y: 310 },
      ),
    ).toEqual({
      kind: "left-panel-section",
      panelId: "artifacts",
      position: "before",
    });
  });

  it("returns no grouped left panel insertion when no sections are measured", () => {
    const target: Extract<
      EpicCanvasDropTargetData,
      { readonly kind: "left-panel-group" }
    > = {
      kind: "left-panel-group",
      panelIds: ["chats"],
    };

    expect(
      getLeftPanelGroupDropPreview(target, [], { x: 20, y: 20 }),
    ).toBeNull();
  });
});

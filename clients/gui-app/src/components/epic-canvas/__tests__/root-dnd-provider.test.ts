import "../../../../__tests__/test-browser-apis";
import { beforeEach, describe, expect, it } from "vitest";
import type { Active, ClientRect, DroppableContainer } from "@dnd-kit/core";
import { epicRootCollisionDetection } from "@/components/epic-canvas/dnd/root-dnd-collision";
import {
  epicCanvasDropPreviewEqual,
  useEpicDndStore,
} from "@/components/epic-canvas/dnd/dnd-store";

const EPIC_ID = "provider-epic";
const VIEW_TAB_ID = "provider-view-tab";

const ARTIFACT_TAB_SOURCE_DATA = {
  kind: "artifact-tab",
  epicId: EPIC_ID,
  viewTabId: VIEW_TAB_ID,
  sourceGroupId: "group-a",
  tabId: "tile-1",
  isPreview: false,
} as const;

const RAIL_SOURCE_DATA = {
  kind: "left-panel-rail-item",
  panelId: "artifacts",
  origin: "rail",
} as const;

const HEADER_TAB_SOURCE_DATA = {
  kind: "header-tab",
  tabKind: "epic",
  tabId: "header-tab-1",
  index: 0,
} as const;

const SIDEBAR_NODE_SOURCE_DATA = {
  kind: "sidebar-node",
  epicId: EPIC_ID,
  viewTabId: VIEW_TAB_ID,
  nodeId: "node-a",
} as const;

const TERMINAL_TILE_SOURCE_DATA = {
  kind: "terminal-tile",
  epicId: EPIC_ID,
  viewTabId: VIEW_TAB_ID,
  tile: {
    id: "term-1",
    instanceId: "inst-term-1",
    type: "terminal",
    name: "Terminal",
    titleSource: "manual",
    hostId: "host-1",
    cwd: "/repo",
  },
} as const;

function makeRect(input: {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}): ClientRect {
  return {
    width: input.width,
    height: input.height,
    top: input.top,
    left: input.left,
    right: input.left + input.width,
    bottom: input.top + input.height,
  };
}

/** A rect that contains the shared test pointer at (50, 50). */
const HIT_RECT = makeRect({ left: 0, top: 0, width: 100, height: 100 });
const POINTER = { x: 50, y: 50 };

interface TestDroppable {
  readonly id: string;
  readonly data: Record<string, unknown>;
  readonly rect: ClientRect;
}

function makeActive(data: Record<string, unknown>): Active {
  return {
    id: "active-drag",
    data: { current: data },
    rect: { current: { initial: null, translated: null } },
  };
}

function makeCollisionArgs(input: {
  readonly activeData: Record<string, unknown>;
  readonly droppables: ReadonlyArray<TestDroppable>;
  readonly pointer: { readonly x: number; readonly y: number } | null;
}) {
  const droppableContainers = input.droppables.map<DroppableContainer>(
    (droppable) => ({
      id: droppable.id,
      key: droppable.id,
      data: { current: droppable.data },
      disabled: false,
      node: { current: null },
      rect: { current: droppable.rect },
    }),
  );
  return {
    active: makeActive(input.activeData),
    collisionRect: makeRect({ left: 40, top: 40, width: 20, height: 20 }),
    droppableRects: new Map<string | number, ClientRect>(
      input.droppables.map((droppable) => [droppable.id, droppable.rect]),
    ),
    droppableContainers,
    pointerCoordinates: input.pointer,
  };
}

function droppableOfKind(id: string, kind: string): TestDroppable {
  return { id, data: { kind }, rect: HIT_RECT };
}

function hitIds(
  collisions: ReadonlyArray<{ readonly id: string | number }>,
): ReadonlyArray<string | number> {
  return collisions.map((collision) => collision.id);
}

describe("epicRootCollisionDetection", () => {
  it("applies the priority ladder over overlapping compatible targets", () => {
    const droppables = [
      droppableOfKind("body", "artifact-tab-group-body"),
      droppableOfKind("shell", "empty-shell"),
      droppableOfKind("strip-end", "artifact-tab-strip-end"),
      droppableOfKind("tab", "artifact-tab"),
      droppableOfKind("header-slot", "header-tab-slot"),
    ];

    expect(
      hitIds(
        epicRootCollisionDetection(
          makeCollisionArgs({
            activeData: ARTIFACT_TAB_SOURCE_DATA,
            droppables,
            pointer: POINTER,
          }),
        ),
      ),
    ).toEqual(["header-slot"]);

    expect(
      hitIds(
        epicRootCollisionDetection(
          makeCollisionArgs({
            activeData: ARTIFACT_TAB_SOURCE_DATA,
            droppables: droppables.slice(0, 4),
            pointer: POINTER,
          }),
        ),
      ),
    ).toEqual(["tab"]);

    expect(
      hitIds(
        epicRootCollisionDetection(
          makeCollisionArgs({
            activeData: ARTIFACT_TAB_SOURCE_DATA,
            droppables: droppables.slice(0, 3),
            pointer: POINTER,
          }),
        ),
      ),
    ).toEqual(["strip-end"]);
  });

  it("returns every hit in the shared lowest tier (body + empty shell)", () => {
    const collisions = epicRootCollisionDetection(
      makeCollisionArgs({
        activeData: ARTIFACT_TAB_SOURCE_DATA,
        droppables: [
          droppableOfKind("body", "artifact-tab-group-body"),
          droppableOfKind("shell", "empty-shell"),
        ],
        pointer: POINTER,
      }),
    );
    expect([...hitIds(collisions)].sort()).toEqual(["body", "shell"]);
  });

  it("filters targets incompatible with the active source kind", () => {
    // A rail drag never lights up canvas surfaces...
    expect(
      hitIds(
        epicRootCollisionDetection(
          makeCollisionArgs({
            activeData: RAIL_SOURCE_DATA,
            droppables: [
              droppableOfKind("body", "artifact-tab-group-body"),
              droppableOfKind("rail-list", "left-panel-rail-list"),
              droppableOfKind("rail-item", "left-panel-rail-item"),
            ],
            pointer: POINTER,
          }),
        ),
      ),
    ).toEqual(["rail-item"]);

    // ...a canvas tab drag never lights up the rail...
    expect(
      epicRootCollisionDetection(
        makeCollisionArgs({
          activeData: ARTIFACT_TAB_SOURCE_DATA,
          droppables: [
            droppableOfKind("rail-item", "left-panel-rail-item"),
            droppableOfKind("rail-group", "left-panel-group"),
          ],
          pointer: POINTER,
        }),
      ),
    ).toEqual([]);

    // ...and a header-tab reorder only hits header slots.
    expect(
      hitIds(
        epicRootCollisionDetection(
          makeCollisionArgs({
            activeData: HEADER_TAB_SOURCE_DATA,
            droppables: [
              droppableOfKind("tab", "artifact-tab"),
              droppableOfKind("header-slot", "header-tab-slot"),
            ],
            pointer: POINTER,
          }),
        ),
      ),
    ).toEqual(["header-slot"]);
  });

  it("lets only the sidebar-node source resolve sidebar reparent targets", () => {
    const droppables = [
      droppableOfKind("row", "sidebar-reparent-row"),
      droppableOfKind("panel", "sidebar-reparent-panel"),
    ];
    // A sidebar-node over an overlapping row + panel: the row wins (it ranks
    // above the panel) so empty space picks the panel, a row picks the row.
    expect(
      hitIds(
        epicRootCollisionDetection(
          makeCollisionArgs({
            activeData: SIDEBAR_NODE_SOURCE_DATA,
            droppables,
            pointer: POINTER,
          }),
        ),
      ),
    ).toEqual(["row"]);
    expect(
      hitIds(
        epicRootCollisionDetection(
          makeCollisionArgs({
            activeData: SIDEBAR_NODE_SOURCE_DATA,
            droppables: [droppableOfKind("panel", "sidebar-reparent-panel")],
            pointer: POINTER,
          }),
        ),
      ),
    ).toEqual(["panel"]);
    // A non-sidebar canvas source (terminal tile) must NOT resolve the sidebar
    // reparent targets - it can only open as a tile.
    expect(
      epicRootCollisionDetection(
        makeCollisionArgs({
          activeData: TERMINAL_TILE_SOURCE_DATA,
          droppables,
          pointer: POINTER,
        }),
      ),
    ).toEqual([]);
  });

  it("keeps canvas open-as-tile targets for the sidebar-node source", () => {
    // The sidebar-node drag still resolves the canvas chrome (a tab beats the
    // body) so release-on-canvas open-as-tile keeps working alongside reparent.
    expect(
      hitIds(
        epicRootCollisionDetection(
          makeCollisionArgs({
            activeData: SIDEBAR_NODE_SOURCE_DATA,
            droppables: [
              droppableOfKind("body", "artifact-tab-group-body"),
              droppableOfKind("tab", "artifact-tab"),
            ],
            pointer: POINTER,
          }),
        ),
      ),
    ).toEqual(["tab"]);
  });

  it("returns no hits for unknown sources or missing pointers", () => {
    const droppables = [droppableOfKind("tab", "artifact-tab")];

    expect(
      epicRootCollisionDetection(
        makeCollisionArgs({
          activeData: { kind: "mystery-source" },
          droppables,
          pointer: POINTER,
        }),
      ),
    ).toEqual([]);

    expect(
      epicRootCollisionDetection(
        makeCollisionArgs({
          activeData: ARTIFACT_TAB_SOURCE_DATA,
          droppables,
          pointer: null,
        }),
      ),
    ).toEqual([]);
  });

  it("ignores hits whose pointer lies outside the target rect", () => {
    expect(
      epicRootCollisionDetection(
        makeCollisionArgs({
          activeData: ARTIFACT_TAB_SOURCE_DATA,
          droppables: [
            {
              id: "tab",
              data: { kind: "artifact-tab" },
              rect: makeRect({ left: 500, top: 500, width: 40, height: 20 }),
            },
          ],
          pointer: POINTER,
        }),
      ),
    ).toEqual([]);
  });
});

describe("dnd-store preview tick suppression", () => {
  beforeEach(() => {
    useEpicDndStore.getState().dragEnded();
  });

  it("suppresses store writes for structurally equal previews", () => {
    useEpicDndStore.getState().dropPreviewChanged({
      kind: "artifact-tab-strip",
      groupId: "g",
      index: 1,
    });
    const before = useEpicDndStore.getState();

    useEpicDndStore.getState().dropPreviewChanged({
      kind: "artifact-tab-strip",
      groupId: "g",
      index: 1,
    });

    expect(useEpicDndStore.getState()).toBe(before);

    useEpicDndStore.getState().dropPreviewChanged({
      kind: "artifact-tab-strip",
      groupId: "g",
      index: 2,
    });

    expect(useEpicDndStore.getState()).not.toBe(before);
    expect(useEpicDndStore.getState().dropPreview).toEqual({
      kind: "artifact-tab-strip",
      groupId: "g",
      index: 2,
    });
  });

  it("treats matching left-panel and empty-shell previews as equal", () => {
    expect(
      epicCanvasDropPreviewEqual(
        { kind: "left-panel-rail", panelId: "chats", position: "combine" },
        { kind: "left-panel-rail", panelId: "chats", position: "combine" },
      ),
    ).toBe(true);
    expect(
      epicCanvasDropPreviewEqual(
        { kind: "left-panel-rail", panelId: "chats", position: "combine" },
        { kind: "left-panel-rail", panelId: "chats", position: "before" },
      ),
    ).toBe(false);
    expect(
      epicCanvasDropPreviewEqual(
        { kind: "left-panel-section", panelId: "chats", position: "before" },
        { kind: "left-panel-section", panelId: "chats", position: "before" },
      ),
    ).toBe(true);
    expect(
      epicCanvasDropPreviewEqual(
        { kind: "left-panel-rail-list" },
        { kind: "left-panel-rail-list" },
      ),
    ).toBe(true);
    expect(
      epicCanvasDropPreviewEqual(
        { kind: "empty-shell" },
        { kind: "empty-shell" },
      ),
    ).toBe(true);
    expect(epicCanvasDropPreviewEqual({ kind: "empty-shell" }, null)).toBe(
      false,
    );
    expect(
      epicCanvasDropPreviewEqual(
        { kind: "artifact-tab-group-body", groupId: "g", position: "left" },
        { kind: "artifact-tab-group-body", groupId: "g", position: "left" },
      ),
    ).toBe(true);
    expect(
      epicCanvasDropPreviewEqual(
        { kind: "artifact-tab-group-body", groupId: "g", position: "left" },
        { kind: "artifact-tab-strip", groupId: "g", index: 0 },
      ),
    ).toBe(false);
  });

  it("keeps state identity when dragEnded fires with nothing active", () => {
    const before = useEpicDndStore.getState();
    useEpicDndStore.getState().dragEnded();
    expect(useEpicDndStore.getState()).toBe(before);
  });
});

describe("sidebar reparent preview fields", () => {
  beforeEach(() => {
    useEpicDndStore.getState().dragEnded();
  });

  it("records a row target and suppresses equal writes", () => {
    useEpicDndStore.getState().sidebarReparentPreviewChanged({
      targetNodeId: "node-a",
      rootPanelId: null,
    });
    expect(useEpicDndStore.getState().reparentTargetNodeId).toBe("node-a");
    expect(useEpicDndStore.getState().reparentRootPanelId).toBeNull();

    const before = useEpicDndStore.getState();
    useEpicDndStore.getState().sidebarReparentPreviewChanged({
      targetNodeId: "node-a",
      rootPanelId: null,
    });
    expect(useEpicDndStore.getState()).toBe(before);
  });

  it("records a panel root target", () => {
    useEpicDndStore.getState().sidebarReparentPreviewChanged({
      targetNodeId: null,
      rootPanelId: "chats",
    });
    expect(useEpicDndStore.getState().reparentRootPanelId).toBe("chats");
    expect(useEpicDndStore.getState().reparentTargetNodeId).toBeNull();
  });

  it("clears both reparent fields on drag end", () => {
    useEpicDndStore.getState().sidebarReparentPreviewChanged({
      targetNodeId: "node-a",
      rootPanelId: null,
    });
    useEpicDndStore.getState().dragEnded();
    expect(useEpicDndStore.getState().reparentTargetNodeId).toBeNull();
    expect(useEpicDndStore.getState().reparentRootPanelId).toBeNull();
  });
});

import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commitHeaderStripDrop,
  commitResolvedCanvasDrop,
  isLeftPanelDropNoop,
  resolveCanvasDropPreview,
  resolveLeftPanelGroupsForDrop,
} from "@/components/epic-canvas/dnd/root-dnd-commits";
import type { EpicCanvasDragSourceData } from "@/components/epic-canvas/dnd/dnd";
import {
  DEFAULT_LEFT_PANEL_GROUPS,
  moveLeftPanelGroup,
  useLeftPanelStore,
} from "@/stores/epics/left-panel-store";
import { useEpicSidebarExpansionStore } from "@/stores/epics/epic-sidebar-expansion-store";
import { makeGitFileDiffTile } from "@/lib/git/git-diff-tile";
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";

interface TabStripMoveArgs {
  readonly sourcePaneId: string;
  readonly tabId: string;
  readonly targetPaneId: string;
  readonly targetIndex: number;
}

interface TabSplitArgs {
  readonly sourcePaneId: string;
  readonly tabId: string;
  readonly targetPaneId: string;
  readonly position: string;
}

interface TestCanvasStore {
  promotePreviewInTab: () => void;
  openTileInTab: (viewTabId: string, node: unknown) => void;
  prepareOpenTileInTabFocusTarget: (viewTabId: string, node: unknown) => null;
  insertNodeOnTabStrip: (
    viewTabId: string,
    groupId: string,
    index: number,
    node: unknown,
  ) => void;
  prepareInsertNodeOnTabStripFocusTarget: (
    viewTabId: string,
    groupId: string,
    index: number,
    node: unknown,
  ) => null;
  moveTabOnTabStrip: (viewTabId: string, args: TabStripMoveArgs) => void;
  prepareMoveActiveTabOnTabStripFocusTarget: (
    viewTabId: string,
    args: TabStripMoveArgs,
  ) => null;
  splitPaneWithNode: (
    viewTabId: string,
    groupId: string,
    position: string,
    node: unknown,
  ) => void;
  prepareSplitPaneWithNodeFocusTarget: (
    viewTabId: string,
    groupId: string,
    position: string,
    node: unknown,
  ) => null;
  splitPaneWithTab: (viewTabId: string, args: TabSplitArgs) => void;
  prepareSplitPaneWithTabFocusTarget: (
    viewTabId: string,
    args: TabSplitArgs,
  ) => null;
  openTileInNewTab: (
    epicId: string,
    node: unknown,
    insertIndex: number | null,
  ) => string | null;
  tearOffTabIntoNewHeaderTab: (args: {
    readonly sourceTabId: string;
    readonly sourcePaneId: string;
    readonly sourceTileTabId: string;
    readonly insertIndex: number;
  }) => string | null;
  moveOpenTab: (tabId: string, index: number) => void;
}

const testState = vi.hoisted(() => ({
  canvasStore: {
    promotePreviewInTab: vi.fn(),
    openTileInTab: vi.fn(),
    prepareOpenTileInTabFocusTarget: vi.fn((viewTabId, node) => {
      testState.canvasStore.openTileInTab(viewTabId, node);
      return null;
    }),
    insertNodeOnTabStrip: vi.fn(),
    prepareInsertNodeOnTabStripFocusTarget: vi.fn(
      (viewTabId, groupId, index, node) => {
        testState.canvasStore.insertNodeOnTabStrip(
          viewTabId,
          groupId,
          index,
          node,
        );
        return null;
      },
    ),
    moveTabOnTabStrip:
      vi.fn<(viewTabId: string, args: TabStripMoveArgs) => void>(),
    prepareMoveActiveTabOnTabStripFocusTarget: vi.fn(
      (viewTabId: string, args: TabStripMoveArgs) => {
        testState.canvasStore.moveTabOnTabStrip(viewTabId, args);
        return null;
      },
    ),
    splitPaneWithNode: vi.fn(),
    prepareSplitPaneWithNodeFocusTarget: vi.fn(
      (viewTabId, groupId, position, node) => {
        testState.canvasStore.splitPaneWithNode(
          viewTabId,
          groupId,
          position,
          node,
        );
        return null;
      },
    ),
    splitPaneWithTab: vi.fn<(viewTabId: string, args: TabSplitArgs) => void>(),
    prepareSplitPaneWithTabFocusTarget: vi.fn(
      (viewTabId: string, args: TabSplitArgs) => {
        testState.canvasStore.splitPaneWithTab(viewTabId, args);
        return null;
      },
    ),
    openTileInNewTab: vi.fn<
      (
        epicId: string,
        node: unknown,
        insertIndex: number | null,
      ) => string | null
    >(() => null),
    tearOffTabIntoNewHeaderTab: vi.fn<
      (args: {
        readonly sourceTabId: string;
        readonly sourcePaneId: string;
        readonly sourceTileTabId: string;
        readonly insertIndex: number;
      }) => string | null
    >(() => null),
    moveOpenTab: vi.fn<(tabId: string, index: number) => void>(),
  } satisfies TestCanvasStore,
}));

vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: {
    getState: () => testState.canvasStore,
  },
}));

const EPIC_ID = "commits-epic";
const VIEW_TAB_ID = "commits-view-tab";
const TEST_HOST_ID = "test-host";
const GIT_DIFF_TILE = makeGitFileDiffTile({
  hostId: TEST_HOST_ID,
  runningDir: "/repo",
  filePath: "src/app.ts",
  stage: "unstaged",
  repositoryContext: null,
});
const TERMINAL_TILE = {
  id: "term-1",
  instanceId: "inst-term-1",
  type: "terminal",
  name: "Terminal",
  titleSource: "manual",
  hostId: TEST_HOST_ID,
  cwd: "/repo",
} as const;

const rawNestedFocus: NavigateNestedFocus = (_epicId, _tabId, prepare) =>
  prepare();

function railSource(
  panelId: "artifacts" | "git-diff" | "file-tree",
  origin: "rail" | "panel-section",
): Extract<
  EpicCanvasDragSourceData,
  { readonly kind: "left-panel-rail-item" }
> {
  return { kind: "left-panel-rail-item", panelId, origin };
}

function makeRectElement(
  id: string,
  rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
): Element {
  const element = document.createElement("section");
  element.setAttribute("data-left-panel-section-id", id);
  element.getBoundingClientRect = () => DOMRect.fromRect(rect);
  return element;
}

function resetStores(): void {
  window.localStorage.clear();
  testState.canvasStore.openTileInNewTab = vi.fn(() => null);
  testState.canvasStore.tearOffTabIntoNewHeaderTab = vi.fn(() => null);
  testState.canvasStore.moveOpenTab = vi.fn();
  testState.canvasStore.moveTabOnTabStrip =
    vi.fn<(viewTabId: string, args: TabStripMoveArgs) => void>();
  testState.canvasStore.splitPaneWithTab =
    vi.fn<(viewTabId: string, args: TabSplitArgs) => void>();
  useLeftPanelStore.setState({
    activePanelIdByTabId: {},
    panelGroups: DEFAULT_LEFT_PANEL_GROUPS,
    mainCollapsedByTabId: {},
    panelSectionCollapsedByPanelId: {},
    commentsPanelRevealedByTabId: {},
    localRootCreatePendingByEpicPanel: {},
    acknowledgedRootCreatePendingByEpicPanel: {},
  });
  useEpicSidebarExpansionStore.setState({
    userExpandedByScope: {},
    userCollapsedByScope: {},
  });
}

describe("root dnd commits - left panel", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("extracts a grouped section to the rail end from the rail background", () => {
    useLeftPanelStore
      .getState()
      .applyPanelGroups(
        moveLeftPanelGroup(
          useLeftPanelStore.getState().getPanelGroups(),
          "artifacts",
          "chats",
          "combine",
        ),
      );
    const source = railSource("artifacts", "panel-section");
    const target = { kind: "left-panel-rail-list" } as const;
    const preview = resolveCanvasDropPreview({
      source,
      target,
      point: { x: 20, y: 220 },
      targetRect: null,
      targetElement: null,
      activeRect: null,
    });

    expect(isLeftPanelDropNoop(source, preview)).toBe(false);
    commitResolvedCanvasDrop({ source, target, preview }, rawNestedFocus);

    expect(useLeftPanelStore.getState().getPanelGroups()).toEqual([
      { panelIds: ["chats"] },
      { panelIds: ["terminals"] },
      { panelIds: ["git-diff"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
      { panelIds: ["artifacts"] },
    ]);
  });

  it("flags same-group middle-band section drops as no-ops", () => {
    useLeftPanelStore
      .getState()
      .applyPanelGroups(
        moveLeftPanelGroup(
          useLeftPanelStore.getState().getPanelGroups(),
          "artifacts",
          "chats",
          "combine",
        ),
      );
    const source = railSource("artifacts", "panel-section");
    const target = {
      kind: "left-panel-rail-item",
      panelId: "chats",
    } as const;
    const preview = resolveCanvasDropPreview({
      source,
      target,
      point: { x: 18, y: 18 },
      targetRect: { left: 0, top: 0, width: 36, height: 36 },
      targetElement: null,
      activeRect: null,
    });

    expect(preview).toEqual({
      kind: "left-panel-rail",
      panelId: "chats",
      position: "combine",
    });
    expect(isLeftPanelDropNoop(source, preview)).toBe(true);
  });

  it("inserts a rail group into a single-panel group via section bounds", () => {
    useLeftPanelStore.setState({
      panelGroups: [
        { panelIds: ["chats"] },
        { panelIds: ["artifacts"] },
        { panelIds: ["terminals"] },
        { panelIds: ["git-diff"] },
        { panelIds: ["file-tree"] },
        { panelIds: ["sharing"] },
        { panelIds: ["comments"] },
      ],
    });
    const groupElement = document.createElement("div");
    groupElement.append(
      makeRectElement("chats", { x: 0, y: 0, width: 320, height: 900 }),
    );
    const source = railSource("file-tree", "rail");
    const target = {
      kind: "left-panel-group",
      panelIds: ["chats"],
    } as const;
    const preview = resolveCanvasDropPreview({
      source,
      target,
      point: { x: 120, y: 760 },
      targetRect: null,
      targetElement: groupElement,
      activeRect: null,
    });

    commitResolvedCanvasDrop({ source, target, preview }, rawNestedFocus);

    expect(useLeftPanelStore.getState().getPanelGroups()).toEqual([
      { panelIds: ["chats", "file-tree"] },
      { panelIds: ["artifacts"] },
      { panelIds: ["terminals"] },
      { panelIds: ["git-diff"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
    ]);
  });

  it("inserts a rail group at the nearest grouped-section boundary", () => {
    useLeftPanelStore
      .getState()
      .applyPanelGroups(
        moveLeftPanelGroup(
          useLeftPanelStore.getState().getPanelGroups(),
          "artifacts",
          "chats",
          "combine",
        ),
      );
    const groupElement = document.createElement("div");
    groupElement.append(
      makeRectElement("chats", { x: 0, y: 0, width: 320, height: 300 }),
      makeRectElement("artifacts", { x: 0, y: 300, width: 320, height: 300 }),
    );
    const source = railSource("git-diff", "rail");
    const target = {
      kind: "left-panel-group",
      panelIds: ["chats", "artifacts"],
    } as const;
    const preview = resolveCanvasDropPreview({
      source,
      target,
      point: { x: 20, y: 310 },
      targetRect: null,
      targetElement: groupElement,
      activeRect: null,
    });

    commitResolvedCanvasDrop({ source, target, preview }, rawNestedFocus);

    expect(useLeftPanelStore.getState().getPanelGroups()).toEqual([
      { panelIds: ["chats", "git-diff", "artifacts"] },
      { panelIds: ["terminals"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
    ]);
  });
});

describe("root dnd commits - left panel drop resolver", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  const SPLIT_GROUPS = [
    { panelIds: ["chats"] },
    { panelIds: ["artifacts"] },
    { panelIds: ["terminals"] },
    { panelIds: ["git-diff"] },
    { panelIds: ["file-tree"] },
    { panelIds: ["sharing"] },
    { panelIds: ["comments"] },
  ] as const;

  it("moves a whole rail group before another group", () => {
    expect(
      resolveLeftPanelGroupsForDrop(
        railSource("artifacts", "rail"),
        { kind: "left-panel-rail", panelId: "chats", position: "before" },
        SPLIT_GROUPS,
      ),
    ).toEqual([
      { panelIds: ["artifacts"] },
      { panelIds: ["chats"] },
      { panelIds: ["terminals"] },
      { panelIds: ["git-diff"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
    ]);
  });

  it("combines an extracted section into another rail group", () => {
    expect(
      resolveLeftPanelGroupsForDrop(
        railSource("artifacts", "panel-section"),
        { kind: "left-panel-rail", panelId: "git-diff", position: "combine" },
        SPLIT_GROUPS,
      ),
    ).toEqual([
      { panelIds: ["chats"] },
      { panelIds: ["terminals"] },
      { panelIds: ["git-diff", "artifacts"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
    ]);
  });

  it("returns structurally equal groups when a section combines into its own group", () => {
    const groups = [
      { panelIds: ["chats", "artifacts"] },
      { panelIds: ["terminals"] },
      { panelIds: ["git-diff"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
    ] as const;
    expect(
      resolveLeftPanelGroupsForDrop(
        railSource("artifacts", "panel-section"),
        { kind: "left-panel-rail", panelId: "chats", position: "combine" },
        groups,
      ),
    ).toEqual(groups);
  });

  it("moves a rail group and a section to the rail end", () => {
    expect(
      resolveLeftPanelGroupsForDrop(
        railSource("artifacts", "rail"),
        { kind: "left-panel-rail-list" },
        SPLIT_GROUPS,
      ),
    ).toEqual([
      { panelIds: ["chats"] },
      { panelIds: ["terminals"] },
      { panelIds: ["git-diff"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
      { panelIds: ["artifacts"] },
    ]);
    expect(
      resolveLeftPanelGroupsForDrop(
        railSource("artifacts", "panel-section"),
        { kind: "left-panel-rail-list" },
        [{ panelIds: ["chats", "artifacts"] }, ...SPLIT_GROUPS.slice(2)],
      ),
    ).toEqual([
      { panelIds: ["chats"] },
      { panelIds: ["terminals"] },
      { panelIds: ["git-diff"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
      { panelIds: ["artifacts"] },
    ]);
  });

  it("inserts at a section boundary inside another group", () => {
    expect(
      resolveLeftPanelGroupsForDrop(
        railSource("git-diff", "rail"),
        {
          kind: "left-panel-section",
          panelId: "artifacts",
          position: "before",
        },
        [{ panelIds: ["chats", "artifacts"] }, ...SPLIT_GROUPS.slice(2)],
      ),
    ).toEqual([
      { panelIds: ["chats", "git-diff", "artifacts"] },
      { panelIds: ["terminals"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
    ]);
  });

  it("returns null for non-left-panel previews", () => {
    expect(
      resolveLeftPanelGroupsForDrop(
        railSource("artifacts", "rail"),
        { kind: "empty-shell" },
        SPLIT_GROUPS,
      ),
    ).toBeNull();
    expect(
      resolveLeftPanelGroupsForDrop(
        railSource("artifacts", "rail"),
        { kind: "artifact-tab-strip", groupId: "group-a", index: 0 },
        SPLIT_GROUPS,
      ),
    ).toBeNull();
  });

  it("never dispatches a store write for a noop drop commit", () => {
    const before = useLeftPanelStore.getState().panelGroups;
    const source = railSource("artifacts", "panel-section");
    const preview = {
      kind: "left-panel-rail",
      panelId: "chats",
      position: "combine",
    } as const;

    expect(isLeftPanelDropNoop(source, preview)).toBe(true);
    commitResolvedCanvasDrop(
      {
        source,
        target: { kind: "left-panel-rail-item", panelId: "chats" },
        preview,
      },
      rawNestedFocus,
    );

    expect(useLeftPanelStore.getState().panelGroups).toBe(before);
  });
});

describe("root dnd commits - artifact tab commit routing", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  const ARTIFACT_TAB_SOURCE = {
    kind: "artifact-tab",
    epicId: EPIC_ID,
    viewTabId: VIEW_TAB_ID,
    sourceGroupId: "group-a",
    tabId: "tile-1",
    isPreview: false,
  } as const;

  it("routes strip previews to moveTabOnTabStrip at the preview index", () => {
    commitResolvedCanvasDrop(
      {
        source: ARTIFACT_TAB_SOURCE,
        target: {
          kind: "artifact-tab-strip-end",
          viewTabId: VIEW_TAB_ID,
          groupId: "group-b",
          index: 2,
        },
        preview: { kind: "artifact-tab-strip", groupId: "group-b", index: 2 },
      },
      rawNestedFocus,
    );

    expect(testState.canvasStore.moveTabOnTabStrip).toHaveBeenCalledWith(
      VIEW_TAB_ID,
      {
        sourcePaneId: "group-a",
        tabId: "tile-1",
        targetPaneId: "group-b",
        targetIndex: 2,
      },
    );
    expect(testState.canvasStore.splitPaneWithTab).not.toHaveBeenCalled();
  });

  it("routes body-center previews to moveTabOnTabStrip at the target tab count", () => {
    commitResolvedCanvasDrop(
      {
        source: ARTIFACT_TAB_SOURCE,
        target: {
          kind: "artifact-tab-group-body",
          viewTabId: VIEW_TAB_ID,
          groupId: "group-b",
          tabCount: 3,
        },
        preview: {
          kind: "artifact-tab-group-body",
          groupId: "group-b",
          position: "center",
        },
      },
      rawNestedFocus,
    );

    expect(testState.canvasStore.moveTabOnTabStrip).toHaveBeenCalledWith(
      VIEW_TAB_ID,
      {
        sourcePaneId: "group-a",
        tabId: "tile-1",
        targetPaneId: "group-b",
        targetIndex: 3,
      },
    );
    expect(testState.canvasStore.splitPaneWithTab).not.toHaveBeenCalled();
  });

  it("routes body-edge previews to splitPaneWithTab", () => {
    commitResolvedCanvasDrop(
      {
        source: ARTIFACT_TAB_SOURCE,
        target: {
          kind: "artifact-tab-group-body",
          viewTabId: VIEW_TAB_ID,
          groupId: "group-b",
          tabCount: 3,
        },
        preview: {
          kind: "artifact-tab-group-body",
          groupId: "group-b",
          position: "right",
        },
      },
      rawNestedFocus,
    );

    expect(testState.canvasStore.splitPaneWithTab).toHaveBeenCalledWith(
      VIEW_TAB_ID,
      {
        sourcePaneId: "group-a",
        tabId: "tile-1",
        targetPaneId: "group-b",
        position: "right",
      },
    );
    expect(testState.canvasStore.moveTabOnTabStrip).not.toHaveBeenCalled();
  });

  it("commits nothing for an empty-shell preview from a tab source", () => {
    commitResolvedCanvasDrop(
      {
        source: ARTIFACT_TAB_SOURCE,
        target: {
          kind: "empty-shell",
          epicId: EPIC_ID,
          viewTabId: VIEW_TAB_ID,
        },
        preview: { kind: "empty-shell" },
      },
      rawNestedFocus,
    );

    expect(testState.canvasStore.moveTabOnTabStrip).not.toHaveBeenCalled();
    expect(testState.canvasStore.splitPaneWithTab).not.toHaveBeenCalled();
  });
});

describe("root dnd commits - tile source commit routing", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("opens a dragged terminal tile on an empty canvas", () => {
    commitResolvedCanvasDrop(
      {
        source: {
          kind: "terminal-tile",
          epicId: EPIC_ID,
          viewTabId: VIEW_TAB_ID,
          tile: TERMINAL_TILE,
        },
        target: {
          kind: "empty-shell",
          epicId: EPIC_ID,
          viewTabId: VIEW_TAB_ID,
        },
        preview: { kind: "empty-shell" },
      },
      rawNestedFocus,
    );

    expect(testState.canvasStore.openTileInTab).toHaveBeenCalledWith(
      VIEW_TAB_ID,
      TERMINAL_TILE,
    );
  });
});

describe("root dnd commits - header strip", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("tears off a canvas tab into a new header tab and reports it for navigation", () => {
    testState.canvasStore.tearOffTabIntoNewHeaderTab = vi.fn(() => "new-tab");
    const result = commitHeaderStripDrop(
      {
        kind: "artifact-tab",
        epicId: EPIC_ID,
        viewTabId: VIEW_TAB_ID,
        sourceGroupId: "source-group",
        tabId: "tile-tab",
        isPreview: false,
      },
      1,
    );

    expect(
      testState.canvasStore.tearOffTabIntoNewHeaderTab,
    ).toHaveBeenCalledWith({
      sourceTabId: VIEW_TAB_ID,
      sourcePaneId: "source-group",
      sourceTileTabId: "tile-tab",
      insertIndex: 1,
    });
    expect(result).toEqual({ epicId: EPIC_ID, tabId: "new-tab" });
  });

  it("copies source sidebar state when a dragged tile opens a header tab", () => {
    testState.canvasStore.openTileInNewTab = vi.fn(() => "new-tab");
    useLeftPanelStore.getState().setActivePanelId(VIEW_TAB_ID, "artifacts");
    useLeftPanelStore.getState().setMainCollapsed(VIEW_TAB_ID, true);
    useEpicSidebarExpansionStore
      .getState()
      .expand(VIEW_TAB_ID, "chats", "node-1");

    const result = commitHeaderStripDrop(
      {
        kind: "git-diff-tile",
        epicId: EPIC_ID,
        viewTabId: VIEW_TAB_ID,
        tile: GIT_DIFF_TILE,
      },
      1,
    );

    // Atomic open: the single store write carries the insert index; no
    // follow-up moveOpenTab (which exposed a transient appended order to the
    // tab-sync subscriber).
    expect(testState.canvasStore.openTileInNewTab).toHaveBeenCalledWith(
      EPIC_ID,
      GIT_DIFF_TILE,
      1,
    );
    expect(testState.canvasStore.moveOpenTab).not.toHaveBeenCalled();
    expect(result).toEqual({ epicId: EPIC_ID, tabId: "new-tab" });
    expect(useLeftPanelStore.getState().getActivePanelId("new-tab")).toBe(
      "artifacts",
    );
    expect(useLeftPanelStore.getState().isMainCollapsed("new-tab")).toBe(true);
    expect(
      useEpicSidebarExpansionStore
        .getState()
        .userExpandedByScope["new-tab::chats"].has("node-1"),
    ).toBe(true);
  });

  it("opens a dragged terminal tile in a new header tab", () => {
    testState.canvasStore.openTileInNewTab = vi.fn(() => "new-tab");

    const result = commitHeaderStripDrop(
      {
        kind: "terminal-tile",
        epicId: EPIC_ID,
        viewTabId: VIEW_TAB_ID,
        tile: TERMINAL_TILE,
      },
      2,
    );

    expect(testState.canvasStore.openTileInNewTab).toHaveBeenCalledWith(
      EPIC_ID,
      TERMINAL_TILE,
      2,
    );
    expect(result).toEqual({ epicId: EPIC_ID, tabId: "new-tab" });
  });

  it("returns null when the rail source cannot drop on the header strip", () => {
    expect(commitHeaderStripDrop(railSource("artifacts", "rail"), 0)).toBe(
      null,
    );
  });
});

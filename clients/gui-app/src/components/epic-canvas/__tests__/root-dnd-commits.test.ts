import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commitHeaderStripDrop,
  commitResolvedCanvasDrop,
  isLeftPanelDropNoop,
  resolveCanvasDropPreview,
  resolveRailForDrop,
} from "@/components/epic-canvas/dnd/root-dnd-commits";
import type { EpicCanvasDragSourceData } from "@/components/epic-canvas/dnd/dnd";
import type { LeftPanelId } from "@/lib/left-panel-ids";
import { useLeftPanelStore } from "@/stores/epics/left-panel-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { currentLayoutArrangement } from "@/lib/layout/rail-view";
import {
  DEFAULT_RAIL,
  visibleRailPanelIds,
  type RailEntry,
} from "@/lib/layout/rail";
import { DEFAULT_ARRANGEMENT } from "@/lib/layout/layout-arrangement";
import { useEpicSidebarExpansionStore } from "@/stores/epics/epic-sidebar-expansion-store";
import { makeGitFileDiffTile } from "@/lib/git/git-diff-tile";
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";

const TILE_SOURCE = {
  kind: "artifact-tab",
  epicId: "epic-1",
  viewTabId: "view-1",
  sourceGroupId: "group-1",
  tabId: "tile-1",
  isPreview: false,
} as const satisfies EpicCanvasDragSourceData;

const PANE_RECT = { left: 0, top: 0, width: 600, height: 600 };

function paneBodyTarget(groupId: string) {
  return {
    kind: "artifact-tab-group-body",
    viewTabId: "view-1",
    groupId,
    tabCount: 2,
  } as const;
}

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

interface FakeEpicCanvasTab {
  readonly epicId: string;
}

interface TestCanvasStore {
  canvasByTabId: Record<string, unknown>;
  tabsById: Record<string, FakeEpicCanvasTab>;
  promotePreviewInTab: () => void;
  openTileInTab: (viewTabId: string, node: unknown) => void;
  prepareOpenTileInTabFocusTargetFromSource: (
    viewTabId: string,
    node: unknown,
    source: unknown,
  ) => null;
  prepareOpenTilePreviewInTabFocusTargetFromSource: (
    viewTabId: string,
    node: unknown,
    source: unknown,
  ) => null;
  prepareOpenTileInBackgroundTabFocusTargetFromSource: (
    viewTabId: string,
    node: unknown,
    source: unknown,
  ) => null;
  insertNodeOnTabStrip: (
    viewTabId: string,
    groupId: string,
    index: number,
    node: unknown,
  ) => void;
  prepareOpenTileInPaneFocusTargetFromSource: (
    viewTabId: string,
    groupId: string,
    node: unknown,
    options: { mode: unknown; index: number | null; source: unknown },
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
    canvasByTabId: {},
    tabsById: { "commits-view-tab": { epicId: "commits-epic" } },
    promotePreviewInTab: vi.fn(),
    openTileInTab: vi.fn(),
    prepareOpenTileInTabFocusTargetFromSource: vi.fn((viewTabId, node) => {
      testState.canvasStore.openTileInTab(viewTabId, node);
      return null;
    }),
    prepareOpenTilePreviewInTabFocusTargetFromSource: vi.fn(() => null),
    prepareOpenTileInBackgroundTabFocusTargetFromSource: vi.fn(() => null),
    insertNodeOnTabStrip: vi.fn(),
    prepareOpenTileInPaneFocusTargetFromSource: vi.fn(
      (
        viewTabId: string,
        groupId: string,
        node: unknown,
        options: { mode: unknown; index: number | null; source: unknown },
      ) => {
        testState.canvasStore.insertNodeOnTabStrip(
          viewTabId,
          groupId,
          options.index,
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
  trackOpenedCanvasTile: vi.fn(),
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

/**
 * A canvas whose `group-a` already holds `TERMINAL_TILE`, so a drop of the
 * same ref onto another pane must MOVE the open tab (R2) rather than dedupe
 * into focus-existing.
 */
function seedCanvasWithTerminalTile(): void {
  testState.canvasStore.canvasByTabId = {
    [VIEW_TAB_ID]: {
      root: {
        kind: "pane",
        id: "group-a",
        tabInstanceIds: [TERMINAL_TILE.instanceId],
        activeTabId: TERMINAL_TILE.instanceId,
        previewTabId: null,
        activationHistory: [TERMINAL_TILE.instanceId],
      },
      activePaneId: "group-a",
      tilesByInstanceId: { [TERMINAL_TILE.instanceId]: TERMINAL_TILE },
      sizesByGroupId: {},
    },
  };
}

function railSource(
  panelId: LeftPanelId,
  origin: "rail" | "panel-section",
): Extract<
  EpicCanvasDragSourceData,
  { readonly kind: "left-panel-rail-item" }
> {
  return {
    kind: "left-panel-rail-item",
    viewTabId: "test-view-tab",
    panelId,
    origin,
  };
}

function resetStores(): void {
  window.localStorage.clear();
  testState.canvasStore.canvasByTabId = {};
  testState.canvasStore.openTileInNewTab = vi.fn(() => null);
  testState.canvasStore.tearOffTabIntoNewHeaderTab = vi.fn(() => null);
  testState.canvasStore.moveOpenTab = vi.fn();
  testState.canvasStore.moveTabOnTabStrip =
    vi.fn<(viewTabId: string, args: TabStripMoveArgs) => void>();
  testState.canvasStore.splitPaneWithTab =
    vi.fn<(viewTabId: string, args: TabSplitArgs) => void>();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  useLeftPanelStore.setState({
    activePanelIdByTabId: {},
    mainCollapsedByTabId: {},
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

  it("moves a panel to the rail end from a section-origin drop on the rail background", () => {
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

    expect(
      visibleRailPanelIds(currentLayoutArrangement().rail, () => true),
    ).toEqual([
      "chats",
      "terminals",
      "browsers",
      "git-diff",
      "pull-requests",
      "file-tree",
      "sharing",
      "comments",
      "artifacts",
    ]);
  });

  // A rail slot is square, so the pointer below sits in the middle band of one
  // axis and the leading band of the other. Which one is read is the whole
  // difference between a "before" reorder and a "combine" join (L-168).
  const RAIL_SLOT_RECT = { left: 0, top: 0, width: 36, height: 36 };
  const LEADING_X_MIDDLE_Y = { x: 4, y: 18 };

  it("reorders a horizontal rail drop from the pointer's x, whatever its height", () => {
    const source = railSource("file-tree", "rail");
    const target = {
      kind: "left-panel-rail-item",
      panelId: "terminals",
      orientation: "horizontal",
    } as const;
    for (const y of [2, 18, 34]) {
      expect(
        resolveCanvasDropPreview({
          source,
          target,
          point: { x: LEADING_X_MIDDLE_Y.x, y },
          targetRect: RAIL_SLOT_RECT,
          targetElement: null,
          activeRect: null,
        }),
      ).toEqual({
        kind: "left-panel-rail",
        panelId: "terminals",
        position: "before",
      });
    }
    const preview = resolveCanvasDropPreview({
      source,
      target,
      point: LEADING_X_MIDDLE_Y,
      targetRect: RAIL_SLOT_RECT,
      targetElement: null,
      activeRect: null,
    });

    expect(isLeftPanelDropNoop(source, preview)).toBe(false);
    commitResolvedCanvasDrop({ source, target, preview }, rawNestedFocus);

    expect(
      visibleRailPanelIds(currentLayoutArrangement().rail, () => true),
    ).toEqual([
      "chats",
      "artifacts",
      "file-tree",
      "terminals",
      "browsers",
      "git-diff",
      "pull-requests",
      "sharing",
      "comments",
    ]);
  });

  it("reorders a vertical rail drop from the pointer's y, whatever its width", () => {
    const source = railSource("file-tree", "rail");
    const target = {
      kind: "left-panel-rail-item",
      panelId: "terminals",
      orientation: "vertical",
    } as const;
    for (const x of [2, 18, 34]) {
      expect(
        resolveCanvasDropPreview({
          source,
          target,
          point: { x, y: 4 },
          targetRect: RAIL_SLOT_RECT,
          targetElement: null,
          activeRect: null,
        }),
      ).toEqual({
        kind: "left-panel-rail",
        panelId: "terminals",
        position: "before",
      });
    }
    // The middle band of y is the combine band (L-168), even where x sits in
    // its leading band.
    expect(
      resolveCanvasDropPreview({
        source,
        target,
        point: LEADING_X_MIDDLE_Y,
        targetRect: RAIL_SLOT_RECT,
        targetElement: null,
        activeRect: null,
      }),
    ).toEqual({
      kind: "left-panel-rail",
      panelId: "terminals",
      position: "combine",
    });
    const preview = resolveCanvasDropPreview({
      source,
      target,
      point: { x: 4, y: 34 },
      targetRect: RAIL_SLOT_RECT,
      targetElement: null,
      activeRect: null,
    });

    expect(preview).toEqual({
      kind: "left-panel-rail",
      panelId: "terminals",
      position: "after",
    });
    commitResolvedCanvasDrop({ source, target, preview }, rawNestedFocus);

    expect(
      visibleRailPanelIds(currentLayoutArrangement().rail, () => true),
    ).toEqual([
      "chats",
      "artifacts",
      "terminals",
      "file-tree",
      "browsers",
      "git-diff",
      "pull-requests",
      "sharing",
      "comments",
    ]);
  });

  it("resolves a rail-icon drop on the open body to a combine on the stack's top panel, joining it (L-182)", () => {
    // The body is ONE drop target for the whole stack it draws: a drop
    // anywhere on it means the same middle-band join a drop on the stack's
    // own rail icon (Chats, the top of the shipped pair) would mean.
    const source = railSource("terminals", "rail");
    const target = { kind: "left-panel-body", panelId: "chats" } as const;

    const preview = resolveCanvasDropPreview({
      source,
      target,
      point: { x: 120, y: 700 },
      targetRect: null,
      targetElement: null,
      activeRect: null,
    });

    expect(preview).toEqual({
      kind: "left-panel-rail",
      viewTabId: undefined,
      panelId: "chats",
      position: "combine",
    });

    commitResolvedCanvasDrop({ source, target, preview }, rawNestedFocus);

    expect(currentLayoutArrangement().rail.map((entry) => entry.id)).toEqual([
      "railAgents",
      "stack:railAgents+railArtifacts+railTerminals",
      "railArtifacts",
      "railTerminals",
      "railBrowsers",
      "railGitDiff",
      "railPullRequests",
      "railFileTree",
      "railSharing",
      "railComments",
    ]);
  });

  it("stacks a fifth panel dropped on the body of a stack of four: a stack has no cap (L-181, L-182)", () => {
    const fourMember = [
      { kind: "panel" as const, id: "railAgents" as const },
      {
        kind: "stack" as const,
        id: "stack:railAgents+railArtifacts+railTerminals+railBrowsers",
      },
      { kind: "panel" as const, id: "railArtifacts" as const },
      { kind: "panel" as const, id: "railTerminals" as const },
      { kind: "panel" as const, id: "railBrowsers" as const },
      { kind: "panel" as const, id: "railGitDiff" as const },
      { kind: "panel" as const, id: "railPullRequests" as const },
      { kind: "panel" as const, id: "railFileTree" as const },
      { kind: "panel" as const, id: "railSharing" as const },
      { kind: "panel" as const, id: "railComments" as const },
    ];
    useLayoutStore.setState({
      ...DEFAULT_LAYOUT_SNAPSHOT,
      arrangement: { ...DEFAULT_ARRANGEMENT, rail: fourMember },
    });
    const source = railSource("git-diff", "rail");
    const target = { kind: "left-panel-body", panelId: "chats" } as const;
    const preview = resolveCanvasDropPreview({
      source,
      target,
      point: { x: 120, y: 700 },
      targetRect: null,
      targetElement: null,
      activeRect: null,
    });

    expect(isLeftPanelDropNoop(source, preview)).toBe(false);
    const committed = commitResolvedCanvasDrop(
      { source, target, preview },
      rawNestedFocus,
    );

    expect(committed).toBe(true);
    expect(currentLayoutArrangement().rail.map((entry) => entry.id)).toEqual([
      "railAgents",
      "stack:railAgents+railArtifacts+railTerminals+railBrowsers+railGitDiff",
      "railArtifacts",
      "railTerminals",
      "railBrowsers",
      "railGitDiff",
      "railPullRequests",
      "railFileTree",
      "railSharing",
      "railComments",
    ]);
  });

  it("is a no-op for a section-origin drop onto the body of the stack the panel already belongs to", () => {
    const source = railSource("artifacts", "panel-section");
    const target = { kind: "left-panel-body", panelId: "chats" } as const;
    const preview = resolveCanvasDropPreview({
      source,
      target,
      point: { x: 120, y: 700 },
      targetRect: null,
      targetElement: null,
      activeRect: null,
    });

    expect(isLeftPanelDropNoop(source, preview)).toBe(true);
    const before = useLayoutStore.getState().arrangement.rail;
    commitResolvedCanvasDrop({ source, target, preview }, rawNestedFocus);
    expect(useLayoutStore.getState().arrangement.rail).toBe(before);
  });

  it("carries a WHOLE stack onto another stack's body, appending all its members (L-181, L-182)", () => {
    // Terminals+Browsers, dragged by ITS icon, lands on the shipped
    // Agents+Artifacts body: both members join, growing the 2-member stack to
    // 4 rather than replacing or refusing it.
    const rail: ReadonlyArray<RailEntry> = [
      { kind: "panel", id: "railAgents" },
      { kind: "stack", id: "stack:railAgents+railArtifacts" },
      { kind: "panel", id: "railArtifacts" },
      { kind: "panel", id: "railTerminals" },
      { kind: "stack", id: "stack:railTerminals+railBrowsers" },
      { kind: "panel", id: "railBrowsers" },
      { kind: "panel", id: "railGitDiff" },
      { kind: "panel", id: "railPullRequests" },
      { kind: "panel", id: "railFileTree" },
      { kind: "panel", id: "railSharing" },
      { kind: "panel", id: "railComments" },
    ];
    useLayoutStore.setState({
      ...DEFAULT_LAYOUT_SNAPSHOT,
      arrangement: { ...DEFAULT_ARRANGEMENT, rail },
    });
    const source = railSource("terminals", "rail");
    const target = { kind: "left-panel-body", panelId: "chats" } as const;
    const preview = resolveCanvasDropPreview({
      source,
      target,
      point: { x: 120, y: 700 },
      targetRect: null,
      targetElement: null,
      activeRect: null,
    });

    commitResolvedCanvasDrop({ source, target, preview }, rawNestedFocus);

    expect(currentLayoutArrangement().rail.map((entry) => entry.id)).toEqual([
      "railAgents",
      "stack:railAgents+railArtifacts+railTerminals+railBrowsers",
      "railArtifacts",
      "railTerminals",
      "railBrowsers",
      "railGitDiff",
      "railPullRequests",
      "railFileTree",
      "railSharing",
      "railComments",
    ]);
  });
});

describe("root dnd commits - full-pane tile split affordances", () => {
  const panePoint = { x: 120, y: 300 };

  it("resolves a split immediately anywhere in the tile's source pane", () => {
    expect(
      resolveCanvasDropPreview({
        source: TILE_SOURCE,
        target: paneBodyTarget("group-1"),
        point: panePoint,
        targetRect: PANE_RECT,
        targetElement: null,
        activeRect: null,
      }),
    ).toEqual({
      kind: "artifact-tab-group-body",
      groupId: "group-1",
      position: "left",
    });
  });

  it("resolves a split immediately anywhere in another pane", () => {
    expect(
      resolveCanvasDropPreview({
        source: TILE_SOURCE,
        target: paneBodyTarget("group-2"),
        point: panePoint,
        targetRect: PANE_RECT,
        targetElement: null,
        activeRect: null,
      }),
    ).toEqual({
      kind: "artifact-tab-group-body",
      groupId: "group-2",
      position: "left",
    });
  });
});

describe("root dnd commits - left panel drop resolver", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("reorders WITHIN its own stack rather than treating a stacked source as a no-op (L-181)", () => {
    // A section header carries one panel (L-181): dropped beside its own
    // stack partner, Artifacts moves to the top of the pair and stays a
    // member.
    expect(
      resolveRailForDrop(
        railSource("artifacts", "panel-section"),
        { kind: "left-panel-rail", panelId: "chats", position: "before" },
        DEFAULT_ARRANGEMENT,
      ),
    ).toEqual([
      { kind: "panel", id: "railArtifacts" },
      { kind: "stack", id: "stack:railArtifacts+railAgents" },
      { kind: "panel", id: "railAgents" },
      { kind: "panel", id: "railTerminals" },
      { kind: "panel", id: "railBrowsers" },
      { kind: "panel", id: "railGitDiff" },
      { kind: "panel", id: "railPullRequests" },
      { kind: "panel", id: "railFileTree" },
      { kind: "panel", id: "railSharing" },
      { kind: "panel", id: "railComments" },
    ]);
  });

  it("is a no-op for a rail icon dropped WITHIN its own stack, which carries the whole block (L-181)", () => {
    // A rail icon carries the whole stack (L-181): dropped beside its own
    // partner, the target is already inside the carried block, so nothing
    // moves.
    expect(
      resolveRailForDrop(
        railSource("artifacts", "rail"),
        { kind: "left-panel-rail", panelId: "chats", position: "before" },
        DEFAULT_ARRANGEMENT,
      ),
    ).toEqual(DEFAULT_RAIL);
  });

  it("moves a section-origin drop beside another panel", () => {
    expect(
      resolveRailForDrop(
        railSource("artifacts", "panel-section"),
        { kind: "left-panel-rail", panelId: "git-diff", position: "after" },
        DEFAULT_ARRANGEMENT,
      ),
    ).toEqual([
      { kind: "panel", id: "railAgents" },
      { kind: "panel", id: "railTerminals" },
      { kind: "panel", id: "railBrowsers" },
      { kind: "panel", id: "railGitDiff" },
      { kind: "panel", id: "railArtifacts" },
      { kind: "panel", id: "railPullRequests" },
      { kind: "panel", id: "railFileTree" },
      { kind: "panel", id: "railSharing" },
      { kind: "panel", id: "railComments" },
    ]);
  });

  it("returns an equal rail for a drop that lands a panel where it already is", () => {
    expect(
      resolveRailForDrop(
        railSource("artifacts", "panel-section"),
        { kind: "left-panel-rail", panelId: "chats", position: "after" },
        DEFAULT_ARRANGEMENT,
      ),
    ).toEqual(DEFAULT_RAIL);
  });

  it("moves the WHOLE stack to the rail's end via its icon, or ONE panel via its section header (L-181)", () => {
    // Rail-icon origin: the whole stack carries to the end, together.
    expect(
      resolveRailForDrop(
        railSource("artifacts", "rail"),
        { kind: "left-panel-rail-list" },
        DEFAULT_ARRANGEMENT,
      ),
    ).toEqual([
      { kind: "panel", id: "railTerminals" },
      { kind: "panel", id: "railBrowsers" },
      { kind: "panel", id: "railGitDiff" },
      { kind: "panel", id: "railPullRequests" },
      { kind: "panel", id: "railFileTree" },
      { kind: "panel", id: "railSharing" },
      { kind: "panel", id: "railComments" },
      { kind: "panel", id: "railAgents" },
      { kind: "stack", id: "stack:railAgents+railArtifacts" },
      { kind: "panel", id: "railArtifacts" },
    ]);
    // Section-origin: Artifacts alone leaves its group, Agents stays put.
    expect(
      resolveRailForDrop(
        railSource("artifacts", "panel-section"),
        { kind: "left-panel-rail-list" },
        DEFAULT_ARRANGEMENT,
      ),
    ).toEqual([
      { kind: "panel", id: "railAgents" },
      { kind: "panel", id: "railTerminals" },
      { kind: "panel", id: "railBrowsers" },
      { kind: "panel", id: "railGitDiff" },
      { kind: "panel", id: "railPullRequests" },
      { kind: "panel", id: "railFileTree" },
      { kind: "panel", id: "railSharing" },
      { kind: "panel", id: "railComments" },
      { kind: "panel", id: "railArtifacts" },
    ]);
  });

  it("stacks the two panels for a drop in the middle band (L-168)", () => {
    expect(
      resolveRailForDrop(
        railSource("terminals", "rail"),
        {
          kind: "left-panel-rail",
          panelId: "browsers",
          position: "combine",
        },
        DEFAULT_ARRANGEMENT,
      ),
    ).toEqual([
      { kind: "panel", id: "railAgents" },
      { kind: "stack", id: "stack:railAgents+railArtifacts" },
      { kind: "panel", id: "railArtifacts" },
      { kind: "panel", id: "railBrowsers" },
      { kind: "stack", id: "stack:railBrowsers+railTerminals" },
      { kind: "panel", id: "railTerminals" },
      { kind: "panel", id: "railGitDiff" },
      { kind: "panel", id: "railPullRequests" },
      { kind: "panel", id: "railFileTree" },
      { kind: "panel", id: "railSharing" },
      { kind: "panel", id: "railComments" },
    ]);
  });

  it("only reorders for a drop in an outer band", () => {
    const after = resolveRailForDrop(
      railSource("terminals", "rail"),
      { kind: "left-panel-rail", panelId: "browsers", position: "after" },
      DEFAULT_ARRANGEMENT,
    );

    expect(after).not.toBeNull();
    expect(after?.filter((entry) => entry.kind === "stack")).toEqual([
      { kind: "stack", id: "stack:railAgents+railArtifacts" },
    ]);
    expect(after?.map((entry) => entry.id).slice(3, 5)).toEqual([
      "railBrowsers",
      "railTerminals",
    ]);
  });

  it("lets a stacked SOURCE dragged by its rail icon carry its WHOLE stack onto a new target (L-170, L-181)", () => {
    // A rail icon carries the whole stack (L-181): dragged off it, BOTH
    // Agents and Artifacts leave the shipped pair together and join
    // Terminals, unlike the section-origin case right below, which carries
    // Agents alone.
    const next = resolveRailForDrop(
      railSource("chats", "rail"),
      { kind: "left-panel-rail", panelId: "terminals", position: "combine" },
      DEFAULT_ARRANGEMENT,
    );

    expect(next?.map((entry) => entry.id)).toEqual([
      "railTerminals",
      "stack:railTerminals+railAgents+railArtifacts",
      "railAgents",
      "railArtifacts",
      "railBrowsers",
      "railGitDiff",
      "railPullRequests",
      "railFileTree",
      "railSharing",
      "railComments",
    ]);
  });

  it("lets a stacked SOURCE dragged by its section leave its old pair and join a new one (L-170)", () => {
    // Grabbed by the panel's own section header rather than the rail's group
    // icon (asGroups is false), so the whole-stack carry above does not
    // apply: the panel alone leaves its old pair and Artifacts stands alone.
    const next = resolveRailForDrop(
      railSource("chats", "panel-section"),
      { kind: "left-panel-rail", panelId: "terminals", position: "combine" },
      DEFAULT_ARRANGEMENT,
    );

    expect(next?.map((entry) => entry.id)).toEqual([
      "railArtifacts",
      "railTerminals",
      "stack:railTerminals+railAgents",
      "railAgents",
      "railBrowsers",
      "railGitDiff",
      "railPullRequests",
      "railFileTree",
      "railSharing",
      "railComments",
    ]);
  });

  it("joins a target that is already stacked, growing the stack (L-181)", () => {
    // Artifacts is the shipped rail's stacked panel: dropping a third member
    // onto it grows the stack rather than refusing, since two is no longer
    // the max.
    expect(
      resolveRailForDrop(
        railSource("terminals", "rail"),
        {
          kind: "left-panel-rail",
          panelId: "artifacts",
          position: "combine",
        },
        DEFAULT_ARRANGEMENT,
      ),
    ).toEqual([
      { kind: "panel", id: "railAgents" },
      { kind: "stack", id: "stack:railAgents+railArtifacts+railTerminals" },
      { kind: "panel", id: "railArtifacts" },
      { kind: "panel", id: "railTerminals" },
      { kind: "panel", id: "railBrowsers" },
      { kind: "panel", id: "railGitDiff" },
      { kind: "panel", id: "railPullRequests" },
      { kind: "panel", id: "railFileTree" },
      { kind: "panel", id: "railSharing" },
      { kind: "panel", id: "railComments" },
    ]);
  });

  it("returns null for non-left-panel previews", () => {
    expect(
      resolveRailForDrop(
        railSource("artifacts", "rail"),
        { kind: "empty-shell" },
        DEFAULT_ARRANGEMENT,
      ),
    ).toBeNull();
    expect(
      resolveRailForDrop(
        railSource("artifacts", "rail"),
        { kind: "artifact-tab-strip", groupId: "group-a", index: 0 },
        DEFAULT_ARRANGEMENT,
      ),
    ).toBeNull();
  });

  it("never dispatches a store write for a noop drop commit", () => {
    const before = useLayoutStore.getState().arrangement.rail;
    const source = railSource("artifacts", "panel-section");
    // Artifacts already sits immediately after Chats in the default rail, so
    // landing it "after chats" again is a no-op.
    const preview = {
      kind: "left-panel-rail",
      panelId: "chats",
      position: "after",
    } as const;

    expect(isLeftPanelDropNoop(source, preview)).toBe(true);
    commitResolvedCanvasDrop(
      {
        source,
        target: {
          kind: "left-panel-rail-item",
          panelId: "chats",
          orientation: "vertical",
          // Agents ships joined to Artifacts (L-166); an outer-band reorder is
          // offered on a stacked icon all the same.
        },
        preview,
      },
      rawNestedFocus,
    );

    expect(useLayoutStore.getState().arrangement.rail).toBe(before);
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

  it("rejects a cross-pane canvas target without mutating either pane", () => {
    commitResolvedCanvasDrop(
      {
        source: {
          kind: "terminal-tile",
          epicId: EPIC_ID,
          viewTabId: "source-view",
          tile: TERMINAL_TILE,
        },
        target: {
          kind: "empty-shell",
          epicId: "other-epic",
          viewTabId: "target-view",
        },
        preview: { kind: "empty-shell" },
      },
      rawNestedFocus,
    );

    expect(testState.canvasStore.openTileInTab).not.toHaveBeenCalled();
  });

  it("moves an already-open ref to the drop pane instead of focusing it", () => {
    seedCanvasWithTerminalTile();

    commitResolvedCanvasDrop(
      {
        source: {
          kind: "terminal-tile",
          epicId: EPIC_ID,
          viewTabId: VIEW_TAB_ID,
          tile: TERMINAL_TILE,
        },
        target: {
          kind: "artifact-tab-strip-end",
          viewTabId: VIEW_TAB_ID,
          groupId: "group-b",
          index: 1,
        },
        preview: { kind: "artifact-tab-strip", groupId: "group-b", index: 1 },
      },
      rawNestedFocus,
    );

    expect(testState.canvasStore.moveTabOnTabStrip).toHaveBeenCalledWith(
      VIEW_TAB_ID,
      {
        sourcePaneId: "group-a",
        tabId: TERMINAL_TILE.instanceId,
        targetPaneId: "group-b",
        targetIndex: 1,
      },
    );
    expect(
      testState.canvasStore.prepareOpenTileInPaneFocusTargetFromSource,
    ).not.toHaveBeenCalled();
  });

  it("splits with the existing tab when an already-open ref is dropped on a pane edge", () => {
    seedCanvasWithTerminalTile();

    commitResolvedCanvasDrop(
      {
        source: {
          kind: "terminal-tile",
          epicId: EPIC_ID,
          viewTabId: VIEW_TAB_ID,
          tile: TERMINAL_TILE,
        },
        target: {
          kind: "artifact-tab-group-body",
          viewTabId: VIEW_TAB_ID,
          groupId: "group-b",
          tabCount: 2,
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
        tabId: TERMINAL_TILE.instanceId,
        targetPaneId: "group-b",
        position: "right",
      },
    );
    expect(
      testState.canvasStore.prepareOpenTileInPaneFocusTargetFromSource,
    ).not.toHaveBeenCalled();
  });

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

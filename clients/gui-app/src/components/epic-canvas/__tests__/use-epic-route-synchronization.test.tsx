import "../../../../__tests__/test-browser-apis";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
  type EpicRouteFocusIntent,
  useEpicRouteSynchronization,
} from "@/components/epic-canvas/hooks/use-epic-route-synchronization";
import type {
  EpicCanvasTileRef,
  TileLayoutNode,
} from "@/stores/epics/canvas/types";
import { useCommentThreadsStore } from "@/stores/comments/comment-threads-store";
import {
  DEFAULT_LEFT_PANEL_GROUPS,
  useLeftPanelStore,
} from "@/stores/epics/left-panel-store";

interface CanvasStoreSlice {
  readonly renameTab: Mock;
  readonly openTileInTab: Mock;
  readonly closeCanvasTab: Mock;
  readonly pendingCreateArtifactIds: ReadonlySet<string>;
}

interface TestState {
  activeArtifactId: string | null;
  autoOpenTarget: {
    readonly id: string;
    readonly type: "spec";
    readonly name: string;
  } | null;
  canvasRoot: TileLayoutNode | null;
  canvasTiles: Readonly<Record<string, EpicCanvasTileRef>>;
  records: ReadonlyArray<{ readonly id: string }>;
  canvasStore: CanvasStoreSlice;
  openEpicState: {
    readonly setLastFocusedArtifactId: Mock;
    readonly setLastFocusedThreadId: Mock;
  };
}

const testState = vi.hoisted<TestState>(() => ({
  activeArtifactId: null,
  autoOpenTarget: null,
  canvasRoot: null,
  canvasTiles: {},
  records: [],
  canvasStore: {
    renameTab: vi.fn(),
    openTileInTab: vi.fn(),
    closeCanvasTab: vi.fn(),
    pendingCreateArtifactIds: new Set<string>(),
  },
  openEpicState: {
    setLastFocusedArtifactId: vi.fn(),
    setLastFocusedThreadId: vi.fn(),
  },
}));

vi.mock("@/providers/use-open-epic-handle", () => ({
  useOpenEpicHandle: () => ({
    store: {
      getState: () => testState.openEpicState,
    },
  }),
}));

vi.mock("@/stores/epics/canvas/store", () => ({
  useActiveEpicArtifactId: () => testState.activeArtifactId,
  useEpicCanvas: () => ({
    root: testState.canvasRoot,
    tilesByInstanceId: testState.canvasTiles,
  }),
  useEpicCanvasStore: <T,>(selector: (store: CanvasStoreSlice) => T): T =>
    selector(testState.canvasStore),
  useEpicTab: () => null,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicArtifactRecords: () => testState.records,
  useEpicLastFocusedArtifactId: () => null,
  useEpicSnapshotLoaded: () => true,
  useEpicTitle: () => "",
}));

vi.mock("@/lib/epic-auto-open", () => ({
  resolveAutoOpenTarget: () => testState.autoOpenTarget,
}));

const EPIC_ID = "route-sync-epic";
const TAB_ID = "route-sync-tab";
const THREAD_FOCUS_INTENT: EpicRouteFocusIntent = {
  epicId: EPIC_ID,
  tabId: TAB_ID,
  focusedAt: 123,
  focusArtifactId: "artifact-1",
  focusThreadId: "thread-1",
};

function resetStores(): void {
  window.localStorage.clear();
  useLeftPanelStore.setState({
    activePanelIdByTabId: {},
    panelGroups: DEFAULT_LEFT_PANEL_GROUPS,
    mainCollapsedByTabId: {},
    panelSectionCollapsedByPanelId: {},
    commentsPanelRevealedByTabId: {},
    localRootCreatePendingByEpicPanel: {},
    acknowledgedRootCreatePendingByEpicPanel: {},
  });
  useCommentThreadsStore.setState({
    activeByEpicId: {},
    hoverByEpicId: {},
    flashByEpicId: {},
    draftByEpicId: {},
    artifactByEpicId: {},
  });
  testState.activeArtifactId = null;
  testState.autoOpenTarget = {
    id: "artifact-1",
    type: "spec",
    name: "Focused artifact",
  };
  testState.canvasRoot = null;
  testState.canvasTiles = {};
  testState.records = [];
  testState.canvasStore.renameTab.mockClear();
  testState.canvasStore.openTileInTab.mockClear();
  testState.canvasStore.closeCanvasTab.mockClear();
  testState.openEpicState.setLastFocusedArtifactId.mockClear();
  testState.openEpicState.setLastFocusedThreadId.mockClear();
}

describe("useEpicRouteSynchronization", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("reveals and activates comments for a focused thread deep link", async () => {
    const hook = renderHook(
      (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
      {
        initialProps: THREAD_FOCUS_INTENT,
      },
    );

    await waitFor(() => {
      expect(testState.canvasStore.openTileInTab).toHaveBeenCalledWith(
        TAB_ID,
        expect.objectContaining({
          id: "artifact-1",
          type: "spec",
          name: "Focused artifact",
        }),
      );
    });

    testState.activeArtifactId = "artifact-1";
    hook.rerender(THREAD_FOCUS_INTENT);

    await waitFor(() =>
      expect(
        testState.openEpicState.setLastFocusedThreadId,
      ).toHaveBeenCalledWith("thread-1"),
    );

    await waitFor(() => {
      expect(useLeftPanelStore.getState().isCommentsPanelRevealed(TAB_ID)).toBe(
        true,
      );
      expect(useLeftPanelStore.getState().getActivePanelId(TAB_ID)).toBe(
        "comments",
      );
      expect(useCommentThreadsStore.getState().activeByEpicId[EPIC_ID]).toBe(
        "thread-1",
      );
    });
  });

  it("does not reuse focused-thread dedupe keys across epics", async () => {
    testState.autoOpenTarget = null;
    testState.activeArtifactId = "artifact-1";
    const hook = renderHook(
      (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
      {
        initialProps: THREAD_FOCUS_INTENT,
      },
    );

    await waitFor(() => {
      expect(useCommentThreadsStore.getState().activeByEpicId[EPIC_ID]).toBe(
        "thread-1",
      );
    });

    hook.rerender({
      ...THREAD_FOCUS_INTENT,
      epicId: "route-sync-epic-b",
      tabId: "route-sync-tab-b",
    });

    await waitFor(() => {
      expect(
        useLeftPanelStore
          .getState()
          .isCommentsPanelRevealed("route-sync-tab-b"),
      ).toBe(true);
      expect(
        useCommentThreadsStore.getState().activeByEpicId["route-sync-epic-b"],
      ).toBe("thread-1");
    });
  });

  it("does not reuse auto-open dedupe keys across epics", async () => {
    const hook = renderHook(
      (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
      {
        initialProps: {
          ...THREAD_FOCUS_INTENT,
          focusThreadId: undefined,
        },
      },
    );

    await waitFor(() => {
      expect(testState.canvasStore.openTileInTab).toHaveBeenCalledWith(
        TAB_ID,
        expect.objectContaining({
          id: "artifact-1",
          type: "spec",
          name: "Focused artifact",
        }),
      );
    });

    testState.canvasStore.openTileInTab.mockClear();
    hook.rerender({
      ...THREAD_FOCUS_INTENT,
      epicId: "route-sync-epic-b",
      tabId: "route-sync-tab-b",
      focusThreadId: undefined,
    });

    await waitFor(() => {
      expect(testState.canvasStore.openTileInTab).toHaveBeenCalledWith(
        "route-sync-tab-b",
        expect.objectContaining({
          id: "artifact-1",
          type: "spec",
          name: "Focused artifact",
        }),
      );
    });
  });

  it("closes removed record-backed tiles by tab instance id while preserving local git diff tiles", async () => {
    testState.autoOpenTarget = null;
    testState.records = [{ id: "live-artifact" }];
    const gitTile: EpicCanvasTileRef = {
      id: "git-diff-local",
      instanceId: "inst-git-diff-local",
      type: "git-diff",
      name: "file.ts · Working",
      hostId: "host-1",
      diff: {
        kind: "file",
        runningDir: "/repo",
        filePath: "src/file.ts",
        stage: "unstaged",
      },
      view: {
        collapsedFilePaths: [],
      },
    };
    const removedChat: EpicCanvasTileRef = {
      id: "removed-chat",
      instanceId: "inst-removed-chat",
      type: "chat",
      name: "Removed chat",
      hostId: "host-1",
    };
    testState.canvasRoot = {
      kind: "pane",
      id: "group-1",
      tabInstanceIds: [gitTile.instanceId, removedChat.instanceId],
      activeTabId: "inst-git-diff-local",
      previewTabId: null,
      activationHistory: [gitTile.instanceId],
    };
    testState.canvasTiles = {
      [gitTile.instanceId]: gitTile,
      [removedChat.instanceId]: removedChat,
    };

    renderHook(
      (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
      {
        initialProps: {
          epicId: EPIC_ID,
          tabId: TAB_ID,
          focusedAt: undefined,
          focusArtifactId: undefined,
          focusThreadId: undefined,
        },
      },
    );

    await waitFor(() => {
      expect(testState.canvasStore.closeCanvasTab).toHaveBeenCalledWith(
        TAB_ID,
        "group-1",
        "inst-removed-chat",
      );
    });
    expect(testState.canvasStore.closeCanvasTab).not.toHaveBeenCalledWith(
      TAB_ID,
      "group-1",
      "git-diff-local",
    );
    expect(testState.canvasStore.closeCanvasTab).not.toHaveBeenCalledWith(
      TAB_ID,
      "group-1",
      "removed-chat",
    );
  });
});

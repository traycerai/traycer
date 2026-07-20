import "../../../../__tests__/test-browser-apis";
import { act, renderHook, waitFor } from "@testing-library/react";
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
  readonly applyNestedRouteFocus: Mock;
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
  nestedFocusEnabled: boolean;
  navigate: Mock;
  canvasActivePaneId: string | null;
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
  nestedFocusEnabled: false,
  navigate: vi.fn(),
  canvasActivePaneId: null,
  canvasRoot: null,
  canvasTiles: {},
  records: [],
  canvasStore: {
    renameTab: vi.fn(),
    openTileInTab: vi.fn(),
    applyNestedRouteFocus: vi.fn(),
    closeCanvasTab: vi.fn(),
    pendingCreateArtifactIds: new Set<string>(),
  },
  openEpicState: {
    setLastFocusedArtifactId: vi.fn(),
    setLastFocusedThreadId: vi.fn(),
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => testState.navigate,
  useRouter: () => ({ history: {} }),
}));

vi.mock("@/lib/persistent-history", () => ({
  getHistoryController: () =>
    testState.nestedFocusEnabled ? { kind: "persistent-history" } : null,
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
    activePaneId: testState.canvasActivePaneId,
    tilesByInstanceId: testState.canvasTiles,
    sizesByGroupId: {},
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
  focusPaneId: undefined,
  focusTileInstanceId: undefined,
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
  testState.nestedFocusEnabled = false;
  testState.navigate.mockClear();
  testState.canvasActivePaneId = null;
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
  testState.canvasStore.applyNestedRouteFocus.mockClear();
  testState.canvasStore.closeCanvasTab.mockClear();
  testState.openEpicState.setLastFocusedArtifactId.mockClear();
  testState.openEpicState.setLastFocusedThreadId.mockClear();
}

function specTile(
  id: string,
  instanceId: string,
  name: string,
): EpicCanvasTileRef {
  return {
    id,
    instanceId,
    type: "spec",
    name,
    hostId: "host-1",
  };
}

function setSinglePaneCanvas(
  paneId: string,
  tabs: ReadonlyArray<EpicCanvasTileRef>,
  activeTabId: string | null,
): void {
  testState.canvasActivePaneId = paneId;
  testState.canvasRoot = {
    kind: "pane",
    id: paneId,
    tabInstanceIds: tabs.map((tab) => tab.instanceId),
    activeTabId,
    previewTabId: null,
    activationHistory: activeTabId === null ? [] : [activeTabId],
  };
  testState.canvasTiles = Object.fromEntries(
    tabs.map((tab) => [tab.instanceId, tab]),
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSearchUpdater(
  value: unknown,
): value is (prev: Readonly<Record<string, unknown>>) => unknown {
  return typeof value === "function";
}

function lastNavigateSearchPatch(): Readonly<Record<string, unknown>> {
  const call = testState.navigate.mock.calls.at(-1);
  if (call === undefined) throw new Error("expected navigate call");
  const options: unknown = call[0];
  if (!isRecord(options)) throw new Error("expected navigate options");
  const search = options.search;
  if (!isSearchUpdater(search)) {
    throw new Error("expected search updater");
  }
  const result: unknown = search({});
  if (!isRecord(result)) throw new Error("expected search patch result");
  return result;
}

/**
 * The applied-nested-target focus restore runs inside a `requestAnimationFrame`.
 * Await two frames (wrapped in `act` so React state settles) to let that
 * scheduled `.focus()` land before asserting.
 */
async function flushFocusRestore(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => resolve());
      });
    });
  });
}

describe("useEpicRouteSynchronization", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("canonicalizes a desktop route with no nested params to the current canvas focus", async () => {
    testState.nestedFocusEnabled = true;
    setSinglePaneCanvas(
      "pane-current",
      [specTile("artifact-current", "tile-current", "Current artifact")],
      "tile-current",
    );

    renderHook(
      (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
      {
        initialProps: {
          epicId: EPIC_ID,
          tabId: TAB_ID,
          focusedAt: undefined,
          focusArtifactId: undefined,
          focusThreadId: undefined,
          focusPaneId: undefined,
          focusTileInstanceId: undefined,
        },
      },
    );

    await waitFor(() => {
      expect(testState.navigate).toHaveBeenCalled();
    });
    expect(lastNavigateSearchPatch()).toMatchObject({
      focusPaneId: "pane-current",
      focusTileInstanceId: "tile-current",
    });
    expect(testState.navigate.mock.calls.at(-1)?.[0]).toMatchObject({
      to: "/epics/$epicId/$tabId",
      params: { epicId: EPIC_ID, tabId: TAB_ID },
      replace: true,
    });
  });

  it("lets legacy artifact focus resolve before canonicalizing missing nested params", async () => {
    testState.nestedFocusEnabled = true;
    setSinglePaneCanvas(
      "pane-existing",
      [specTile("artifact-existing", "tile-existing", "Existing artifact")],
      "tile-existing",
    );

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
    expect(testState.navigate).not.toHaveBeenCalled();

    testState.activeArtifactId = "artifact-1";
    setSinglePaneCanvas(
      "pane-focused",
      [specTile("artifact-1", "tile-focused", "Focused artifact")],
      "tile-focused",
    );
    hook.rerender({
      ...THREAD_FOCUS_INTENT,
      focusThreadId: undefined,
    });

    await waitFor(() => {
      expect(testState.navigate).toHaveBeenCalled();
    });
    expect(lastNavigateSearchPatch()).toMatchObject({
      focusPaneId: "pane-focused",
      focusTileInstanceId: "tile-focused",
    });
  });

  it("applies valid nested params with the raw canvas focus action", async () => {
    testState.nestedFocusEnabled = true;
    setSinglePaneCanvas(
      "pane-current",
      [
        specTile("artifact-a", "tile-a", "Artifact A"),
        specTile("artifact-b", "tile-b", "Artifact B"),
      ],
      "tile-a",
    );

    renderHook(
      (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
      {
        initialProps: {
          epicId: EPIC_ID,
          tabId: TAB_ID,
          focusedAt: undefined,
          focusArtifactId: undefined,
          focusThreadId: undefined,
          focusPaneId: "pane-current",
          focusTileInstanceId: "tile-b",
        },
      },
    );

    await waitFor(() => {
      expect(testState.canvasStore.applyNestedRouteFocus).toHaveBeenCalledWith(
        TAB_ID,
        {
          paneId: "pane-current",
          tileInstanceId: "tile-b",
        },
      );
    });
    expect(testState.navigate).not.toHaveBeenCalled();
    expect(testState.canvasStore.openTileInTab).not.toHaveBeenCalled();
  });

  it("treats a pane-only route as applied when the active pane contains a tile", async () => {
    testState.nestedFocusEnabled = true;
    setSinglePaneCanvas(
      "pane-current",
      [specTile("artifact-current", "tile-current", "Current artifact")],
      "tile-current",
    );

    renderHook(
      (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
      {
        initialProps: {
          epicId: EPIC_ID,
          tabId: TAB_ID,
          focusedAt: undefined,
          focusArtifactId: undefined,
          focusThreadId: undefined,
          focusPaneId: "pane-current",
          focusTileInstanceId: undefined,
        },
      },
    );

    await waitFor(() => {
      expect(testState.navigate).not.toHaveBeenCalled();
      expect(
        testState.canvasStore.applyNestedRouteFocus,
      ).not.toHaveBeenCalled();
    });
  });

  it("treats mismatched legacy artifact fields as inert when nested params are present", async () => {
    testState.nestedFocusEnabled = true;
    testState.activeArtifactId = "artifact-current";
    setSinglePaneCanvas(
      "pane-current",
      [specTile("artifact-current", "tile-current", "Current artifact")],
      "tile-current",
    );

    renderHook(
      (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
      {
        initialProps: {
          ...THREAD_FOCUS_INTENT,
          focusPaneId: "pane-current",
          focusTileInstanceId: "tile-current",
        },
      },
    );

    await waitFor(() => {
      expect(testState.navigate).not.toHaveBeenCalled();
      expect(testState.canvasStore.openTileInTab).not.toHaveBeenCalled();
      expect(
        testState.openEpicState.setLastFocusedArtifactId,
      ).not.toHaveBeenCalledWith("artifact-1");
      expect(
        testState.openEpicState.setLastFocusedThreadId,
      ).not.toHaveBeenCalled();
      expect(useLeftPanelStore.getState().isCommentsPanelRevealed(TAB_ID)).toBe(
        false,
      );
      expect(
        useCommentThreadsStore.getState().activeByEpicId[EPIC_ID],
      ).toBeUndefined();
    });
  });

  it("recovers a stale current nested route to the current valid focus", async () => {
    testState.nestedFocusEnabled = true;
    setSinglePaneCanvas(
      "pane-current",
      [specTile("artifact-current", "tile-current", "Current artifact")],
      "tile-current",
    );

    renderHook(
      (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
      {
        initialProps: {
          epicId: EPIC_ID,
          tabId: TAB_ID,
          focusedAt: undefined,
          focusArtifactId: undefined,
          focusThreadId: undefined,
          focusPaneId: "pane-current",
          focusTileInstanceId: "tile-stale",
        },
      },
    );

    await waitFor(() => {
      expect(testState.navigate).toHaveBeenCalled();
    });
    expect(lastNavigateSearchPatch()).toMatchObject({
      focusPaneId: "pane-current",
      focusTileInstanceId: "tile-current",
    });
    expect(testState.canvasStore.applyNestedRouteFocus).not.toHaveBeenCalled();
  });

  it("clears stale nested params when no valid current focus exists", async () => {
    testState.nestedFocusEnabled = true;
    testState.canvasRoot = {
      kind: "pane",
      id: "pane-empty",
      tabInstanceIds: [],
      activeTabId: null,
      previewTabId: null,
      activationHistory: [],
    };
    testState.canvasActivePaneId = "pane-missing";
    testState.canvasTiles = {};

    renderHook(
      (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
      {
        initialProps: {
          epicId: EPIC_ID,
          tabId: TAB_ID,
          focusedAt: undefined,
          focusArtifactId: undefined,
          focusThreadId: undefined,
          focusPaneId: "pane-stale",
          focusTileInstanceId: undefined,
        },
      },
    );

    await waitFor(() => {
      expect(testState.navigate).toHaveBeenCalled();
    });
    expect(lastNavigateSearchPatch()).toMatchObject({
      focusPaneId: undefined,
      focusTileInstanceId: undefined,
    });
    expect(testState.canvasStore.applyNestedRouteFocus).not.toHaveBeenCalled();
  });

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
      repositoryContext: null,
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
          focusPaneId: undefined,
          focusTileInstanceId: undefined,
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

  it("keeps editor focus when a canvas mutation re-runs an already-applied nested focus target", async () => {
    testState.nestedFocusEnabled = true;
    setSinglePaneCanvas(
      "pane-current",
      [specTile("artifact-current", "tile-current", "Current artifact")],
      "tile-current",
    );

    // Mirror the canvas DOM the focus restore queries: the selected tab layer
    // (an ancestor with `tabIndex=-1`) wraps the editable artifact body, just
    // like pane → tab layer → ProseMirror surface in the app.
    const paneEl = document.createElement("div");
    paneEl.setAttribute("data-group-id", "pane-current");
    paneEl.setAttribute("data-active", "true");
    paneEl.tabIndex = -1;
    const tileEl = document.createElement("div");
    tileEl.setAttribute("data-tab-instance-id", "tile-current");
    tileEl.setAttribute("data-selected", "true");
    tileEl.tabIndex = -1;
    const editorEl = document.createElement("textarea");
    tileEl.appendChild(editorEl);
    paneEl.appendChild(tileEl);
    document.body.appendChild(paneEl);

    try {
      const hook = renderHook(
        (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
        {
          initialProps: {
            epicId: EPIC_ID,
            tabId: TAB_ID,
            focusedAt: undefined,
            focusArtifactId: undefined,
            focusThreadId: undefined,
            focusPaneId: "pane-current",
            focusTileInstanceId: "tile-current",
          },
        },
      );

      // First application of the target legitimately restores focus to the tab
      // container - a genuine tab switch has no deeper focus to preserve.
      await waitFor(() => {
        expect(document.activeElement).toBe(tileEl);
      });

      // The user clicks into the body and starts typing.
      editorEl.focus();
      expect(document.activeElement).toBe(editorEl);

      // A title rename (Notion-style doc-title-follow, or a tab rename) mutates
      // the canvas, so `useEpicCanvas` hands back a new identity and the focus
      // effect re-runs with the SAME, still-applied target. It must not yank
      // focus back up to the tab container and eject the user from edit mode.
      testState.canvasTiles = {
        "tile-current": specTile("artifact-current", "tile-current", "Renamed"),
      };
      hook.rerender({
        epicId: EPIC_ID,
        tabId: TAB_ID,
        focusedAt: undefined,
        focusArtifactId: undefined,
        focusThreadId: undefined,
        focusPaneId: "pane-current",
        focusTileInstanceId: "tile-current",
      });
      await flushFocusRestore();

      expect(document.activeElement).toBe(editorEl);
    } finally {
      paneEl.remove();
    }
  });

  it("does not re-focus the tile when a rename fires while focus sits outside it (tab-strip rename)", async () => {
    testState.nestedFocusEnabled = true;
    setSinglePaneCanvas(
      "pane-current",
      [specTile("artifact-current", "tile-current", "Current artifact")],
      "tile-current",
    );

    // The tab-strip rename input lives in the pane but OUTSIDE the tile layer,
    // mirroring the real DOM (strip is a sibling of the tab body).
    const paneEl = document.createElement("div");
    paneEl.setAttribute("data-group-id", "pane-current");
    paneEl.setAttribute("data-active", "true");
    paneEl.tabIndex = -1;
    const renameInputEl = document.createElement("input");
    const tileEl = document.createElement("div");
    tileEl.setAttribute("data-tab-instance-id", "tile-current");
    tileEl.setAttribute("data-selected", "true");
    tileEl.tabIndex = -1;
    paneEl.appendChild(renameInputEl);
    paneEl.appendChild(tileEl);
    document.body.appendChild(paneEl);

    try {
      const hook = renderHook(
        (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
        {
          initialProps: {
            epicId: EPIC_ID,
            tabId: TAB_ID,
            focusedAt: undefined,
            focusArtifactId: undefined,
            focusThreadId: undefined,
            focusPaneId: "pane-current",
            focusTileInstanceId: "tile-current",
          },
        },
      );

      // Tab was activated earlier: its focus restore has already run once.
      await waitFor(() => {
        expect(document.activeElement).toBe(tileEl);
      });

      // The user opens the tab's rename input and commits. Focus is in the
      // strip input (not the tile) and the commit mutates the canvas.
      renameInputEl.focus();
      expect(document.activeElement).toBe(renameInputEl);

      testState.canvasTiles = {
        "tile-current": specTile("artifact-current", "tile-current", "Renamed"),
      };
      hook.rerender({
        epicId: EPIC_ID,
        tabId: TAB_ID,
        focusedAt: undefined,
        focusArtifactId: undefined,
        focusThreadId: undefined,
        focusPaneId: "pane-current",
        focusTileInstanceId: "tile-current",
      });
      await flushFocusRestore();

      // The rename did not change the focus target, so the restore must not
      // fire and stamp the stray selection ring onto the tile.
      expect(document.activeElement).toBe(renameInputEl);
    } finally {
      paneEl.remove();
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paneTabRefs, setActiveTab } from "@/stores/epics/canvas/actions";
import { createEmptyCanvas } from "@/stores/epics/canvas/canvas-state";
import { collectPanes, findPaneById } from "@/stores/epics/canvas/tile-tree";
import { serializeEpicCanvasState } from "@/stores/epics/canvas/migrate-canvas";
import {
  applyEpicCanvasDesktopProjection,
  makeSelectActiveEpicArtifactId,
  makeSelectIsActiveEpicArtifact,
  makeSelectIsActivePane,
  makeSelectTabActivation,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import { epicCanvasKey } from "@/lib/persist";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
  EpicViewTab,
  TilePane,
} from "@/stores/epics/canvas/types";
import type { DesktopPerWindowSnapshot } from "@/lib/windows/types";
import { SPEC_A, SPEC_B, SPEC_C, TEST_HOST_ID } from "./canvas-test-fixtures";

// Resolve a pane's tab payloads in strip order via tilesByInstanceId.
function tabRefsOfPane(
  canvas: EpicCanvasState,
  pane: TilePane,
): ReadonlyArray<EpicCanvasTileRef> {
  return paneTabRefs(canvas, pane);
}

// Content ids of every tab across all panes of a canvas, in pane+strip order.
function allTabIds(canvas: EpicCanvasState): ReadonlyArray<string> {
  return collectPanes(canvas.root).flatMap((pane) =>
    tabRefsOfPane(canvas, pane).map((ref) => ref.id),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  useEpicCanvasStore.persist.setOptions({ name: epicCanvasKey(null) });
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

afterEach(() => {
  vi.restoreAllMocks();
  useEpicCanvasStore.getState().clearAllTitleGenerationPending();
});

function requireTab(tabId: string): EpicViewTab {
  const tab = useEpicCanvasStore.getState().tabsById[tabId];
  if (tab === undefined) throw new Error(`Expected tab ${tabId}`);
  return tab;
}

function requireCanvas(tabId: string): EpicCanvasState {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) throw new Error(`Expected canvas for ${tabId}`);
  return canvas;
}

describe("epic canvas store header tabs", () => {
  it("sanitizes removed Workspaces tile refs from local persisted state", async () => {
    window.localStorage.setItem(
      epicCanvasKey(null),
      JSON.stringify({
        state: {
          tabsById: {
            "tab-legacy": {
              tabId: "tab-legacy",
              epicId: "epic-legacy",
              name: "Legacy Epic",
              canvas: {
                root: {
                  kind: "group",
                  id: "group-legacy",
                  tabs: [
                    {
                      id: "workspaces",
                      type: "workspaces",
                      name: "Workspaces",
                    },
                  ],
                  activeTabId: "workspaces",
                  previewTabId: null,
                },
                activeGroupId: "group-legacy",
              },
              lastSeenAt: 1,
            },
          },
          openTabOrder: ["missing", "tab-legacy", "tab-legacy"],
          activeTabId: "missing",
          mostRecentTabIdByEpicId: {
            "epic-legacy": "tab-legacy",
            "epic-missing": "missing",
          },
          artifactTreeByEpicId: {
            "epic-legacy": [
              {
                id: "workspaces",
                parentId: null,
                name: "Workspaces",
                type: "workspaces",
                hostId: TEST_HOST_ID,
              },
              {
                id: SPEC_A.id,
                parentId: null,
                name: SPEC_A.name,
                type: SPEC_A.type,
                hostId: SPEC_A.hostId,
              },
            ],
          },
        },
        version: 1,
      }),
    );

    await useEpicCanvasStore.persist.rehydrate();

    const state = useEpicCanvasStore.getState();
    expect(state.openTabOrder).toEqual(["tab-legacy"]);
    expect(state.activeTabId).toBe("tab-legacy");
    expect(state.mostRecentTabIdByEpicId).toEqual({
      "epic-legacy": "tab-legacy",
    });
    expect(requireCanvas("tab-legacy")).toEqual(createEmptyCanvas());
    expect(state.artifactTreeByEpicId["epic-legacy"]).toEqual([
      {
        id: SPEC_A.id,
        parentId: null,
        name: SPEC_A.name,
        type: SPEC_A.type,
        hostId: SPEC_A.hostId,
      },
    ]);
  });

  it("re-roots a child whose parent node is dropped during local persisted sanitize", async () => {
    window.localStorage.setItem(
      epicCanvasKey(null),
      JSON.stringify({
        state: {
          tabsById: {},
          openTabOrder: [],
          activeTabId: null,
          mostRecentTabIdByEpicId: {},
          artifactTreeByEpicId: {
            "epic-orphan": [
              {
                // Removed kind → dropped by the sanitizer.
                id: "workspaces",
                parentId: null,
                name: "Workspaces",
                type: "workspaces",
                hostId: TEST_HOST_ID,
              },
              {
                // Points at the dropped parent above.
                id: SPEC_A.id,
                parentId: "workspaces",
                name: SPEC_A.name,
                type: SPEC_A.type,
                hostId: SPEC_A.hostId,
              },
            ],
          },
        },
        version: 1,
      }),
    );

    await useEpicCanvasStore.persist.rehydrate();

    // The invalid parent is dropped and its surviving child is re-rooted
    // (parentId null) rather than left with a dangling parentId.
    expect(
      useEpicCanvasStore.getState().artifactTreeByEpicId["epic-orphan"],
    ).toEqual([
      {
        id: SPEC_A.id,
        parentId: null,
        name: SPEC_A.name,
        type: SPEC_A.type,
        hostId: SPEC_A.hostId,
      },
    ]);
  });

  it("does not reopen persisted tabs that are absent from openTabOrder", async () => {
    window.localStorage.setItem(
      epicCanvasKey(null),
      JSON.stringify({
        state: {
          tabsById: {
            "tab-hidden": {
              tabId: "tab-hidden",
              epicId: "epic-hidden",
              name: "Hidden Epic",
              canvas: {
                root: null,
                activeGroupId: null,
              },
              lastSeenAt: 1,
            },
          },
          openTabOrder: [],
          activeTabId: null,
          mostRecentTabIdByEpicId: {
            "epic-hidden": "tab-hidden",
          },
          artifactTreeByEpicId: {
            "epic-hidden": [],
          },
        },
        version: 1,
      }),
    );

    await useEpicCanvasStore.persist.rehydrate();

    const state = useEpicCanvasStore.getState();
    expect(state.tabsById["tab-hidden"]?.epicId).toBe("epic-hidden");
    expect(state.openTabOrder).toEqual([]);
    expect(state.resolveTabIdForEpic("epic-hidden")).toBe("tab-hidden");
  });

  it("keeps legacy persisted tabs regardless of a now-removed lastSeenAt", async () => {
    // `lastSeenAt` was removed (write-only dead weight). Legacy persisted data
    // may omit it or carry a stale/invalid value; tabs are kept on the strength
    // of tabId/epicId/name alone. Each tab still gets an (empty) canvas in the
    // top-level `canvasByTabId` map.
    window.localStorage.setItem(
      epicCanvasKey(null),
      JSON.stringify({
        state: {
          tabsById: {
            "tab-missing": {
              tabId: "tab-missing",
              epicId: "epic-missing",
              name: "Missing Timestamp",
            },
            "tab-invalid": {
              tabId: "tab-invalid",
              epicId: "epic-invalid",
              name: "Invalid Timestamp",
              lastSeenAt: -1,
            },
          },
          openTabOrder: ["tab-missing", "tab-invalid"],
          activeTabId: "tab-missing",
          mostRecentTabIdByEpicId: {
            "epic-missing": "tab-missing",
            "epic-invalid": "tab-invalid",
          },
          artifactTreeByEpicId: {
            "epic-missing": [],
            "epic-invalid": [],
          },
        },
        version: 1,
      }),
    );

    await useEpicCanvasStore.persist.rehydrate();

    const state = useEpicCanvasStore.getState();
    expect(state.openTabOrder).toEqual(["tab-missing", "tab-invalid"]);
    expect(state.activeTabId).toBe("tab-missing");
    expect(state.tabsById["tab-missing"]).toEqual({
      tabId: "tab-missing",
      epicId: "epic-missing",
      name: "Missing Timestamp",
    });
    expect(state.tabsById["tab-missing"]).not.toHaveProperty("lastSeenAt");
    expect(state.canvasByTabId["tab-invalid"]).toEqual(createEmptyCanvas());
  });

  it("does not persist title generation pending state", () => {
    const store = useEpicCanvasStore.getState();
    store.openEpicTab("epic-title", "Initial title");
    store.markEpicTitlePending("epic-title", "Initial title");
    store.markChatTitlePending("chat-title", "Initial title");

    const raw = window.localStorage.getItem(epicCanvasKey(null));
    if (raw === null) throw new Error("expected persisted canvas state");
    const persisted = JSON.parse(raw) as {
      readonly state: Record<string, unknown>;
    };

    expect(persisted.state).not.toHaveProperty("pendingEpicTitles");
    expect(persisted.state).not.toHaveProperty("pendingChatTitles");
  });

  it("opens an epic in a background tab without changing the active tab", () => {
    const store = useEpicCanvasStore.getState();
    const activeTabId = store.openEpicTab("epic-active", "Active");
    expect(useEpicCanvasStore.getState().activeTabId).toBe(activeTabId);

    const backgroundTabId = store.openEpicTabInBackground(
      "epic-background",
      "Background",
    );

    const state = useEpicCanvasStore.getState();
    expect(state.activeTabId).toBe(activeTabId);
    expect(state.openTabOrder).toContain(backgroundTabId);
    expect(state.tabsById[backgroundTabId]?.epicId).toBe("epic-background");
  });

  it("reuses the existing tab when opening an already-open epic in background", () => {
    const store = useEpicCanvasStore.getState();
    const existingTabId = store.openEpicTab("epic-reuse", "Reuse");
    const otherTabId = store.openEpicTab("epic-other", "Other");
    expect(useEpicCanvasStore.getState().activeTabId).toBe(otherTabId);

    const resolved = store.openEpicTabInBackground("epic-reuse", "Reuse");

    const state = useEpicCanvasStore.getState();
    expect(resolved).toBe(existingTabId);
    expect(state.activeTabId).toBe(otherTabId);
    expect(
      state.openTabOrder.filter(
        (id) => state.tabsById[id]?.epicId === "epic-reuse",
      ),
    ).toEqual([existingTabId]);
  });

  it("hides a closed tab while preserving its canvas for reopen", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-restore", "Restore Me");
    store.openTileInTab(tabId, SPEC_A);

    const beforeCloseCanvas = requireCanvas(tabId);
    const beforeCloseTab = requireTab(tabId);
    store.closeTab(tabId);

    let state = useEpicCanvasStore.getState();
    expect(state.openTabOrder).toEqual([]);
    expect(state.activeTabId).toBeNull();
    expect(state.canvasByTabId[tabId]).toBe(beforeCloseCanvas);
    // Hiding preserves the tab record BY IDENTITY (closing no longer bumps a
    // lastSeenAt), so header-strip / command-palette consumers that read tab
    // metadata don't re-render on close.
    expect(state.tabsById[tabId]).toBe(beforeCloseTab);
    expect(state.mostRecentTabIdByEpicId["epic-restore"]).toBe(tabId);

    const restoredTabId = useEpicCanvasStore
      .getState()
      .resolveTargetTabForEpic("epic-restore", "Ignored");

    state = useEpicCanvasStore.getState();
    expect(restoredTabId).toBe(tabId);
    expect(state.openTabOrder).toEqual([tabId]);
    expect(state.activeTabId).toBe(tabId);
    expect(state.canvasByTabId[tabId]).toBe(beforeCloseCanvas);
    // Re-activation also leaves the tab record identity intact.
    expect(state.tabsById[tabId]).toBe(beforeCloseTab);
  });

  it("keeps hidden tabs when desktop projection refreshes the visible strip", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-hidden", "Hidden Epic");
    store.openTileInTab(tabId, SPEC_A);
    const preservedCanvas = requireCanvas(tabId);
    store.closeTab(tabId);

    const snapshot: DesktopPerWindowSnapshot = {
      epicTabs: [],
      activeTabId: null,
      canvasByTabId: {},
      landingDrafts: [],
      activeLandingDraftId: null,
    };

    applyEpicCanvasDesktopProjection(snapshot);

    let state = useEpicCanvasStore.getState();
    expect(state.openTabOrder).toEqual([]);
    expect(state.activeTabId).toBeNull();
    expect(state.canvasByTabId[tabId]).toBe(preservedCanvas);
    expect(state.mostRecentTabIdByEpicId["epic-hidden"]).toBe(tabId);

    const restoredTabId = state.resolveTargetTabForEpic(
      "epic-hidden",
      "Ignored",
    );

    state = useEpicCanvasStore.getState();
    expect(restoredTabId).toBe(tabId);
    expect(state.openTabOrder).toEqual([tabId]);
    expect(state.activeTabId).toBe(tabId);
    expect(state.canvasByTabId[tabId]).toBe(preservedCanvas);
  });

  it("preserves tab-record identity across a metadata-unchanged projection", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Epic One");
    const before = requireTab(tabId);

    // The desktop sync echoes our own state back: a projection carrying the same
    // tab metadata must reuse the existing record (so header / palette / route
    // consumers don't re-render), while a changed name must mint a new one.
    const echo: DesktopPerWindowSnapshot = {
      epicTabs: [{ id: tabId, epicId: "epic-1", name: "Epic One" }],
      activeTabId: tabId,
      canvasByTabId: {},
      landingDrafts: [],
      activeLandingDraftId: null,
    };
    applyEpicCanvasDesktopProjection(echo);
    expect(useEpicCanvasStore.getState().tabsById[tabId]).toBe(before);

    applyEpicCanvasDesktopProjection({
      ...echo,
      epicTabs: [{ id: tabId, epicId: "epic-1", name: "Renamed" }],
    });
    const after = requireTab(tabId);
    expect(after).not.toBe(before);
    expect(after.name).toBe("Renamed");
  });

  it("preserves canvas identity across a canvas-unchanged projection echo", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Epic One");
    store.openTileInTab(tabId, SPEC_A);
    store.openTileInTab(tabId, SPEC_B);
    const before = requireCanvas(tabId);

    // The desktop sync echoes our own write back as a freshly-parsed canvas.
    // A structurally-equal echo must reuse the existing state reference so
    // pane views never re-render for it; a real change must mint a new one.
    const echo: DesktopPerWindowSnapshot = {
      epicTabs: [{ id: tabId, epicId: "epic-1", name: "Epic One" }],
      activeTabId: tabId,
      canvasByTabId: { [tabId]: serializeEpicCanvasState(before) },
      landingDrafts: [],
      activeLandingDraftId: null,
    };
    applyEpicCanvasDesktopProjection(echo);
    expect(requireCanvas(tabId)).toBe(before);

    const rootPaneId = before.activePaneId;
    if (rootPaneId === null) throw new Error("expected active pane");
    const changed = setActiveTab(before, rootPaneId, SPEC_A.instanceId);
    expect(changed).not.toBe(before);
    applyEpicCanvasDesktopProjection({
      ...echo,
      canvasByTabId: { [tabId]: serializeEpicCanvasState(changed) },
    });
    const after = requireCanvas(tabId);
    expect(after).not.toBe(before);
    const pane = findPaneById(after.root, rootPaneId);
    expect(pane?.activeTabId).toBe(SPEC_A.instanceId);
  });

  it("keeps a freshly-created untitled (empty-name) tab through a projection round-trip", () => {
    // Epics/agents are created with an empty stored title, so the projected
    // tab `name` is "". The tab is a real, structurally-valid tab (id +
    // epicId), and the display layer derives the shown title. It must survive
    // the desktop window-state projection round-trip and not be evicted as if
    // it were junk. A genuinely-malformed sibling (empty epicId) is dropped.
    const snapshot: DesktopPerWindowSnapshot = {
      epicTabs: [
        { id: "tab-untitled", epicId: "epic-untitled", name: "" },
        { id: "tab-malformed", epicId: "", name: "" },
      ],
      activeTabId: "tab-untitled",
      canvasByTabId: {},
      landingDrafts: [],
      activeLandingDraftId: null,
    };

    applyEpicCanvasDesktopProjection(snapshot);

    const state = useEpicCanvasStore.getState();
    expect(state.openTabOrder).toEqual(["tab-untitled"]);
    expect(state.activeTabId).toBe("tab-untitled");
    const tab = requireTab("tab-untitled");
    expect(tab.epicId).toBe("epic-untitled");
    expect(tab.name).toBe("");
    expect(state.tabsById["tab-malformed"]).toBeUndefined();
  });

  it("duplicates a tab beside the source with independent canvas ids", () => {
    const store = useEpicCanvasStore.getState();
    const sourceTabId = store.openEpicTab("epic-1", "Epic Foo");
    store.openTileInTab(sourceTabId, SPEC_A);
    const sourceGroupId = requireCanvas(sourceTabId).activePaneId;
    if (sourceGroupId === null) throw new Error("expected active group");
    store.splitPaneWithNode(sourceTabId, sourceGroupId, "right", SPEC_B);

    const cloneTabId = useEpicCanvasStore.getState().duplicateTab(sourceTabId);
    if (cloneTabId === null) throw new Error("expected clone");
    const state = useEpicCanvasStore.getState();
    const source = requireTab(sourceTabId);
    const clone = requireTab(cloneTabId);
    const sourceCanvas = requireCanvas(sourceTabId);
    const cloneCanvas = requireCanvas(cloneTabId);

    expect(state.openTabOrder).toEqual([sourceTabId, cloneTabId]);
    expect(state.activeTabId).toBe(cloneTabId);
    expect(clone.name).toBe("Epic Foo (copy)");
    expect(clone.epicId).toBe(source.epicId);
    expect(collectPanes(cloneCanvas.root).map((pane) => pane.id)).not.toEqual(
      collectPanes(sourceCanvas.root).map((pane) => pane.id),
    );
    // Content ids survive the clone (only pane/instance ids are refreshed).
    expect(allTabIds(cloneCanvas)).toEqual(allTabIds(sourceCanvas));
  });

  it("creates a fresh single-tile tab for a dropped sidebar artifact", () => {
    const store = useEpicCanvasStore.getState();
    store.openEpicTab("epic-1", "Epic Foo");

    const tabId = useEpicCanvasStore
      .getState()
      .openTileInNewTab("epic-1", SPEC_C, null);
    if (tabId === null) throw new Error("expected tab");
    const tab = requireTab(tabId);
    const canvas = requireCanvas(tabId);
    const panes = collectPanes(canvas.root);

    expect(tab.epicId).toBe("epic-1");
    expect(tab.name).toBe("Epic Foo (copy)");
    expect(panes).toHaveLength(1);
    expect(tabRefsOfPane(canvas, panes[0])).toEqual([SPEC_C]);
    expect(canvas.activePaneId).toBe(panes[0].id);
  });

  /**
   * Cross-tab canvas isolation guard (ticket 12).
   *
   * Tab A's mutations must not touch tab B's canvas reference. The
   * regression this guards against: a shared canvas reference (or a
   * mutation that walks the wrong tab's tree) would re-render every
   * other tab's tiles whenever any one tab moves a tile around.
   */
  it("keeps tab B's canvas identity stable across tab A mutations (cross-tab isolation)", () => {
    const store = useEpicCanvasStore.getState();
    const tabAId = store.openEpicTab("epic-iso", "Epic Iso");
    store.openTileInTab(tabAId, SPEC_A);
    const tabBId = useEpicCanvasStore.getState().duplicateTab(tabAId);
    if (tabBId === null) throw new Error("expected duplicated tab");

    const tabBSnapshot = requireCanvas(tabBId);
    const tabBRootSnapshot = tabBSnapshot.root;
    const tabBGroupsSnapshot = collectPanes(tabBRootSnapshot).map(
      (pane) => pane.id,
    );

    // Mutation 1: open a new artifact in tab A.
    useEpicCanvasStore.getState().openTileInTab(tabAId, SPEC_B);
    expect(requireCanvas(tabBId)).toBe(tabBSnapshot);

    // Mutation 2: split tab A's active group.
    const tabAActiveGroupId = requireCanvas(tabAId).activePaneId ?? null;
    if (tabAActiveGroupId === null) throw new Error("expected tab A group");
    useEpicCanvasStore
      .getState()
      .splitPaneWithNode(tabAId, tabAActiveGroupId, "right", SPEC_C);
    expect(requireCanvas(tabBId)).toBe(tabBSnapshot);

    // Mutation 3: rename tab A.
    useEpicCanvasStore.getState().renameTab(tabAId, "Renamed A");
    expect(requireCanvas(tabBId)).toBe(tabBSnapshot);

    // Tab B's tree is structurally distinct (no shared pane ids).
    const tabAGroupIds = collectPanes(requireCanvas(tabAId).root).map(
      (pane) => pane.id,
    );
    expect(tabBGroupsSnapshot.some((id) => tabAGroupIds.includes(id))).toBe(
      false,
    );
  });

  it("tears a canvas tile tab into a new header tab", () => {
    const store = useEpicCanvasStore.getState();
    const sourceTabId = store.openEpicTab("epic-1", "Epic Foo");
    store.openTileInTab(sourceTabId, SPEC_A);
    store.openTileInTab(sourceTabId, SPEC_B);
    const sourceCanvas = requireCanvas(sourceTabId);
    const sourceGroupId = sourceCanvas.activePaneId;
    if (sourceGroupId === null) throw new Error("expected active group");

    const newTabId = useEpicCanvasStore.getState().tearOffTabIntoNewHeaderTab({
      sourceTabId,
      sourcePaneId: sourceGroupId,
      sourceTileTabId: SPEC_A.instanceId,
      insertIndex: 1,
    });
    if (newTabId === null) throw new Error("expected tear-off tab");
    const state = useEpicCanvasStore.getState();
    const sourceAfter = requireCanvas(sourceTabId);
    const newCanvas = requireCanvas(newTabId);
    const newPanes = collectPanes(newCanvas.root);

    expect(state.openTabOrder).toEqual([sourceTabId, newTabId]);
    expect(allTabIds(sourceAfter)).toEqual([SPEC_B.id]);
    expect(newPanes).toHaveLength(1);
    expect(tabRefsOfPane(newCanvas, newPanes[0])).toEqual([SPEC_A]);
    expect(state.activeTabId).toBe(newTabId);
  });

  it("closes every header tab for a deleted epic", () => {
    const store = useEpicCanvasStore.getState();
    const firstDeletedTabId = store.openEpicTab("epic-delete", "Delete Me");
    const secondDeletedTabId = store.duplicateTab(firstDeletedTabId);
    if (secondDeletedTabId === null) throw new Error("expected clone");
    const keptTabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-keep", "Keep Me");
    useEpicCanvasStore.getState().setActiveTab(secondDeletedTabId);

    useEpicCanvasStore.getState().closeTabsForEpics(["epic-delete"]);

    const state = useEpicCanvasStore.getState();
    expect(state.openTabOrder).toEqual([keptTabId]);
    expect(state.activeTabId).toBe(keptTabId);
    expect(state.tabsById[firstDeletedTabId]).toBeUndefined();
    expect(state.tabsById[secondDeletedTabId]).toBeUndefined();
    expect(state.tabsById[keptTabId]?.epicId).toBe("epic-keep");
    expect(state.mostRecentTabIdByEpicId["epic-delete"]).toBeUndefined();
    expect(state.artifactTreeByEpicId["epic-delete"]).toBeUndefined();
  });

  it("splitPaneEmptyRightInTab returns the new empty group id (now active)", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-split", "Epic");
    store.openTileInTab(tabId, SPEC_A);
    const sourceGroupId = requireCanvas(tabId).activePaneId;
    if (sourceGroupId === null) throw new Error("expected a source group");

    const newGroupId = useEpicCanvasStore
      .getState()
      .splitPaneEmptyRightInTab(tabId, sourceGroupId);

    expect(newGroupId).not.toBeNull();
    expect(newGroupId).not.toBe(sourceGroupId);
    // splitPaneEmpty makes the new empty pane active.
    expect(requireCanvas(tabId).activePaneId).toBe(newGroupId);
    const emptyPane = collectPanes(requireCanvas(tabId).root).find(
      (pane) => pane.id === newGroupId,
    );
    expect(emptyPane?.tabInstanceIds).toHaveLength(0);
  });

  it("splitPaneEmptyInTab returns null when the tab does not exist", () => {
    expect(
      useEpicCanvasStore
        .getState()
        .splitPaneEmptyInTab("missing-tab", "missing-group", "horizontal"),
    ).toBeNull();
  });
});

describe("makeSelectIsActiveEpicArtifact", () => {
  it("agrees with the active-id selector, per node, as a boolean", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-active", "Active");
    store.openTileInTab(tabId, SPEC_A);
    store.openTileInTab(tabId, SPEC_B);

    const state = useEpicCanvasStore.getState();
    const activeId = makeSelectActiveEpicArtifactId(tabId)(state);
    if (activeId === null) throw new Error("expected an active artifact");
    const otherId = activeId === SPEC_A.id ? SPEC_B.id : SPEC_A.id;

    // True only for the active node; false for any other / unknown / no tab.
    expect(makeSelectIsActiveEpicArtifact(tabId, activeId)(state)).toBe(true);
    expect(makeSelectIsActiveEpicArtifact(tabId, otherId)(state)).toBe(false);
    expect(makeSelectIsActiveEpicArtifact(tabId, "art-missing")(state)).toBe(
      false,
    );
    expect(makeSelectIsActiveEpicArtifact(undefined, activeId)(state)).toBe(
      false,
    );
  });

  it("flips for exactly the two affected nodes when the active artifact changes", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-flip", "Flip");
    store.openTileInTab(tabId, SPEC_A);
    store.openTileInTab(tabId, SPEC_B);

    const before = useEpicCanvasStore.getState();
    const firstActive = makeSelectActiveEpicArtifactId(tabId)(before);
    if (firstActive === null) throw new Error("expected an active artifact");
    const previousId = firstActive === SPEC_A.id ? SPEC_B.id : SPEC_A.id;

    // Re-open the previously-inactive artifact to make it active.
    store.openTileInTab(tabId, previousId === SPEC_A.id ? SPEC_A : SPEC_B);
    const after = useEpicCanvasStore.getState();

    expect(makeSelectIsActiveEpicArtifact(tabId, previousId)(after)).toBe(true);
    expect(makeSelectIsActiveEpicArtifact(tabId, firstActive)(after)).toBe(
      false,
    );
  });
});

// A deterministic two-group split: `group-left` is the globally-active group and
// holds an active (SPEC_A) + preview (SPEC_B) tab; `group-right` holds its own
// active tab (SPEC_C) but is NOT the globally-active group.
function seedTwoGroupSplit(): void {
  const leftPane: TilePane = {
    kind: "pane",
    id: "group-left",
    tabInstanceIds: [SPEC_A.instanceId, SPEC_B.instanceId],
    activeTabId: SPEC_A.instanceId,
    previewTabId: SPEC_B.instanceId,
  };
  const rightPane: TilePane = {
    kind: "pane",
    id: "group-right",
    tabInstanceIds: [SPEC_C.instanceId],
    activeTabId: SPEC_C.instanceId,
    previewTabId: null,
  };
  const canvas: EpicCanvasState = {
    activePaneId: "group-left",
    root: {
      kind: "group",
      id: "split-1",
      direction: "horizontal",
      children: [leftPane, rightPane],
    },
    tilesByInstanceId: {
      [SPEC_A.instanceId]: SPEC_A,
      [SPEC_B.instanceId]: SPEC_B,
      [SPEC_C.instanceId]: SPEC_C,
    },
    sizesByGroupId: { "split-1": [0.5, 0.5] },
  };
  useEpicCanvasStore.setState({
    tabsById: {
      "tab-1": {
        tabId: "tab-1",
        epicId: "epic-1",
        name: "Epic 1",
      },
    },
    canvasByTabId: {
      "tab-1": canvas,
    },
  });
}

describe("makeSelectIsActivePane", () => {
  it("is true for only the globally-active pane, as a boolean", () => {
    seedTwoGroupSplit();
    const state = useEpicCanvasStore.getState();

    expect(makeSelectIsActivePane("tab-1", "group-left")(state)).toBe(true);
    expect(makeSelectIsActivePane("tab-1", "group-right")(state)).toBe(false);
    // Unknown pane / unknown view-tab / no view-tab → false.
    expect(makeSelectIsActivePane("tab-1", "group-missing")(state)).toBe(false);
    expect(makeSelectIsActivePane("tab-missing", "group-left")(state)).toBe(
      false,
    );
    expect(makeSelectIsActivePane(undefined, "group-left")(state)).toBe(false);
  });
});

describe("makeSelectTabActivation", () => {
  it("reports per-tab active/preview/globally-active flags", () => {
    seedTwoGroupSplit();
    const state = useEpicCanvasStore.getState();

    // Active + globally-active tab of the active group.
    expect(
      makeSelectTabActivation("tab-1", "group-left", SPEC_A.instanceId)(state),
    ).toEqual({ isActive: true, isPreview: false, isGloballyActive: true });
    // Preview (and inactive) tab of the active group.
    expect(
      makeSelectTabActivation("tab-1", "group-left", SPEC_B.instanceId)(state),
    ).toEqual({ isActive: false, isPreview: true, isGloballyActive: false });
    // Active in its own group, but that group is NOT globally active, so
    // `isGloballyActive` stays false - the flag requires BOTH conditions.
    expect(
      makeSelectTabActivation("tab-1", "group-right", SPEC_C.instanceId)(state),
    ).toEqual({ isActive: true, isPreview: false, isGloballyActive: false });

    // Unknown tile / unknown group / no view-tab → all false.
    expect(
      makeSelectTabActivation("tab-1", "group-left", "missing")(state).isActive,
    ).toBe(false);
    expect(
      makeSelectTabActivation(
        "tab-1",
        "group-missing",
        SPEC_A.instanceId,
      )(state),
    ).toEqual({ isActive: false, isPreview: false, isGloballyActive: false });
    expect(
      makeSelectTabActivation(undefined, "group-left", SPEC_A.instanceId)(state)
        .isGloballyActive,
    ).toBe(false);
  });
});

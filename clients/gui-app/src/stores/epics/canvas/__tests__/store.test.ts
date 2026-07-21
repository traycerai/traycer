import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paneTabRefs, setActiveTab } from "@/stores/epics/canvas/actions";
import { createEmptyCanvas } from "@/stores/epics/canvas/canvas-state";
import {
  collectPanes,
  findPaneById,
  replacePane,
} from "@/stores/epics/canvas/tile-tree";
import {
  serializeCanvasByTabId,
  serializeEpicCanvasState,
} from "@/stores/epics/canvas/migrate-canvas";
import {
  applyEpicCanvasDesktopProjection,
  makeSelectActiveEpicArtifactId,
  makeSelectIsActiveEpicArtifact,
  makeSelectIsActivePane,
  makeSelectTabActivation,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import { isBlankTileRef } from "@/stores/epics/canvas/types";
import { epicCanvasKey } from "@/lib/persist";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
  EpicViewTab,
  TilePane,
} from "@/stores/epics/canvas/types";
import type { DesktopPerWindowSnapshot } from "@/lib/windows/types";
import {
  getCurrentNestedFocusTarget,
  type NestedFocusTarget,
} from "@/lib/epic-nested-focus-route";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requirePane(canvas: EpicCanvasState, paneId: string): TilePane {
  const pane = findPaneById(canvas.root, paneId);
  if (pane === null) throw new Error(`Expected pane ${paneId}`);
  return pane;
}

function requireNestedFocusTarget(tabId: string): NestedFocusTarget {
  const target = getCurrentNestedFocusTarget(requireCanvas(tabId));
  if (target === null) throw new Error(`Expected focus target for ${tabId}`);
  return target;
}

function requirePersistedCanvasByTabId(): Readonly<Record<string, unknown>> {
  const raw = window.localStorage.getItem(epicCanvasKey(null));
  if (raw === null) throw new Error("expected persisted canvas state");
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error("expected persisted record");
  const state = parsed.state;
  if (!isRecord(state)) throw new Error("expected persisted state record");
  const canvasByTabId = state.canvasByTabId;
  if (!isRecord(canvasByTabId)) {
    throw new Error("expected persisted canvasByTabId record");
  }
  return canvasByTabId;
}

function canvasWithPaneActivationHistory(
  canvas: EpicCanvasState,
  paneId: string,
  activationHistory: ReadonlyArray<string>,
): EpicCanvasState {
  if (canvas.root === null) throw new Error("expected canvas root");
  requirePane(canvas, paneId);
  return {
    ...canvas,
    root: replacePane(canvas.root, paneId, (pane) => ({
      ...pane,
      activationHistory,
    })),
  };
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

  it("persists pane activation history through canvasByTabId local storage", async () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-history", "History");
    store.openTileInTab(tabId, SPEC_A);
    store.openTileInTab(tabId, SPEC_B);

    const before = requireCanvas(tabId);
    const paneId = before.activePaneId;
    if (paneId === null) throw new Error("expected active pane");
    expect(requirePane(before, paneId).activationHistory).toEqual([
      SPEC_B.instanceId,
      SPEC_A.instanceId,
    ]);

    const serialized = serializeCanvasByTabId({ [tabId]: before });
    const persistedCanvasByTabId = requirePersistedCanvasByTabId();
    expect(persistedCanvasByTabId[tabId]).toEqual(serialized[tabId]);

    const raw = window.localStorage.getItem(epicCanvasKey(null));
    if (raw === null) throw new Error("expected persisted canvas state");
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    window.localStorage.setItem(epicCanvasKey(null), raw);

    await useEpicCanvasStore.persist.rehydrate();

    const after = requireCanvas(tabId);
    expect(requirePane(after, paneId).activationHistory).toEqual([
      SPEC_B.instanceId,
      SPEC_A.instanceId,
    ]);
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

  it("preserves same-history projection echoes and applies history-only changes", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-history", "Epic History");
    store.openTileInTab(tabId, SPEC_A);
    store.openTileInTab(tabId, SPEC_B);

    const before = requireCanvas(tabId);
    const paneId = before.activePaneId;
    if (paneId === null) throw new Error("expected active pane");
    const pane = requirePane(before, paneId);
    expect(pane.activeTabId).toBe(SPEC_B.instanceId);
    expect(pane.activationHistory).toEqual([
      SPEC_B.instanceId,
      SPEC_A.instanceId,
    ]);

    const echo: DesktopPerWindowSnapshot = {
      epicTabs: [{ id: tabId, epicId: "epic-history", name: "Epic History" }],
      activeTabId: tabId,
      canvasByTabId: { [tabId]: serializeEpicCanvasState(before) },
      landingDrafts: [],
      activeLandingDraftId: null,
    };
    applyEpicCanvasDesktopProjection(echo);
    expect(requireCanvas(tabId)).toBe(before);

    const changed = canvasWithPaneActivationHistory(before, paneId, [
      SPEC_B.instanceId,
    ]);
    applyEpicCanvasDesktopProjection({
      ...echo,
      canvasByTabId: { [tabId]: serializeEpicCanvasState(changed) },
    });

    const after = requireCanvas(tabId);
    expect(after).not.toBe(before);
    const afterPane = requirePane(after, paneId);
    expect(afterPane.activeTabId).toBe(SPEC_B.instanceId);
    expect(afterPane.activationHistory).toEqual([SPEC_B.instanceId]);
  });

  it("applies nested route focus without opening a new canvas tile", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-route-focus", "Epic Route Focus");
    store.openTileInTab(tabId, SPEC_A);
    store.openTileInTab(tabId, SPEC_B);

    const before = requireCanvas(tabId);
    const paneId = before.activePaneId;
    if (paneId === null) throw new Error("expected active pane");
    expect(requirePane(before, paneId).activeTabId).toBe(SPEC_B.instanceId);
    expect(allTabIds(before)).toEqual([SPEC_A.id, SPEC_B.id]);

    store.applyNestedRouteFocus(tabId, {
      paneId,
      tileInstanceId: SPEC_A.instanceId,
    });

    const after = requireCanvas(tabId);
    expect(requirePane(after, paneId).activeTabId).toBe(SPEC_A.instanceId);
    expect(after.activePaneId).toBe(paneId);
    expect(allTabIds(after)).toEqual([SPEC_A.id, SPEC_B.id]);
  });

  it("prepares exact targets for selecting tabs and focusing panes", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-prepare-select", "Prepare Select");
    store.openTileInTab(tabId, SPEC_A);
    store.openTileInTab(tabId, SPEC_B);
    const sourcePaneId = requireCanvas(tabId).activePaneId;
    if (sourcePaneId === null) throw new Error("expected source pane");

    expect(
      store.prepareSetActiveTileTabFocusTarget(
        tabId,
        sourcePaneId,
        SPEC_A.instanceId,
      ),
    ).toEqual({ paneId: sourcePaneId, tileInstanceId: SPEC_A.instanceId });
    expect(
      store.prepareSetActiveTileTabFocusTarget(
        tabId,
        sourcePaneId,
        SPEC_A.instanceId,
      ),
    ).toEqual({ paneId: sourcePaneId, tileInstanceId: SPEC_A.instanceId });

    const emptyTarget = store.prepareSplitPaneEmptyFocusTarget(
      tabId,
      sourcePaneId,
      "horizontal",
    );
    if (emptyTarget === null) throw new Error("expected empty pane target");
    expect(emptyTarget.tileInstanceId).toBeUndefined();
    expect(
      store.prepareSetActiveTilePaneFocusTarget(tabId, sourcePaneId),
    ).toEqual({ paneId: sourcePaneId, tileInstanceId: SPEC_A.instanceId });
    expect(
      store.prepareSetActiveTilePaneFocusTarget(tabId, emptyTarget.paneId),
    ).toEqual(emptyTarget);
  });

  it("prepares open targets for dedup, preview promotion, blank reuse, and fill-in-place", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-prepare-open", "Prepare Open");
    store.openTileInTab(tabId, SPEC_A);
    store.openTileInTab(tabId, SPEC_B);
    const paneId = requireCanvas(tabId).activePaneId;
    if (paneId === null) throw new Error("expected pane");

    expect(store.prepareOpenTileInTabFocusTarget(tabId, SPEC_A)).toEqual({
      paneId,
      tileInstanceId: SPEC_A.instanceId,
    });

    const previewTabId = store.openEpicTab(
      "epic-prepare-preview",
      "Prepare Preview",
    );
    store.openTilePreviewInTab(previewTabId, SPEC_A);
    const previewPaneId = requireCanvas(previewTabId).activePaneId;
    if (previewPaneId === null) throw new Error("expected preview pane");
    expect(
      requirePane(requireCanvas(previewTabId), previewPaneId).previewTabId,
    ).toBe(SPEC_A.instanceId);
    expect(store.prepareOpenTileInTabFocusTarget(previewTabId, SPEC_A)).toEqual(
      { paneId: previewPaneId, tileInstanceId: SPEC_A.instanceId },
    );
    expect(
      requirePane(requireCanvas(previewTabId), previewPaneId).previewTabId,
    ).toBeNull();

    const firstBlankTarget = store.prepareOpenBlankTabInPaneFocusTarget(
      tabId,
      paneId,
    );
    if (firstBlankTarget === null) throw new Error("expected blank target");
    const blankInstanceId = firstBlankTarget.tileInstanceId;
    if (blankInstanceId === undefined) throw new Error("expected blank tile");
    const blankRef = requireCanvas(tabId).tilesByInstanceId[blankInstanceId];
    if (blankRef === undefined) throw new Error("expected blank ref");
    expect(isBlankTileRef(blankRef)).toBe(true);
    expect(store.prepareOpenBlankTabInPaneFocusTarget(tabId, paneId)).toEqual(
      firstBlankTarget,
    );

    const fillTarget = store.prepareOpenTileInPaneFocusTarget(
      tabId,
      paneId,
      SPEC_C,
    );
    if (fillTarget === null || fillTarget.tileInstanceId === undefined) {
      throw new Error("expected fill-in-place target");
    }
    expect(fillTarget.tileInstanceId).not.toBe(blankInstanceId);
    expect(
      requireCanvas(tabId).tilesByInstanceId[fillTarget.tileInstanceId]?.id,
    ).toBe(SPEC_C.id);
    expect(
      store.prepareOpenTileInPaneFocusTarget(tabId, "missing-pane", SPEC_A),
    ).toBeNull();
  });

  it("prepares split and active-move targets", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-prepare-split", "Prepare Split");
    store.openTileInTab(tabId, SPEC_A);
    const sourcePaneId = requireCanvas(tabId).activePaneId;
    if (sourcePaneId === null) throw new Error("expected source pane");

    const splitTarget = store.prepareSplitPaneWithNodeFocusTarget(
      tabId,
      sourcePaneId,
      "right",
      SPEC_B,
    );
    if (splitTarget === null || splitTarget.tileInstanceId === undefined) {
      throw new Error("expected split target");
    }
    expect(splitTarget.paneId).not.toBe(sourcePaneId);
    expect(
      requireCanvas(tabId).tilesByInstanceId[splitTarget.tileInstanceId]?.id,
    ).toBe(SPEC_B.id);

    const emptyTarget = store.prepareSplitPaneEmptyFocusTarget(
      tabId,
      splitTarget.paneId,
      "horizontal",
    );
    if (emptyTarget === null) throw new Error("expected empty split target");
    expect(emptyTarget.tileInstanceId).toBeUndefined();

    store.setActiveTileTab(
      tabId,
      splitTarget.paneId,
      splitTarget.tileInstanceId,
    );
    const movedTarget = store.prepareMoveActiveTabOnTabStripFocusTarget(tabId, {
      sourcePaneId: splitTarget.paneId,
      tabId: splitTarget.tileInstanceId,
      targetPaneId: emptyTarget.paneId,
      targetIndex: 0,
    });

    expect(movedTarget).toEqual({
      paneId: emptyTarget.paneId,
      tileInstanceId: splitTarget.tileInstanceId,
    });
  });

  it("prepares close fallbacks for active targets and null for inactive close", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-prepare-close", "Prepare Close");
    store.openTileInTab(tabId, SPEC_A);
    store.openTileInTab(tabId, SPEC_B);
    const paneId = requireCanvas(tabId).activePaneId;
    if (paneId === null) throw new Error("expected pane");

    expect(
      store.prepareCloseCanvasTabFocusTarget(tabId, paneId, SPEC_B.instanceId),
    ).toEqual({ paneId, tileInstanceId: SPEC_A.instanceId });

    store.openTileInTab(tabId, SPEC_B);
    store.setActiveTileTab(tabId, paneId, SPEC_A.instanceId);

    expect(
      store.prepareCloseCanvasTabFocusTarget(tabId, paneId, SPEC_B.instanceId),
    ).toBeNull();
    expect(allTabIds(requireCanvas(tabId))).toEqual([SPEC_A.id]);

    const inactivePaneTarget = store.prepareSplitPaneWithNodeFocusTarget(
      tabId,
      paneId,
      "right",
      SPEC_C,
    );
    if (inactivePaneTarget === null) {
      throw new Error("expected inactive pane setup");
    }
    store.setActiveTilePane(tabId, paneId);
    expect(
      store.prepareCloseCanvasPaneFocusTarget(tabId, inactivePaneTarget.paneId),
    ).toBeNull();

    const emptyFallback = store.prepareCloseAllCanvasTabsFocusTarget(
      tabId,
      paneId,
    );
    if (emptyFallback === null) {
      throw new Error("expected empty fallback target");
    }
    expect(emptyFallback.paneId).not.toBe(paneId);
    expect(emptyFallback.tileInstanceId).toBeUndefined();
    expect(requireNestedFocusTarget(tabId)).toEqual(emptyFallback);
  });

  it("prepares null for resize layout updates while preserving the raw mutation", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-prepare-resize", "Prepare Resize");
    store.openTileInTab(tabId, SPEC_A);
    const paneId = requireCanvas(tabId).activePaneId;
    if (paneId === null) throw new Error("expected pane");
    store.splitPaneWithNode(tabId, paneId, "right", SPEC_B);
    const canvas = requireCanvas(tabId);
    if (canvas.root === null || canvas.root.kind !== "group") {
      throw new Error("expected split group");
    }

    expect(
      store.prepareResizeSplitFocusTarget(tabId, canvas.root.id, [0.25, 0.75]),
    ).toBeNull();
    expect(requireCanvas(tabId).sizesByGroupId[canvas.root.id]).toEqual([
      0.25, 0.75,
    ]);
    expect(requireNestedFocusTarget(tabId)).toEqual(
      getCurrentNestedFocusTarget(requireCanvas(tabId)),
    );
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
    activationHistory: [SPEC_A.instanceId],
  };
  const rightPane: TilePane = {
    kind: "pane",
    id: "group-right",
    tabInstanceIds: [SPEC_C.instanceId],
    activeTabId: SPEC_C.instanceId,
    previewTabId: null,
    activationHistory: [SPEC_C.instanceId],
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

describe("closedTilePayloadsByTabId", () => {
  it("captures a tile payload when the tile is closed via closeCanvasTab", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-closed-payload", "Closed Payload");
    store.openTileInTab(tabId, SPEC_A);
    store.openTileInTab(tabId, SPEC_B);
    const paneId = requireCanvas(tabId).activePaneId;
    if (paneId === null) throw new Error("expected pane");

    store.closeCanvasTab(tabId, paneId, SPEC_A.instanceId);

    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId]?.[
        SPEC_A.instanceId
      ]?.node,
    ).toEqual(SPEC_A);
    expect(
      useEpicCanvasStore.getState().canvasByTabId[tabId]?.tilesByInstanceId[
        SPEC_A.instanceId
      ],
    ).toBeUndefined();
  });

  it("keeps pending-create state with a cached tile until the create flow unmarks it", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-pending-payload", "Pending Payload");
    store.markArtifactPendingCreate(SPEC_A.id);
    store.openTileInTab(tabId, SPEC_A);
    store.openTileInTab(tabId, SPEC_B);
    const paneId = requireCanvas(tabId).activePaneId;
    if (paneId === null) throw new Error("expected pane");

    store.closeCanvasTab(tabId, paneId, SPEC_A.instanceId);

    const afterClose = useEpicCanvasStore.getState();
    expect(afterClose.pendingCreateArtifactIds.has(SPEC_A.id)).toBe(false);
    expect(
      afterClose.closedTilePayloadsByTabId[tabId]?.[SPEC_A.instanceId]
        ?.pendingCreate,
    ).toBe(true);

    store.unmarkArtifactPendingCreate(SPEC_A.id);

    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId]?.[
        SPEC_A.instanceId
      ]?.pendingCreate,
    ).toBe(false);
  });

  it("discardClosedTilePayload drops a single cached entry", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-discard-payload", "Discard Payload");
    store.openTileInTab(tabId, SPEC_A);
    store.openTileInTab(tabId, SPEC_B);
    const paneId = requireCanvas(tabId).activePaneId;
    if (paneId === null) throw new Error("expected pane");
    store.closeCanvasTab(tabId, paneId, SPEC_A.instanceId);
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId]?.[
        SPEC_A.instanceId
      ]?.node,
    ).toEqual(SPEC_A);

    store.discardClosedTilePayload(tabId, SPEC_A.instanceId);

    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId]?.[
        SPEC_A.instanceId
      ]?.node,
    ).toBeUndefined();
  });

  it("discardClosedTilePayload is a no-op for a tabId/instanceId that isn't cached", () => {
    const store = useEpicCanvasStore.getState();
    const before = useEpicCanvasStore.getState().closedTilePayloadsByTabId;

    store.discardClosedTilePayload("no-such-tab", "no-such-instance");

    expect(useEpicCanvasStore.getState().closedTilePayloadsByTabId).toBe(
      before,
    );
  });

  it("captures a preview tile when successive preview opens evict the prior", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-preview-evict", "Preview Evict");
    store.openTilePreviewInTab(tabId, SPEC_A);
    store.openTilePreviewInTab(tabId, SPEC_B);

    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId]?.[
        SPEC_A.instanceId
      ]?.node,
    ).toEqual(SPEC_A);
    expect(
      useEpicCanvasStore.getState().canvasByTabId[tabId]?.tilesByInstanceId[
        SPEC_A.instanceId
      ],
    ).toBeUndefined();
  });

  it("preserves closed-tile payloads across a plain Task close (closeTab)", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-task-close", "Task Close");
    store.openTileInTab(tabId, SPEC_A);
    store.openTileInTab(tabId, SPEC_B);
    const paneId = requireCanvas(tabId).activePaneId;
    if (paneId === null) throw new Error("expected pane");
    store.closeCanvasTab(tabId, paneId, SPEC_A.instanceId);

    store.closeTab(tabId);

    // Task is hidden but preserved, including its closed-tile cache.
    expect(useEpicCanvasStore.getState().openTabOrder).not.toContain(tabId);
    expect(useEpicCanvasStore.getState().tabsById[tabId]).toBeDefined();
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId]?.[
        SPEC_A.instanceId
      ]?.node,
    ).toEqual(SPEC_A);
  });

  it("GC's closed-tile payloads on permanent tab discard", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-discard", "Discard");
    store.openTileInTab(tabId, SPEC_A);
    store.openTileInTab(tabId, SPEC_B);
    const paneId = requireCanvas(tabId).activePaneId;
    if (paneId === null) throw new Error("expected pane");
    store.closeCanvasTab(tabId, paneId, SPEC_A.instanceId);
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId],
    ).toBeDefined();

    store.discardTabState(tabId);

    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId],
    ).toBeUndefined();
  });

  it("GC's closed-tile payloads on closeTabsForEpics", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-delete", "Delete Epic");
    store.openTileInTab(tabId, SPEC_A);
    store.openTileInTab(tabId, SPEC_B);
    const paneId = requireCanvas(tabId).activePaneId;
    if (paneId === null) throw new Error("expected pane");
    store.closeCanvasTab(tabId, paneId, SPEC_A.instanceId);

    store.closeTabsForEpics(["epic-delete"]);

    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId],
    ).toBeUndefined();
  });

  it("FIFO-evicts the oldest closed-tile payload past the per-tab cap of 20", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-fifo", "FIFO");
    // Seed a pinned base tile so the pane never empties.
    store.openTileInTab(tabId, {
      id: "art-base",
      instanceId: "inst-base",
      type: "spec",
      name: "Base",
      hostId: TEST_HOST_ID,
    });
    const paneId = requireCanvas(tabId).activePaneId;
    if (paneId === null) throw new Error("expected pane");

    // Open+close 21 distinct tiles; the first closed should be FIFO-evicted.
    for (let i = 0; i < 21; i += 1) {
      const ref: EpicCanvasTileRef = {
        id: `art-fifo-${i}`,
        instanceId: `inst-fifo-${i}`,
        type: "spec",
        name: `FIFO ${i}`,
        hostId: TEST_HOST_ID,
      };
      store.openTileInTab(tabId, ref);
      store.closeCanvasTab(tabId, paneId, ref.instanceId);
    }

    const cached =
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId] ?? {};
    expect(Object.keys(cached)).toHaveLength(20);
    expect(cached["inst-fifo-0"]).toBeUndefined();
    expect(cached["inst-fifo-1"]?.node).toEqual({
      id: "art-fifo-1",
      instanceId: "inst-fifo-1",
      type: "spec",
      name: "FIFO 1",
      hostId: TEST_HOST_ID,
    });
    expect(cached["inst-fifo-20"]?.node).toEqual({
      id: "art-fifo-20",
      instanceId: "inst-fifo-20",
      type: "spec",
      name: "FIFO 20",
      hostId: TEST_HOST_ID,
    });
  });

  it("restoring at a full cache does not evict an unrelated payload (removal is layered before capture)", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-fifo-restore", "FIFO Restore");
    store.openTileInTab(tabId, {
      id: "art-base",
      instanceId: "inst-base",
      type: "spec",
      name: "Base",
      hostId: TEST_HOST_ID,
    });
    const paneId = requireCanvas(tabId).activePaneId;
    if (paneId === null) throw new Error("expected pane");

    // Fill the cache to EXACTLY the cap (20), no eviction needed yet.
    for (let i = 0; i < 20; i += 1) {
      const ref: EpicCanvasTileRef = {
        id: `art-fifo-${i}`,
        instanceId: `inst-fifo-${i}`,
        type: "spec",
        name: `FIFO ${i}`,
        hostId: TEST_HOST_ID,
      };
      store.openTileInTab(tabId, ref);
      store.closeCanvasTab(tabId, paneId, ref.instanceId);
    }
    const oldest = "inst-fifo-0";
    const beingRestored = "inst-fifo-19";
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId]?.[oldest],
    ).toBeDefined();
    const restoredPayload =
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId]?.[
        beingRestored
      ];
    if (restoredPayload === undefined) {
      throw new Error("expected cached payload for " + beingRestored);
    }

    // A live preview tile occupies the destination pane; restoring R will
    // evict (and thus capture) it in the SAME transaction as R's removal.
    const previewTile: EpicCanvasTileRef = {
      id: "art-preview-occupant",
      instanceId: "inst-preview-occupant",
      type: "spec",
      name: "Preview Occupant",
      hostId: TEST_HOST_ID,
    };
    store.openTilePreviewInTab(tabId, previewTile);

    store.restoreClosedTilePreview(tabId, paneId, restoredPayload.node);

    const cached =
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId] ?? {};
    // Atomic result: R removed (now live), P added, Q (oldest) retained -
    // still exactly 20, not 19 (an over-eviction) and not 21.
    expect(Object.keys(cached)).toHaveLength(20);
    expect(cached[beingRestored]).toBeUndefined();
    expect(cached[oldest]?.node).toEqual({
      id: "art-fifo-0",
      instanceId: oldest,
      type: "spec",
      name: "FIFO 0",
      hostId: TEST_HOST_ID,
    });
    expect(cached[previewTile.instanceId]?.node).toEqual(previewTile);
  });

  it("is session-only: not written into the zustand persist partialize surface", async () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-session-only", "Session Only");
    store.openTileInTab(tabId, SPEC_A);
    store.openTileInTab(tabId, SPEC_B);
    const paneId = requireCanvas(tabId).activePaneId;
    if (paneId === null) throw new Error("expected pane");
    store.closeCanvasTab(tabId, paneId, SPEC_A.instanceId);
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId]?.[
        SPEC_A.instanceId
      ]?.node,
    ).toEqual(SPEC_A);

    // Flush any pending persist write.
    await useEpicCanvasStore.persist.rehydrate();
    const raw = window.localStorage.getItem(epicCanvasKey(null));
    expect(raw).not.toBeNull();
    if (raw === null) return;
    const parsed: unknown = JSON.parse(raw);
    expect(isRecord(parsed)).toBe(true);
    if (!isRecord(parsed)) return;
    const state = parsed.state;
    expect(isRecord(state)).toBe(true);
    if (!isRecord(state)) return;
    expect(state.closedTilePayloadsByTabId).toBeUndefined();
  });
});

describe("restoreClosedTilePreview", () => {
  it("reopens under the original instanceId into the preferred pane and evicts the cache entry", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-restore", "Restore");
    // A pinned sibling so the pane survives SPEC_A's close instead of
    // collapsing (a single-tab pane closes itself along with its last tab).
    store.openTileInTab(tabId, {
      id: "art-pinned",
      instanceId: "inst-pinned",
      type: "spec",
      name: "Pinned",
      hostId: TEST_HOST_ID,
    });
    store.openTileInTab(tabId, SPEC_A);
    const paneId = requireCanvas(tabId).activePaneId;
    if (paneId === null) throw new Error("expected pane");
    store.closeCanvasTab(tabId, paneId, SPEC_A.instanceId);
    const preserved =
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId]?.[
        SPEC_A.instanceId
      ];
    expect(preserved?.node).toEqual(SPEC_A);
    if (preserved === undefined) return;

    store.restoreClosedTilePreview(tabId, paneId, preserved.node);

    const canvas = requireCanvas(tabId);
    expect(canvas.activePaneId).toBe(paneId);
    expect(canvas.tilesByInstanceId[SPEC_A.instanceId]).toEqual(SPEC_A);
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId]?.[
        SPEC_A.instanceId
      ]?.node,
    ).toBeUndefined();
  });

  it("falls back to the active pane when the preferred pane id doesn't exist", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-restore-fallback", "Fallback");
    store.openTileInTab(tabId, SPEC_A);
    const activePaneId = requireCanvas(tabId).activePaneId;
    if (activePaneId === null) throw new Error("expected pane");

    store.restoreClosedTilePreview(tabId, "pane-never-existed", SPEC_B);

    const canvas = requireCanvas(tabId);
    expect(canvas.activePaneId).toBe(activePaneId);
    expect(canvas.tilesByInstanceId[SPEC_B.instanceId]).toEqual(SPEC_B);
  });

  it("restores the exact instance when the same content is already open elsewhere", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-restore-duplicate", "Duplicate");
    store.openTileInTab(tabId, SPEC_A);
    const paneId = requireCanvas(tabId).activePaneId;
    if (paneId === null) throw new Error("expected pane");

    // Explicit-pane opens intentionally bypass content dedup and mint another
    // instance for the same content id.
    store.openTileInPane(tabId, paneId, SPEC_A);
    const withDuplicate = requirePane(requireCanvas(tabId), paneId);
    const duplicateInstanceId = withDuplicate.tabInstanceIds.find(
      (instanceId) => instanceId !== SPEC_A.instanceId,
    );
    if (duplicateInstanceId === undefined) {
      throw new Error("expected duplicate content instance");
    }
    store.closeCanvasTab(tabId, paneId, SPEC_A.instanceId);

    const preserved =
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId]?.[
        SPEC_A.instanceId
      ];
    if (preserved === undefined) throw new Error("expected cached payload");
    store.restoreClosedTilePreview(tabId, paneId, preserved.node);

    const canvas = requireCanvas(tabId);
    const pane = requirePane(canvas, paneId);
    expect(pane.tabInstanceIds).toContain(duplicateInstanceId);
    expect(pane.tabInstanceIds).toContain(SPEC_A.instanceId);
    expect(pane.activeTabId).toBe(SPEC_A.instanceId);
    expect(pane.previewTabId).toBe(SPEC_A.instanceId);
    expect(canvas.tilesByInstanceId[duplicateInstanceId]?.id).toBe(SPEC_A.id);
    expect(canvas.tilesByInstanceId[SPEC_A.instanceId]).toEqual(SPEC_A);
  });

  it("captures the evicted preview tile into the cache while restoring another", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-restore-evict", "Restore Evict");
    // A pinned permanent tile plus SPEC_A as the current preview.
    store.openTileInTab(tabId, {
      id: "art-pinned",
      instanceId: "inst-pinned",
      type: "spec",
      name: "Pinned",
      hostId: TEST_HOST_ID,
    });
    store.openTilePreviewInTab(tabId, SPEC_A);
    const paneId = requireCanvas(tabId).activePaneId;
    if (paneId === null) throw new Error("expected pane");

    store.restoreClosedTilePreview(tabId, paneId, SPEC_B);

    // SPEC_A (the prior preview) was evicted and captured; SPEC_B is live.
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId]?.[
        SPEC_A.instanceId
      ]?.node,
    ).toEqual(SPEC_A);
    const canvas = requireCanvas(tabId);
    expect(canvas.tilesByInstanceId[SPEC_A.instanceId]).toBeUndefined();
    expect(canvas.tilesByInstanceId[SPEC_B.instanceId]).toEqual(SPEC_B);
  });
});

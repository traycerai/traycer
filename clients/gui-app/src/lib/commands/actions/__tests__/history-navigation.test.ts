import "../../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryHistory,
  type RouterHistory,
} from "@tanstack/react-router";
import { createPersistentMemoryHistory } from "@/lib/persistent-history";
import { goBack, goForward } from "@/lib/commands/actions/history-navigation";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type {
  EpicCanvasTileRef,
  EpicNodeRef,
} from "@/stores/epics/canvas/types";
import { findPaneById } from "@/stores/epics/canvas/tile-tree";
import { resolveNestedFocusTarget } from "@/lib/epic-nested-focus-route";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";

const WINDOW_ID = "history-nav-action-test-window";

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

// Registers a real (no-op-transport) open-Epic session in the module-scoped
// registry `reopenClosedTilePreview` reads via `getOpenEpicRegistry().peek`,
// with its projected tree seeded to exactly `liveNodeIds` and `snapshotLoaded`
// set explicitly (a freshly (re)acquired handle defaults to `false` - callers
// exercising the "session live, tree authoritative" path must pass `true`).
// Tracked and released in `afterEach` so sessions never leak across tests.
const liveEpicHandles: OpenEpicStoreHandle[] = [];
function seedLiveEpicSession(
  epicId: string,
  liveNodeIds: ReadonlyArray<string>,
  snapshotLoaded: boolean,
): void {
  const handle = createOpenEpicStore({
    epicId,
    streamClientFactory: noopStreamClientFactory,
    userId: null,
    onAuthError: null,
  });
  handle.store.setState((state) => ({
    snapshotLoaded,
    tree: {
      ...state.tree,
      nodeById: Object.fromEntries(
        liveNodeIds.map((id) => [
          id,
          {
            id,
            parentId: null,
            title: id,
            type: "spec",
            status: null,
            createdAt: 0,
            updatedAt: 0,
          },
        ]),
      ),
    },
  }));
  getOpenEpicRegistry().acquire(epicId, () => handle);
  liveEpicHandles.push(handle);
}

const SPEC_A: EpicNodeRef = {
  id: "art-a",
  instanceId: "inst-a",
  type: "spec",
  name: "Spec A",
  hostId: "test-host",
};
const SPEC_B: EpicNodeRef = {
  id: "art-b",
  instanceId: "inst-b",
  type: "spec",
  name: "Spec B",
  hostId: "test-host",
};

function storageKey(windowId: string): string {
  return `traycer-gui-app:last-route:${windowId}`;
}

// Seed a multi-entry persistent (branded) stack via localStorage so the history
// boots branded without firing any navigation notification.
function seedPersistentHistory(
  entries: ReadonlyArray<string>,
  index: number,
): RouterHistory {
  window.localStorage.setItem(
    storageKey(WINDOW_ID),
    JSON.stringify({ entries, index }),
  );
  return createPersistentMemoryHistory(null, WINDOW_ID);
}

function nestedHref(
  epicId: string,
  tabId: string,
  paneId: string,
  tileInstanceId: string,
): string {
  return `/epics/${epicId}/${tabId}?focusPaneId=${paneId}&focusTileInstanceId=${tileInstanceId}`;
}

function requirePaneId(tabId: string): string {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined || canvas.activePaneId === null) {
    throw new Error(`expected active pane for ${tabId}`);
  }
  return canvas.activePaneId;
}

function requirePreviewTabId(tabId: string): string {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined || canvas.activePaneId === null) {
    throw new Error(`expected canvas for ${tabId}`);
  }
  const pane = findPaneById(canvas.root, canvas.activePaneId);
  if (pane === null || pane.previewTabId === null) {
    throw new Error(`expected preview tab in ${tabId}`);
  }
  return pane.previewTabId;
}

function tileByContentId(
  tabId: string,
  contentId: string,
): EpicCanvasTileRef | undefined {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) return undefined;
  return Object.values(canvas.tilesByInstanceId).find(
    (ref) => ref !== undefined && ref.id === contentId,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  for (const handle of liveEpicHandles.splice(0)) {
    getOpenEpicRegistry().release(handle.epicId);
  }
});

describe("goBack / goForward", () => {
  it("no-op when the history carries no controller brand (browser/web)", () => {
    const history = createMemoryHistory({ initialEntries: ["/a", "/b"] });
    const goSpy = vi.spyOn(history, "go");
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");

    goBack({ history });
    goForward({ history });

    expect(goSpy).not.toHaveBeenCalled();
    expect(trackSpy).not.toHaveBeenCalled();
  });

  it("calls go(-1) on the PASSED router's history when a controller reports canGoBack", () => {
    // index 1 of 2 entries → canGoBack() is true.
    const history = seedPersistentHistory(
      ["/settings/general", "/draft/d1"],
      1,
    );
    const goSpy = vi.spyOn(history, "go");

    goBack({ history });

    expect(goSpy).toHaveBeenCalledTimes(1);
    expect(goSpy).toHaveBeenCalledWith(-1);
  });

  it("tracks successful back navigation off the navigation call stack", () => {
    vi.useFakeTimers();
    const history = seedPersistentHistory(
      ["/settings/general", "/draft/d1"],
      1,
    );
    vi.spyOn(history, "go").mockImplementation(() => {});
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");

    goBack({ history });

    expect(trackSpy).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(trackSpy).toHaveBeenCalledWith(
      AnalyticsEvent.HistoryNavigationUsed,
      { direction: "back" },
    );
  });

  it("calls go(1) on the PASSED router's history when a controller reports canGoForward", () => {
    // index 0 of 2 entries → canGoForward() is true.
    const history = seedPersistentHistory(
      ["/settings/general", "/draft/d1"],
      0,
    );
    const goSpy = vi.spyOn(history, "go");

    goForward({ history });

    expect(goSpy).toHaveBeenCalledTimes(1);
    expect(goSpy).toHaveBeenCalledWith(1);
  });

  it("tracks successful forward navigation off the navigation call stack", () => {
    vi.useFakeTimers();
    const history = seedPersistentHistory(
      ["/settings/general", "/draft/d1"],
      0,
    );
    vi.spyOn(history, "go").mockImplementation(() => {});
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");

    goForward({ history });

    expect(trackSpy).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(trackSpy).toHaveBeenCalledWith(
      AnalyticsEvent.HistoryNavigationUsed,
      { direction: "forward" },
    );
  });

  it("keeps analytics failures from affecting navigation", () => {
    vi.useFakeTimers();
    const history = seedPersistentHistory(
      ["/settings/general", "/draft/d1"],
      1,
    );
    const goSpy = vi.spyOn(history, "go").mockImplementation(() => {});
    vi.spyOn(Analytics.getInstance(), "track").mockImplementation(() => {
      throw new Error("analytics failed");
    });

    expect(() => goBack({ history })).not.toThrow();
    expect(goSpy).toHaveBeenCalledWith(-1);
    expect(() => vi.runAllTimers()).not.toThrow();
  });

  it("no-op at the start boundary: goBack does NOT call go when canGoBack is false", () => {
    // index 0 → canGoBack() is false; a boundary go(-1) would notify and re-load
    // the current route for nothing.
    const history = seedPersistentHistory(
      ["/settings/general", "/draft/d1"],
      0,
    );
    const goSpy = vi.spyOn(history, "go");

    goBack({ history });

    expect(goSpy).not.toHaveBeenCalled();
  });

  it("no-op at the end boundary: goForward does NOT call go when canGoForward is false", () => {
    // index 1 (last) → canGoForward() is false.
    const history = seedPersistentHistory(
      ["/settings/general", "/draft/d1"],
      1,
    );
    const goSpy = vi.spyOn(history, "go");

    goForward({ history });

    expect(goSpy).not.toHaveBeenCalled();
  });
});

describe("goBack / goForward — skip closed Tasks", () => {
  it("skips one closed-task entry when going back", () => {
    const store = useEpicCanvasStore.getState();
    const openId = store.openEpicTab("e1", "Open");
    const closedId = store.openEpicTab("e1", "Closed");
    store.closeTab(closedId);
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([openId]);

    const history = seedPersistentHistory(
      [`/epics/e1/${openId}`, `/epics/e1/${closedId}`, `/epics/e1/${openId}`],
      2,
    );
    const goSpy = vi.spyOn(history, "go").mockImplementation(() => {});

    goBack({ history });

    expect(goSpy).toHaveBeenCalledTimes(1);
    expect(goSpy).toHaveBeenCalledWith(-2);
  });

  it("skips multiple closed-task entries when going back", () => {
    const store = useEpicCanvasStore.getState();
    const openId = store.openEpicTab("e1", "Open");
    const closedA = store.openEpicTab("e1", "Closed A");
    const closedB = store.openEpicTab("e1", "Closed B");
    store.closeTab(closedA);
    store.closeTab(closedB);

    const history = seedPersistentHistory(
      [
        `/epics/e1/${openId}`,
        `/epics/e1/${closedA}`,
        `/epics/e1/${closedB}`,
        `/epics/e1/${openId}`,
      ],
      3,
    );
    const goSpy = vi.spyOn(history, "go").mockImplementation(() => {});

    goBack({ history });

    expect(goSpy).toHaveBeenCalledWith(-3);
  });

  it("skips one closed-task entry when going forward", () => {
    const store = useEpicCanvasStore.getState();
    const openId = store.openEpicTab("e1", "Open");
    const closedId = store.openEpicTab("e1", "Closed");
    store.closeTab(closedId);

    const history = seedPersistentHistory(
      [`/epics/e1/${openId}`, `/epics/e1/${closedId}`, `/epics/e1/${openId}`],
      0,
    );
    const goSpy = vi.spyOn(history, "go").mockImplementation(() => {});

    goForward({ history });

    expect(goSpy).toHaveBeenCalledWith(2);
  });

  it("skips multiple closed-task entries when going forward", () => {
    const store = useEpicCanvasStore.getState();
    const openId = store.openEpicTab("e1", "Open");
    const closedA = store.openEpicTab("e1", "Closed A");
    const closedB = store.openEpicTab("e1", "Closed B");
    store.closeTab(closedA);
    store.closeTab(closedB);

    const history = seedPersistentHistory(
      [
        `/epics/e1/${openId}`,
        `/epics/e1/${closedA}`,
        `/epics/e1/${closedB}`,
        `/epics/e1/${openId}`,
      ],
      0,
    );
    const goSpy = vi.spyOn(history, "go").mockImplementation(() => {});

    goForward({ history });

    expect(goSpy).toHaveBeenCalledWith(3);
  });

  it("no-ops when only closed-task entries remain behind", () => {
    const store = useEpicCanvasStore.getState();
    const openId = store.openEpicTab("e1", "Open");
    const closedId = store.openEpicTab("e1", "Closed");
    store.closeTab(closedId);

    const history = seedPersistentHistory(
      [`/epics/e1/${closedId}`, `/epics/e1/${openId}`],
      1,
    );
    const goSpy = vi.spyOn(history, "go").mockImplementation(() => {});

    goBack({ history });

    expect(goSpy).not.toHaveBeenCalled();
  });

  it("reaches a previously skipped entry after the closed Task is reopened", () => {
    const store = useEpicCanvasStore.getState();
    const openId = store.openEpicTab("e1", "Open");
    const closedId = store.openEpicTab("e1", "Closed");
    store.closeTab(closedId);

    const history = seedPersistentHistory(
      [`/epics/e1/${closedId}`, `/epics/e1/${openId}`],
      1,
    );
    const goSpy = vi.spyOn(history, "go").mockImplementation(() => {});

    goBack({ history });
    expect(goSpy).not.toHaveBeenCalled();

    // Reopen the closed Task (setActiveTab reinserts into openTabOrder).
    useEpicCanvasStore.getState().setActiveTab(closedId);
    goBack({ history });

    expect(goSpy).toHaveBeenCalledTimes(1);
    expect(goSpy).toHaveBeenCalledWith(-1);
  });

  it("still lands on non-task routes without consulting openTabOrder", () => {
    const store = useEpicCanvasStore.getState();
    const openId = store.openEpicTab("e1", "Open");
    const closedId = store.openEpicTab("e1", "Closed");
    store.closeTab(closedId);

    const history = seedPersistentHistory(
      ["/draft/d1", `/epics/e1/${closedId}`, `/epics/e1/${openId}`],
      2,
    );
    const goSpy = vi.spyOn(history, "go").mockImplementation(() => {});

    goBack({ history });

    // Skips closed, lands on draft at offset -2.
    expect(goSpy).toHaveBeenCalledWith(-2);
  });
});

describe("goBack / goForward — preview-reopen closed sub-tabs", () => {
  it("reopens a closed tile as a preview, reusing its original instanceId in its original pane", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("e1", "Task");
    store.openTileInTab(tabId, SPEC_A);
    store.openTileInTab(tabId, SPEC_B);
    const paneId = requirePaneId(tabId);

    // Close SPEC_A; payload is preserved in closedTilePayloadsByTabId.
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

    const landing = nestedHref("e1", tabId, paneId, SPEC_A.instanceId);
    const history = seedPersistentHistory([landing, `/epics/e1/${tabId}`], 1);
    const goSpy = vi.spyOn(history, "go").mockImplementation(() => {});

    goBack({ history });

    expect(goSpy).toHaveBeenCalledWith(-1);
    // Reopened under its ORIGINAL instanceId, into its ORIGINAL pane - the
    // landing href's exact (paneId, tileInstanceId) resolves directly, no
    // fresh id and no stale-target URL rewrite needed.
    const previewInstanceId = requirePreviewTabId(tabId);
    expect(previewInstanceId).toBe(SPEC_A.instanceId);
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    expect(canvas?.activePaneId).toBe(paneId);
    const resolved =
      canvas !== undefined
        ? resolveNestedFocusTarget(canvas, {
            paneId,
            tileInstanceId: SPEC_A.instanceId,
          })
        : null;
    expect(resolved).not.toBeNull();
    const reopened = tileByContentId(tabId, SPEC_A.id);
    expect(reopened).toBeDefined();
    expect(reopened?.instanceId).toBe(SPEC_A.instanceId);
    expect(reopened?.name).toBe(SPEC_A.name);
    // The cache entry is evicted now that the tile is live again.
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId]?.[
        SPEC_A.instanceId
      ],
    ).toBeUndefined();
  });

  it("reopens into the closed tile's ORIGINAL pane, not the currently active pane", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("e1", "Task");
    // A permanent sibling so the original pane survives SPEC_A's close.
    store.openTileInTab(tabId, {
      id: "art-pinned",
      instanceId: "inst-pinned",
      type: "spec",
      name: "Pinned",
      hostId: "test-host",
    });
    store.openTileInTab(tabId, SPEC_A);
    const originalPaneId = requirePaneId(tabId);

    const newPaneId = store.splitPaneEmptyInTab(
      tabId,
      originalPaneId,
      "horizontal",
    );
    if (newPaneId === null) {
      throw new Error("expected split to create a second pane");
    }
    // The split makes the new pane active; a preview opened now lands there.
    store.openTilePreviewInTab(tabId, SPEC_B);
    expect(
      useEpicCanvasStore.getState().canvasByTabId[tabId]?.activePaneId,
    ).toBe(newPaneId);

    store.closeCanvasTab(tabId, originalPaneId, SPEC_A.instanceId);

    const landing = nestedHref("e1", tabId, originalPaneId, SPEC_A.instanceId);
    const history = seedPersistentHistory([landing, `/epics/e1/${tabId}`], 1);
    vi.spyOn(history, "go").mockImplementation(() => {});

    goBack({ history });

    // Landed back in the ORIGINAL pane, not the active one.
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    expect(canvas?.activePaneId).toBe(originalPaneId);
    const originalPane =
      canvas !== undefined ? findPaneById(canvas.root, originalPaneId) : null;
    expect(originalPane?.tabInstanceIds).toContain(SPEC_A.instanceId);
    // The unrelated pane's own preview (SPEC_B) is untouched - the reopen
    // must not evict a sibling pane's preview slot.
    const newPane =
      canvas !== undefined ? findPaneById(canvas.root, newPaneId) : null;
    expect(newPane?.previewTabId).toBe(SPEC_B.instanceId);
    expect(tileByContentId(tabId, SPEC_B.id)).toBeDefined();
  });

  it("falls back to the active pane when the closed tile's original pane no longer exists", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("e1", "Task");
    store.openTileInTab(tabId, SPEC_A);
    const goneOriginalPaneId = "pane-long-gone";

    // No pane by this id has ever existed in this tab's canvas, but a
    // preserved payload is present (e.g. seeded directly, or the pane
    // collapsed away after the tile closed).
    useEpicCanvasStore.setState((state) => ({
      closedTilePayloadsByTabId: {
        ...state.closedTilePayloadsByTabId,
        [tabId]: {
          [SPEC_B.instanceId]: { node: SPEC_B, pendingCreate: false },
        },
      },
    }));

    const landing = nestedHref(
      "e1",
      tabId,
      goneOriginalPaneId,
      SPEC_B.instanceId,
    );
    const history = seedPersistentHistory([landing, `/epics/e1/${tabId}`], 1);
    vi.spyOn(history, "go").mockImplementation(() => {});

    goBack({ history });

    // Falls back to the active pane (the only pane in this canvas) rather
    // than no-op'ing because the historical pane id doesn't exist. Still
    // reuses SPEC_B's original instanceId.
    const activePaneId = requirePaneId(tabId);
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    expect(canvas?.activePaneId).toBe(activePaneId);
    const previewInstanceId = requirePreviewTabId(tabId);
    expect(previewInstanceId).toBe(SPEC_B.instanceId);
    expect(tileByContentId(tabId, SPEC_B.id)?.instanceId).toBe(
      SPEC_B.instanceId,
    );
  });

  it("swaps the single preview slot across successive closed-tile navigations", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("e1", "Task");
    // Pin a permanent tile so preview eviction doesn't empty the pane.
    store.openTileInTab(tabId, {
      id: "art-pinned",
      instanceId: "inst-pinned",
      type: "spec",
      name: "Pinned",
      hostId: "test-host",
    });
    store.openTilePreviewInTab(tabId, SPEC_A);
    store.openTilePreviewInTab(tabId, SPEC_B);
    const paneId = requirePaneId(tabId);

    // After the second preview open, SPEC_A was evicted and captured.
    // Close SPEC_B too so both are in the closed-tile cache.
    store.closeCanvasTab(tabId, paneId, SPEC_B.instanceId);
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId]?.[
        SPEC_A.instanceId
      ]?.node,
    ).toEqual(SPEC_A);
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId]?.[
        SPEC_B.instanceId
      ]?.node,
    ).toEqual(SPEC_B);

    const hrefA = nestedHref("e1", tabId, paneId, SPEC_A.instanceId);
    const hrefB = nestedHref("e1", tabId, paneId, SPEC_B.instanceId);
    // Stack: A, B, current. Go back to B, then back to A.
    const history = seedPersistentHistory(
      [hrefA, hrefB, `/epics/e1/${tabId}`],
      2,
    );
    vi.spyOn(history, "go").mockImplementation(() => {});

    goBack({ history });
    const firstPreview = requirePreviewTabId(tabId);
    // Reuses SPEC_B's original instanceId, so hrefB resolves directly.
    expect(firstPreview).toBe(SPEC_B.instanceId);
    expect(tileByContentId(tabId, SPEC_B.id)?.instanceId).toBe(firstPreview);
    const canvasAfterFirst = useEpicCanvasStore.getState().canvasByTabId[tabId];
    expect(
      canvasAfterFirst !== undefined &&
        resolveNestedFocusTarget(canvasAfterFirst, {
          paneId,
          tileInstanceId: SPEC_B.instanceId,
        }) !== null,
    ).toBe(true);

    // Simulate the stack cursor landing on B so the next back targets A.
    // (go is mocked, so reseed at the landing entry.)
    window.localStorage.setItem(
      storageKey(WINDOW_ID),
      JSON.stringify({
        entries: [hrefA, hrefB, `/epics/e1/${tabId}`],
        index: 1,
      }),
    );
    const historyAtB = createPersistentMemoryHistory(null, WINDOW_ID);
    vi.spyOn(historyAtB, "go").mockImplementation(() => {});

    goBack({ history: historyAtB });
    const secondPreview = requirePreviewTabId(tabId);
    // Reuses SPEC_A's original instanceId - swapping the preview slot did
    // not force a fresh id either.
    expect(secondPreview).toBe(SPEC_A.instanceId);
    expect(secondPreview).not.toBe(firstPreview);
    expect(tileByContentId(tabId, SPEC_A.id)?.instanceId).toBe(secondPreview);
    // SPEC_B preview was swapped out of the single preview slot.
    expect(tileByContentId(tabId, SPEC_B.id)).toBeUndefined();
  });

  it("skips a closed Task then preview-reopens a closed tile on the landing entry", () => {
    const store = useEpicCanvasStore.getState();
    const openId = store.openEpicTab("e1", "Open");
    const closedId = store.openEpicTab("e1", "Closed");
    store.openTileInTab(openId, SPEC_A);
    store.openTileInTab(openId, SPEC_B);
    const paneId = requirePaneId(openId);
    store.closeCanvasTab(openId, paneId, SPEC_A.instanceId);
    store.closeTab(closedId);

    const landing = nestedHref("e1", openId, paneId, SPEC_A.instanceId);
    const history = seedPersistentHistory(
      [landing, `/epics/e1/${closedId}`, `/epics/e1/${openId}`],
      2,
    );
    const goSpy = vi.spyOn(history, "go").mockImplementation(() => {});

    goBack({ history });

    // Skip closed Task at offset -1; land on openId nested entry at -2.
    expect(goSpy).toHaveBeenCalledWith(-2);
    const previewInstanceId = requirePreviewTabId(openId);
    expect(previewInstanceId).toBe(SPEC_A.instanceId);
    expect(tileByContentId(openId, SPEC_A.id)?.instanceId).toBe(
      previewInstanceId,
    );
    const canvas = useEpicCanvasStore.getState().canvasByTabId[openId];
    const resolved =
      canvas !== undefined
        ? resolveNestedFocusTarget(canvas, {
            paneId,
            tileInstanceId: SPEC_A.instanceId,
          })
        : null;
    expect(resolved).not.toBeNull();
  });

  it("does not reopen when the nested tile already resolves", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("e1", "Task");
    store.openTileInTab(tabId, SPEC_A);
    const paneId = requirePaneId(tabId);
    const openSpy = vi.spyOn(
      useEpicCanvasStore.getState(),
      "openTilePreviewInTab",
    );

    const landing = nestedHref("e1", tabId, paneId, SPEC_A.instanceId);
    const history = seedPersistentHistory([landing, `/epics/e1/${tabId}`], 1);
    vi.spyOn(history, "go").mockImplementation(() => {});

    goBack({ history });

    expect(openSpy).not.toHaveBeenCalled();
  });

  it("navigates without reopening when the closed-tile cache misses", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("e1", "Task");
    store.openTileInTab(tabId, SPEC_A);
    const paneId = requirePaneId(tabId);

    // Nested target points at a tile that was never opened / never captured.
    const landing = nestedHref("e1", tabId, paneId, "never-existed");
    const history = seedPersistentHistory([landing, `/epics/e1/${tabId}`], 1);
    const goSpy = vi.spyOn(history, "go").mockImplementation(() => {});

    goBack({ history });

    expect(goSpy).toHaveBeenCalledWith(-1);
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    const pane =
      canvas !== undefined && canvas.activePaneId !== null
        ? findPaneById(canvas.root, canvas.activePaneId)
        : null;
    expect(pane?.previewTabId).toBeNull();
  });

  it("drops the cache entry and does not restore when the record was deleted while the tile was closed", () => {
    // The "close A, THEN delete A while it's closed" escape path: no open
    // tile exists for the record-sync effect to close, so only restore-time
    // validation can catch it.
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("e1", "Task");
    store.openTileInTab(tabId, SPEC_A);
    const paneId = requirePaneId(tabId);
    store.closeCanvasTab(tabId, paneId, SPEC_A.instanceId);
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId]?.[
        SPEC_A.instanceId
      ]?.node,
    ).toEqual(SPEC_A);

    // A live, FULLY LOADED session for "e1" exists, and its projected tree
    // does NOT contain SPEC_A's content id - the record is gone.
    seedLiveEpicSession("e1", [], true);

    const landing = nestedHref("e1", tabId, paneId, SPEC_A.instanceId);
    const history = seedPersistentHistory([landing, `/epics/e1/${tabId}`], 1);
    const goSpy = vi.spyOn(history, "go").mockImplementation(() => {});

    goBack({ history });

    // Navigation still proceeds...
    expect(goSpy).toHaveBeenCalledWith(-1);
    // ...but nothing was restored...
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    const pane =
      canvas !== undefined && canvas.activePaneId !== null
        ? findPaneById(canvas.root, canvas.activePaneId)
        : null;
    expect(pane?.previewTabId).toBeNull();
    // ...and the stale cache entry was dropped rather than left to trip the
    // same check again on a future navigation.
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId]?.[
        SPEC_A.instanceId
      ],
    ).toBeUndefined();
  });

  it("restores when a live session confirms the record still exists", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("e1", "Task");
    store.openTileInTab(tabId, SPEC_A);
    const paneId = requirePaneId(tabId);
    store.closeCanvasTab(tabId, paneId, SPEC_A.instanceId);

    seedLiveEpicSession("e1", [SPEC_A.id], true);

    const landing = nestedHref("e1", tabId, paneId, SPEC_A.instanceId);
    const history = seedPersistentHistory([landing, `/epics/e1/${tabId}`], 1);
    vi.spyOn(history, "go").mockImplementation(() => {});

    goBack({ history });

    expect(requirePreviewTabId(tabId)).toBe(SPEC_A.instanceId);
  });

  it("restores a closed pending-create tile before its record projects", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("e1", "Task");
    store.markArtifactPendingCreate(SPEC_A.id);
    store.openTileInTab(tabId, SPEC_A);
    const paneId = requirePaneId(tabId);
    store.closeCanvasTab(tabId, paneId, SPEC_A.instanceId);

    // closeCanvasTab intentionally clears the live pending set, but capture
    // retains the marker with the cached payload until the create flow
    // explicitly unmarks it.
    expect(
      useEpicCanvasStore.getState().pendingCreateArtifactIds.has(SPEC_A.id),
    ).toBe(false);
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId]?.[
        SPEC_A.instanceId
      ]?.pendingCreate,
    ).toBe(true);
    seedLiveEpicSession("e1", [], true);

    const landing = nestedHref("e1", tabId, paneId, SPEC_A.instanceId);
    const history = seedPersistentHistory([landing, `/epics/e1/${tabId}`], 1);
    vi.spyOn(history, "go").mockImplementation(() => {});

    goBack({ history });

    expect(requirePreviewTabId(tabId)).toBe(SPEC_A.instanceId);
    // The restored tile must regain its pending marker so record-to-canvas
    // synchronization does not immediately close it before projection.
    expect(
      useEpicCanvasStore.getState().pendingCreateArtifactIds.has(SPEC_A.id),
    ).toBe(true);
  });

  it("restores when the live session hasn't loaded its snapshot yet (can't prove the record is gone)", () => {
    // A freshly (re)acquired handle starts with `snapshotLoaded: false` and
    // an empty projected tree - that must NOT read as "record confirmed
    // gone." Seed the session with a tree that (if trusted) would look like
    // the record is missing, to prove the guard - not an empty tree by
    // coincidence - is what keeps the restore going through.
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("e1", "Task");
    store.openTileInTab(tabId, SPEC_A);
    const paneId = requirePaneId(tabId);
    store.closeCanvasTab(tabId, paneId, SPEC_A.instanceId);

    seedLiveEpicSession("e1", [], false);

    const landing = nestedHref("e1", tabId, paneId, SPEC_A.instanceId);
    const history = seedPersistentHistory([landing, `/epics/e1/${tabId}`], 1);
    vi.spyOn(history, "go").mockImplementation(() => {});

    goBack({ history });

    // Restored (not discarded as dead): the tile is live in the canvas
    // under its original instanceId.
    expect(requirePreviewTabId(tabId)).toBe(SPEC_A.instanceId);
  });

  it("drops the cache entry and does not restore a locally self-deleted record, even when the epic session is evicted", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("e1", "Task");
    store.openTileInTab(tabId, SPEC_A);
    const paneId = requirePaneId(tabId);
    store.closeCanvasTab(tabId, paneId, SPEC_A.instanceId);
    // Simulate a successful local delete's optimistic tombstone (see
    // `markArtifactSelfDeleted` in epic-sidebar.tsx). No live session is
    // seeded - registry.peek("e1") returns null, simulating the epic's
    // session having been evicted past the MRU cap.
    useEpicCanvasStore.setState((state) => ({
      selfDeletedArtifactIds: new Set([
        ...state.selfDeletedArtifactIds,
        SPEC_A.id,
      ]),
    }));

    const landing = nestedHref("e1", tabId, paneId, SPEC_A.instanceId);
    const history = seedPersistentHistory([landing, `/epics/e1/${tabId}`], 1);
    const goSpy = vi.spyOn(history, "go").mockImplementation(() => {});

    goBack({ history });

    expect(goSpy).toHaveBeenCalledWith(-1);
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    const pane =
      canvas !== undefined && canvas.activePaneId !== null
        ? findPaneById(canvas.root, canvas.activePaneId)
        : null;
    expect(pane?.previewTabId).toBeNull();
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId]?.[
        SPEC_A.instanceId
      ],
    ).toBeUndefined();
  });

  it("restores when no live session exists to check against (can't prove the record is gone)", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("e1", "Task");
    store.openTileInTab(tabId, SPEC_A);
    const paneId = requirePaneId(tabId);
    store.closeCanvasTab(tabId, paneId, SPEC_A.instanceId);
    // No seedLiveEpicSession call - registry.peek("e1") returns null.

    const landing = nestedHref("e1", tabId, paneId, SPEC_A.instanceId);
    const history = seedPersistentHistory([landing, `/epics/e1/${tabId}`], 1);
    vi.spyOn(history, "go").mockImplementation(() => {});

    goBack({ history });

    expect(requirePreviewTabId(tabId)).toBe(SPEC_A.instanceId);
  });
});

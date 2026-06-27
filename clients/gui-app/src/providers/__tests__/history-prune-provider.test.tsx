import "../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createRouter, type RouterHistory } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { routeTree } from "@/routeTree.gen";
import type { AppRouter } from "@/router";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  createPersistentMemoryHistory,
  getHistoryController,
  type PersistentHistoryController,
} from "@/lib/persistent-history";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { HistoryPruneProvider } from "@/providers/history-prune-provider";

const WINDOW_ID = "history-prune-test-window";

function storageKey(windowId: string): string {
  return `traycer-gui-app:last-route:${windowId}`;
}

function makeRouter(history: RouterHistory): AppRouter {
  return createRouter({
    routeTree,
    history,
    context: {
      queryClient: new QueryClient(),
      getAuthSnapshot: () => useAuthStore.getState(),
      getActiveHostId: () => null,
      getHostClient: () => null,
    },
  });
}

// Seed a multi-entry persistent stack via localStorage so the branded history
// boots with the desired entries/index without firing any navigation.
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

function controllerFor(history: RouterHistory): PersistentHistoryController {
  const controller = getHistoryController(history);
  if (controller === null) throw new Error("expected a branded history");
  return controller;
}

// Seed live canvas tabs so `isHistoryEntryDead` treats their `/epics/$epicId/
// $tabId` entries as live. Liveness reads `tabsById` only.
function seedCanvasTabs(
  tabs: ReadonlyArray<{ tabId: string; epicId: string }>,
): void {
  useEpicCanvasStore.setState({
    tabsById: Object.fromEntries(
      tabs.map((tab) => [
        tab.tabId,
        { tabId: tab.tabId, epicId: tab.epicId, name: tab.epicId },
      ]),
    ),
  });
}

// Advance past a couple of animation frames so the scheduled (or rescheduled)
// rAF flush runs under fake timers.
function flushFrames(): void {
  act(() => {
    vi.advanceTimersByTime(64);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  useEpicCanvasStore.setState({
    tabsById: {},
    canvasByTabId: {},
    openTabOrder: [],
    activeTabId: null,
    mostRecentTabIdByEpicId: {},
  });
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("HistoryPruneProvider", () => {
  it("prunes a forward dead entry on a store mutation without calling router.load (Blocker 1); valid routes survive", () => {
    seedCanvasTabs([
      { tabId: "t1", epicId: "e1" },
      { tabId: "t2", epicId: "e2" },
    ]);
    const history = seedPersistentHistory(
      ["/epics/e1/t1", "/draft/new", "/epics/e2/t2"],
      0,
    );
    const controller = controllerFor(history);
    const router = makeRouter(history);
    const loadSpy = vi.spyOn(router, "load");

    render(<HistoryPruneProvider router={router} />);

    // Epic e2 deleted -> its tab record is gone -> `/epics/e2/t2` is now dead.
    act(() => {
      useEpicCanvasStore.getState().closeTabsForEpics(["e2"]);
    });
    flushFrames();

    // The dead forward entry is pruned; the live entry and the always-valid
    // `/draft/new` route are kept.
    expect(controller.getEntries()).toEqual(["/epics/e1/t1", "/draft/new"]);
    expect(controller.canGoForward()).toBe(true); // still one forward entry
    // Blocker 1: a prune is load-free.
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it("never prunes the current entry, even when its source dies (close current tab)", () => {
    seedCanvasTabs([{ tabId: "t1", epicId: "e1" }]);
    const history = seedPersistentHistory(["/epics/e1/t1"], 0);
    const controller = controllerFor(history);
    const router = makeRouter(history);
    const loadSpy = vi.spyOn(router, "load");

    render(<HistoryPruneProvider router={router} />);

    // The current entry's backing epic/tab is removed.
    act(() => {
      useEpicCanvasStore.getState().closeTabsForEpics(["e1"]);
    });
    flushFrames();

    // Current is never pruned; self-heal of a dead current entry is left to the
    // route mechanisms, not this layer.
    expect(controller.getEntries()).toEqual(["/epics/e1/t1"]);
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it("prunes a deleted active draft's forward entry without a load (delete active draft)", () => {
    const draftStore = useLandingDraftStore.getState();
    const currentDraftId = draftStore.createDraft(null);
    const forwardDraftId = draftStore.createDraft(null);

    const history = seedPersistentHistory(
      [`/draft/${currentDraftId}`, `/draft/${forwardDraftId}`],
      0,
    );
    const controller = controllerFor(history);
    const router = makeRouter(history);
    const loadSpy = vi.spyOn(router, "load");

    render(<HistoryPruneProvider router={router} />);

    act(() => {
      useLandingDraftStore.getState().closeDraft(forwardDraftId);
    });
    flushFrames();

    expect(controller.getEntries()).toEqual([`/draft/${currentDraftId}`]);
    expect(controller.canGoForward()).toBe(false);
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it("defers the prune while the router reports an in-flight navigation, then prunes once it settles (High 3)", () => {
    seedCanvasTabs([
      { tabId: "t1", epicId: "e1" },
      { tabId: "t2", epicId: "e2" },
    ]);
    const history = seedPersistentHistory(["/epics/e1/t1", "/epics/e2/t2"], 0);
    const controller = controllerFor(history);
    const router = makeRouter(history);
    const loadSpy = vi.spyOn(router, "load");

    // Simulate the explicit replacement navigation being in flight: the live
    // router state reports loading/pending. `isRouterLoadInFlight` must see it
    // and keep the prune from interleaving.
    let inFlight = true;
    const idleState = router.state;
    Object.defineProperty(router, "state", {
      configurable: true,
      get: () =>
        inFlight
          ? {
              ...idleState,
              status: "pending",
              isLoading: true,
              isTransitioning: true,
            }
          : idleState,
    });

    render(<HistoryPruneProvider router={router} />);

    act(() => {
      useEpicCanvasStore.getState().closeTabsForEpics(["e2"]);
    });
    flushFrames();

    // Deferred while the navigation is in flight — the dead entry is still here.
    expect(controller.getEntries()).toEqual(["/epics/e1/t1", "/epics/e2/t2"]);
    expect(loadSpy).not.toHaveBeenCalled();

    // Navigation settles; the scheduler's retry now prunes.
    inFlight = false;
    flushFrames();

    expect(controller.getEntries()).toEqual(["/epics/e1/t1"]);
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it("coalesces a burst of mutations into a single prune", () => {
    seedCanvasTabs([
      { tabId: "t1", epicId: "e1" },
      { tabId: "t2", epicId: "e2" },
    ]);
    const history = seedPersistentHistory(["/epics/e1/t1", "/epics/e2/t2"], 0);
    const controller = controllerFor(history);
    const pruneSpy = vi.spyOn(controller, "prune");
    const router = makeRouter(history);

    render(<HistoryPruneProvider router={router} />);

    act(() => {
      const store = useEpicCanvasStore.getState();
      store.closeTabsForEpics(["e2"]);
      store.openEpicTab("e3", "E3");
      store.closeTabsForEpics(["e3"]);
    });
    flushFrames();

    expect(pruneSpy).toHaveBeenCalledTimes(1);
  });

  it("uninstalls the scheduler on unmount (no prune after teardown)", () => {
    seedCanvasTabs([
      { tabId: "t1", epicId: "e1" },
      { tabId: "t2", epicId: "e2" },
    ]);
    const history = seedPersistentHistory(["/epics/e1/t1", "/epics/e2/t2"], 0);
    const controller = controllerFor(history);
    const pruneSpy = vi.spyOn(controller, "prune");
    const router = makeRouter(history);

    const view = render(<HistoryPruneProvider router={router} />);
    view.unmount();

    act(() => {
      useEpicCanvasStore.getState().closeTabsForEpics(["e2"]);
    });
    flushFrames();

    expect(pruneSpy).not.toHaveBeenCalled();
  });
});

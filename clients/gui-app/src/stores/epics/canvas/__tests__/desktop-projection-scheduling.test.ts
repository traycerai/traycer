import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopPerWindowProjectionBridge } from "@/lib/windows/per-window-projection-debounce";
import { createDebouncedDesktopPerWindowProjectionBridge } from "@/lib/windows/per-window-projection-debounce";
import type {
  DesktopPerWindowSnapshot,
  DesktopPerWindowStatePatch,
} from "@/lib/windows/types";
import {
  applyEpicCanvasDesktopProjection,
  setEpicCanvasDesktopProjectionBridge,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";

const projectTabsForDesktopSpy = vi.fn();
const projectCanvasByTabIdForDesktopSpy = vi.fn();

// Wrap the real builders so the subscriber under test still gets real output
// (an integrated test, per this app's testing convention), while letting us
// count how many times the expensive rebuild actually ran.
vi.mock(
  "@/stores/epics/canvas/canvas-desktop-projection",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/stores/epics/canvas/canvas-desktop-projection")
      >();
    return {
      ...actual,
      projectTabsForDesktop: (
        ...args: Parameters<typeof actual.projectTabsForDesktop>
      ) => {
        projectTabsForDesktopSpy(...args);
        return actual.projectTabsForDesktop(...args);
      },
      projectCanvasByTabIdForDesktop: (
        ...args: Parameters<typeof actual.projectCanvasByTabIdForDesktop>
      ) => {
        projectCanvasByTabIdForDesktopSpy(...args);
        return actual.projectCanvasByTabIdForDesktop(...args);
      },
    };
  },
);

// Never let the bridge's own timer fire during a test; every flush here is
// driven explicitly so the assertions aren't racing a real 100ms timer.
const NEVER_FIRES_MS = 60_000;

function createSpyBridge(): {
  readonly bridge: DesktopPerWindowProjectionBridge;
  readonly attempts: DesktopPerWindowStatePatch[];
} {
  const attempts: DesktopPerWindowStatePatch[] = [];
  const bridge = createDebouncedDesktopPerWindowProjectionBridge(
    {
      update: (patch) => {
        attempts.push(patch);
        return Promise.resolve();
      },
    },
    NEVER_FIRES_MS,
  );
  return { bridge, attempts };
}

beforeEach(() => {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  projectTabsForDesktopSpy.mockClear();
  projectCanvasByTabIdForDesktopSpy.mockClear();
});

afterEach(() => {
  setEpicCanvasDesktopProjectionBridge(null);
  vi.restoreAllMocks();
});

describe("desktop projection scheduling (hot path)", () => {
  it("never schedules a projection for canvas-unrelated store notifications", async () => {
    const { bridge, attempts } = createSpyBridge();
    setEpicCanvasDesktopProjectionBridge(bridge);
    const store = useEpicCanvasStore.getState();

    store.markArtifactSelfDeleted("artifact-a");
    store.markArtifactSelfDeleted("artifact-b");
    store.markArtifactSelfDeleted("artifact-c");

    await bridge.flush();

    expect(projectTabsForDesktopSpy).not.toHaveBeenCalled();
    expect(projectCanvasByTabIdForDesktopSpy).not.toHaveBeenCalled();
    expect(attempts).toEqual([]);

    bridge.dispose();
  });

  it("coalesces a burst of tab/canvas mutations into exactly one build at flush, not one per notification", async () => {
    const { bridge, attempts } = createSpyBridge();
    setEpicCanvasDesktopProjectionBridge(bridge);
    const store = useEpicCanvasStore.getState();

    // Two separate store notifications (each `openEpicTab` is its own
    // `set()` call) before any flush runs.
    const tabA = store.openEpicTab("epic-a", "Epic A");
    const tabB = store.openEpicTab("epic-b", "Epic B");

    // A `schedule()` burst must not build anything until flush.
    expect(projectTabsForDesktopSpy).not.toHaveBeenCalled();
    expect(projectCanvasByTabIdForDesktopSpy).not.toHaveBeenCalled();
    expect(attempts).toEqual([]);

    await bridge.flush();

    expect(projectTabsForDesktopSpy).toHaveBeenCalledTimes(1);
    expect(projectCanvasByTabIdForDesktopSpy).toHaveBeenCalledTimes(1);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].epicTabs?.map((t) => t.id)).toEqual([tabA, tabB]);
    expect(attempts[0].activeTabId).toBe(tabB);

    bridge.dispose();
  });

  it("reuses the cached tabs/canvas projection on an active-tab-only flush, but still ships the full patch", async () => {
    const { bridge, attempts } = createSpyBridge();
    setEpicCanvasDesktopProjectionBridge(bridge);
    const store = useEpicCanvasStore.getState();

    const tabA = store.openEpicTab("epic-a", "Epic A");
    const tabB = store.openEpicTab("epic-b", "Epic B");
    await bridge.flush();
    const baseline = attempts[attempts.length - 1];
    projectTabsForDesktopSpy.mockClear();
    projectCanvasByTabIdForDesktopSpy.mockClear();

    // Header-active-only burst: neither tabsById, openTabOrder nor
    // canvasByTabId change - only which tab is focused.
    store.setActiveTab(tabA);
    store.setActiveTab(tabB);
    store.setActiveTab(tabA);

    await bridge.flush();

    expect(projectTabsForDesktopSpy).not.toHaveBeenCalled();
    expect(projectCanvasByTabIdForDesktopSpy).not.toHaveBeenCalled();

    const latest = attempts[attempts.length - 1];
    // The patch still carries the full shape so a target that missed an
    // earlier IPC write gets repaired by this one - values are the same
    // (reused) reference the baseline flush already sent.
    expect(latest.epicTabs).toBe(baseline.epicTabs);
    expect(latest.canvasByTabId).toBe(baseline.canvasByTabId);
    expect(latest.activeTabId).toBe(tabA);

    bridge.dispose();
  });

  it("flushes the local state captured at schedule time, not a live read clobbered by a delayed echo of an earlier snapshot", async () => {
    const { bridge, attempts } = createSpyBridge();
    setEpicCanvasDesktopProjectionBridge(bridge);
    const store = useEpicCanvasStore.getState();

    // Flush A: a first tab goes out and is (conceptually) now in flight to
    // the desktop, which will eventually echo it back.
    const tabA = store.openEpicTab("epic-a", "Epic A");
    await bridge.flush();
    const snapshotA: DesktopPerWindowSnapshot = {
      epicTabs: attempts[0].epicTabs ?? [],
      activeTabId: attempts[0].activeTabId ?? null,
      canvasByTabId: attempts[0].canvasByTabId ?? {},
      landingDrafts: [],
      activeLandingDraftId: null,
    };

    // Local mutation B: a second tab opens. This schedules a projection that
    // captures the CURRENT state (both tabs) right now - queued, not flushed.
    const tabB = store.openEpicTab("epic-b", "Epic B");

    // The desktop's echo of the EARLIER snapshot A arrives late, after B's
    // local mutation already scheduled its projection. Applying it mutates
    // the live store back down to just tabA.
    applyEpicCanvasDesktopProjection(snapshotA);
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([tabA]);

    await bridge.flush();

    // The flush must ship what was captured when B was scheduled (both
    // tabs), not a live re-read of the store, which the echo just rolled
    // back to only tabA - preserving pending local authority over a stale
    // desktop echo, matching the pre-change eager-patch semantics.
    const sentAfterEcho = attempts[attempts.length - 1];
    expect(sentAfterEcho.epicTabs?.map((t) => t.id)).toEqual([tabA, tabB]);
    expect(sentAfterEcho.activeTabId).toBe(tabB);

    bridge.dispose();
  });
});

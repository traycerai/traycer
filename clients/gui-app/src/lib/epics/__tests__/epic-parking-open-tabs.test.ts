import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetEpicParkingForTests,
  isEpicParked,
  subscribeEpicParking,
} from "@/lib/epics/epic-parking";
import { __syncEpicParkingOpenTabsForTests } from "@/lib/epics/epic-parking-open-tabs";
import { setEpicSurfaceVisibility } from "@/lib/browser-view/tiles/surface-host-opened-tab";
import { __resetCrossWindowEpicVisibilityForTests } from "@/lib/epics/cross-window-epic-visibility";
import { PARK_HIDDEN_EPIC_AFTER_MS } from "@/stores/replica-memory/retention-profile";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

// Oracle for `lib/epics/epic-parking-open-tabs.ts`, which the risk review
// names by file as having no test of its own: "epic-parking-open-tabs.ts
// import-order constraint." `epic-parking.test.ts` drives this module's test
// seam (`__syncEpicParkingOpenTabsForTests`) constantly, but always as a
// stated no-op alongside a real store mutation - never to pin what the
// module's OWN open-set derivation does: collapsing multiple tabs on one
// epic into a single entry, reading `openTabOrder` rather than `tabsById`,
// and reconciling automatically through its module-scope subscription with
// no explicit call at all.

function resetCanvasStore(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
}

function openEpicTab(tabId: string, epicId: string): void {
  useEpicCanvasStore.getState().openEpicTabWithId(tabId, epicId, epicId);
}

describe("epic-parking-open-tabs.ts: open-set reconciliation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    __resetEpicParkingForTests();
    __getOpenEpicRegistryForTests().disposeAll();
    __resetCrossWindowEpicVisibilityForTests();
    resetCanvasStore();
    vi.useRealTimers();
  });

  it("arms a park window for a tab opened through the canvas store, with no explicit sync call", () => {
    // No `__syncEpicParkingOpenTabsForTests()` anywhere in this test. Every
    // OTHER fixture in `epic-parking.test.ts` calls it right after a store
    // mutation - "usually redundant... made explicit here anyway" - which
    // means none of them can tell the module-scope
    // `useEpicCanvasStore.subscribe(syncOpenEpicTabs)` apart from a suite
    // that only ever drives the reconciler through its own test seam. A
    // regression that dropped the live subscription (leaving only the
    // seam and the one-shot import-time call) would pass every existing
    // fixture and fail only here.
    const EPIC = "epic-open-tabs-live-subscription";
    const TAB = "tab-open-tabs-live-subscription";
    openEpicTab(TAB, EPIC);

    setEpicSurfaceVisibility(EPIC, "view-a", false);
    vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS);

    expect(isEpicParked(EPIC)).toBe(true);
  });

  it("keeps one open-set entry per epic: a second tab on it survives the first tab's close, and only the last close un-parks it", () => {
    const EPIC = "epic-open-tabs-dedup";
    const TAB_A = "tab-open-tabs-dedup-a";
    const TAB_B = "tab-open-tabs-dedup-b";
    openEpicTab(TAB_A, EPIC);
    openEpicTab(TAB_B, EPIC);

    setEpicSurfaceVisibility(EPIC, "view-a", false);
    vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS);
    expect(isEpicParked(EPIC)).toBe(true);

    const notified: string[] = [];
    const unsubscribe = subscribeEpicParking((epicId) => {
      notified.push(epicId);
    });
    try {
      // Closing ONE of two tabs on the epic must not remove its open-set
      // entry: `openEpicIds()` is a SET of epic ids derived from
      // `openTabOrder`, not a per-tab count, so the epic is still open
      // through `TAB_B`. A version keyed on the closing tab id instead of
      // the epic id would un-park here, which is exactly what plan C's own
      // contract (a parked tab keeps its state) would then contradict for a
      // sibling tab that never closed.
      useEpicCanvasStore.getState().closeTab(TAB_A);
      expect(isEpicParked(EPIC)).toBe(true);
      expect(notified).toEqual([]);

      // The tab closed above still lives in `tabsById` (closed tabs are
      // retained there so their canvases can be restored) but is gone from
      // `openTabOrder` - proving the reconciler reads the order list, the
      // stated authority, and not the record map.
      expect(useEpicCanvasStore.getState().tabsById[TAB_A]).not.toBeUndefined();
      expect(useEpicCanvasStore.getState().openTabOrder).not.toContain(TAB_A);

      // Closing the LAST open tab removes the epic from the open set: the
      // reconciler's close loop un-parks it and notifies exactly once.
      useEpicCanvasStore.getState().closeTab(TAB_B);
      expect(isEpicParked(EPIC)).toBe(false);
      expect(notified).toEqual([EPIC]);
    } finally {
      unsubscribe();
    }
  });
});

describe("epic-parking-open-tabs.ts: import-order independence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("captures a tab that was already open before this module's own first import", async () => {
    // The module's doc states the constraint this pins: "the mirror has to
    // be live before any tab opens." Its `syncOpenEpicTabs()` also runs
    // ONCE, eagerly, at import - not only inside the subscription - and that
    // eager call is what has to notice a tab that opened before the module
    // ever loaded, since no subscription existed yet to catch the mutation
    // itself. `vi.resetModules()` plus a fully dynamic import graph is the
    // only way to control that ordering directly: every top-level import in
    // this file already resolved before this test runs, so reaching for
    // them here would silently use the STALE, already-initialized modules
    // and prove nothing about import order.
    const canvasModule = await import("@/stores/epics/canvas/store");
    const EPIC = "epic-open-tabs-import-order";
    const TAB = "tab-open-tabs-import-order";
    canvasModule.useEpicCanvasStore
      .getState()
      .openEpicTabWithId(TAB, EPIC, EPIC);

    // Imported AFTER the tab is already open.
    await import("@/lib/epics/epic-parking-open-tabs");
    const parkingModule = await import("@/lib/epics/epic-parking");
    const surfaceModule =
      await import("@/lib/browser-view/tiles/surface-host-opened-tab");
    const retentionModule =
      await import("@/stores/replica-memory/retention-profile");

    try {
      surfaceModule.setEpicSurfaceVisibility(EPIC, "view-a", false);
      vi.advanceTimersByTime(retentionModule.PARK_HIDDEN_EPIC_AFTER_MS);

      expect(parkingModule.isEpicParked(EPIC)).toBe(true);
    } finally {
      canvasModule.useEpicCanvasStore.getState().closeTab(TAB);
      parkingModule.__resetEpicParkingForTests();
    }
  });
});

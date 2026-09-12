/**
 * Turning the Home tab off while Home holds the selection must land somewhere,
 * and must land there IDEMPOTENTLY.
 *
 * `activeItemId === null` means Home only while the flag is on; the moment it
 * goes off, that selection names nothing and the window would render an empty
 * content area. Start New is where it goes - the other surface reachable with
 * no task open, and what `/` resolved to before Home existed.
 *
 * The idempotence is the part worth pinning. A user who toggles the setting
 * off, misses Home, toggles it back on and then off again is doing something
 * ordinary, and a fallback that mints a fresh draft per flip leaves a trail of
 * Start New tabs they never asked for. The sibling stepped-landing resolver
 * names the existing draft explicitly for exactly this reason; this asserts the
 * fallback does the same.
 *
 * Drives the real component, coordinator and stores. Only the router commit
 * boundary is faked: the draft is created by the coordinator before `navigate`
 * is ever called, so the store is the honest place to assert.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { NavigateOptions } from "@tanstack/react-router";
import { TopLevelTabHost } from "@/components/layout/top-level-tab-host";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { emptyTabStripLayout } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import {
  __resetTabSyncCoordinatorForTesting,
  installTabSyncCoordinator,
} from "@/lib/tab-sync/tab-sync-coordinator";

const navigated = vi.hoisted(() => ({ options: [] as NavigateOptions[] }));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => (options: NavigateOptions) => {
      navigated.options.push(options);
      return Promise.resolve();
    },
  };
});

vi.mock("@/components/epic-tabs/phase-migration-controller-host", () => ({
  PhaseMigrationControllerHost: () => null,
}));

vi.mock(
  "@/components/epic-canvas/surface-host/stable-tile-surface-host-switch",
  () => ({ STABLE_TILE_SURFACE_HOST_ENABLED: false }),
);

function resetStores(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
  useSettingsStore.setState({ homeTabEnabled: false });
  navigated.options = [];
}

function setHomeTabEnabled(enabled: boolean): void {
  act(() => {
    useSettingsStore.setState({ homeTabEnabled: enabled });
  });
}

describe("turning the Home tab off while Home is active", () => {
  beforeEach(async () => {
    resetStores();
    __resetTabSyncCoordinatorForTesting();
    __resetTabNavigationControllerForTesting();
    installTabSyncCoordinator({ readyPromise: Promise.resolve() });
    await Promise.resolve();
    await Promise.resolve();
  });

  afterEach(() => {
    cleanup();
    resetStores();
  });

  it("reuses the one Start New page across repeated off/on/off flips", () => {
    setHomeTabEnabled(true);
    render(<TopLevelTabHost />);
    expect(useTabsStore.getState().activeItemId).toBeNull();

    setHomeTabEnabled(false);
    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
    const firstDraftId = useLandingDraftStore.getState().drafts[0]?.id;
    expect(firstDraftId).toBeDefined();

    // Back to Home, then off again - the flip the naive fallback stacks a
    // second Start New tab on.
    setHomeTabEnabled(true);
    act(() => {
      useTabsStore.setState({ activeItemId: null });
    });
    setHomeTabEnabled(false);

    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
    expect(useLandingDraftStore.getState().drafts[0]?.id).toBe(firstDraftId);
  });

  it("replaces the Home entry rather than pushing over it", () => {
    // The entry being left is Home's own, and Home has just stopped existing -
    // so a push leaves a destination that renders nothing one Back press away,
    // which is the gesture a user reaches for when a surface changes under
    // them.
    setHomeTabEnabled(true);
    render(<TopLevelTabHost />);
    navigated.options = [];

    setHomeTabEnabled(false);

    expect(navigated.options).toHaveLength(1);
    expect(navigated.options[0]?.replace).toBe(true);
  });

  it("leaves a window that never had Home alone", () => {
    render(<TopLevelTabHost />);

    // Flag off from the start with an empty strip: the ordinary pre-Home empty
    // state, which must mint nothing and navigate nowhere.
    expect(useLandingDraftStore.getState().drafts).toHaveLength(0);
    expect(navigated.options).toHaveLength(0);
  });

  it("leaves a real tab's selection alone when the flag goes off", () => {
    setHomeTabEnabled(true);
    render(<TopLevelTabHost />);
    act(() => {
      useTabsStore.setState({ activeItemId: "tab:epic:kept" });
    });

    setHomeTabEnabled(false);

    expect(useLandingDraftStore.getState().drafts).toHaveLength(0);
    expect(useTabsStore.getState().activeItemId).toBe("tab:epic:kept");
  });
});

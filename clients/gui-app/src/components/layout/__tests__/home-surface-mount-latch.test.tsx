/**
 * When the Home surface is allowed to run, and when it is not.
 *
 * The surface is the head of the whole cross-task join - task-context and
 * indicator RPCs keyed on an epic set that moves whenever anything on the
 * account starts or stops, a projection re-encode per Y.Doc notification, a
 * subscription per warm chat - so mounting it costs the same whether it is
 * visible or hidden behind `display: none`. Two facts have to hold together:
 * a window that never opens Home pays none of that, and a window that HAS
 * opened it keeps the surface warm for the rest of the session rather than
 * paying a cold rebuild on every visit.
 *
 * Asserted through the real component and the real stores, with the model and
 * actions hooks faked - a call to `useFocusModel` IS the cost being measured,
 * so counting the calls is the honest test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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

const focusModel = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/hooks/home-focus/use-focus-model", async () => {
  const { EMPTY_FOCUS_MODEL: empty } =
    await import("@/lib/home-focus/build-focus-model");
  return {
    useFocusModel: () => {
      focusModel.calls += 1;
      return empty;
    },
  };
});

vi.mock("@/hooks/home-focus/use-focus-actions", () => ({
  useFocusActions: () => ({
    openPrompt: vi.fn(),
    openAgent: vi.fn(),
    openTask: vi.fn(),
    openBackground: vi.fn(),
    stopAgent: vi.fn(),
    stopManagedCommand: vi.fn(),
    stopping: new Set<string>(),
  }),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => (_options: NavigateOptions) => Promise.resolve(),
  };
});

vi.mock("@/components/epic-tabs/phase-migration-controller-host", () => ({
  PhaseMigrationControllerHost: () => null,
}));

vi.mock(
  "@/components/epic-canvas/surface-host/stable-tile-surface-host-switch",
  () => ({ STABLE_TILE_SURFACE_HOST_ENABLED: false }),
);

const HOME_SURFACE = "top-level-surface-home-home";

function resetStores(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
  useSettingsStore.setState({ homeTabEnabled: true });
  focusModel.calls = 0;
}

/** Home holds the selection as `activeItemId === null`; any other id is a task
 * tab, which is "switched away from Home". */
function selectItem(activeItemId: string | null): void {
  act(() => {
    useTabsStore.setState({ activeItemId });
  });
}

describe("the Home surface's mount", () => {
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

  it("runs nothing in a window that has the tab on but never opens it", async () => {
    selectItem("tab:epic:working");
    render(<TopLevelTabHost />);

    // The surface's chunk resolves in a microtask, so flushing one is what
    // makes this a real absence rather than a race with the lazy import.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId(HOME_SURFACE)).toBeNull();
    expect(screen.queryByTestId("home-focus-view")).toBeNull();
    expect(focusModel.calls).toBe(0);
  });

  it("stays mounted after the first visit, including once the user switches away", async () => {
    selectItem("tab:epic:working");
    render(<TopLevelTabHost />);

    selectItem(null);
    // The surface itself is behind a `lazy()`, so the model starts running a
    // chunk load after the mount appears, not with it.
    expect(await screen.findByTestId("home-focus-view")).toBeDefined();
    expect(focusModel.calls).toBeGreaterThan(0);

    selectItem("tab:epic:working");
    const hidden = screen.getByTestId(HOME_SURFACE);
    expect(hidden.getAttribute("data-visible")).toBe("false");
  });

  it("unmounts when the tab is turned off", async () => {
    render(<TopLevelTabHost />);
    await waitFor(() => {
      expect(screen.getByTestId(HOME_SURFACE)).toBeDefined();
    });

    act(() => {
      useSettingsStore.setState({ homeTabEnabled: false });
    });
    expect(screen.queryByTestId(HOME_SURFACE)).toBeNull();
  });
});

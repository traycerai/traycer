import "../../../../__tests__/test-browser-apis";
import { Profiler, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import {
  canPopOverlayEntry,
  resetSystemTabModalColdLoadForTests,
  useSystemTabModalActions,
  useSystemTabModalController,
  useSystemTabModalRefreshGuard,
  type SystemTabModalApi,
} from "@/stores/tabs/use-system-tab-modal";
import {
  createPersistentMemoryHistory,
  getHistoryController,
} from "@/lib/persistent-history";
import { useSettingsSectionStore } from "@/stores/tabs/settings-section-store";
import { useTabsStore } from "@/stores/tabs/store";
import { systemTabOverlaySearchSchema } from "@/lib/system-tab-overlay-search";

function GuardedRoot() {
  useSystemTabModalRefreshGuard();
  return <Outlet />;
}

function buildRouter(initialPath: string) {
  const rootRoute = createRootRoute({
    validateSearch: (raw) => systemTabOverlaySearchSchema.parse(raw),
    component: GuardedRoot,
  });
  const epicRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics/$epicId/$tabId",
    component: () => <div data-testid="epic-route" />,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/general",
    component: () => <div data-testid="settings-route" />,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([epicRoute, settingsRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

// Same route tree as `buildRouter`, backed by the real persistent history
// (`createPersistentMemoryHistory`) instead of a plain in-memory one, so
// tests can assert on `getHistoryController(...)`'s live stack/cursor - the
// cold-load redirect's `replace` semantics only interact with adjacent-
// duplicate collapse on the persistent controller, not on `createMemoryHistory`.
function buildPersistentRouter(windowId: string) {
  const rootRoute = createRootRoute({
    validateSearch: (raw) => systemTabOverlaySearchSchema.parse(raw),
    component: GuardedRoot,
  });
  const epicRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics/$epicId/$tabId",
    component: () => <div data-testid="epic-route" />,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/general",
    component: () => <div data-testid="settings-route" />,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([epicRoute, settingsRoute]),
    history: createPersistentMemoryHistory(null, windowId),
  });
}

const modalProbe: { current: SystemTabModalApi | null } = { current: null };
function ModalProbe() {
  const api = useSystemTabModalController();
  useEffect(() => {
    modalProbe.current = api;
  });
  return null;
}

const actionProbeRenderSpy = vi.fn();
function ActionProbe() {
  useSystemTabModalActions();
  return null;
}

function buildModalRouter() {
  const rootRoute = createRootRoute({
    validateSearch: (raw) => systemTabOverlaySearchSchema.parse(raw),
    component: () => (
      <>
        <ModalProbe />
        <Outlet />
      </>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div data-testid="home" />,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

function buildActionRouter() {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <Profiler id="modal-actions" onRender={actionProbeRenderSpy}>
          <ActionProbe />
        </Profiler>
        <Outlet />
      </>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div data-testid="home" />,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

describe("settings section is store-backed, not URL-backed", () => {
  beforeEach(() => {
    modalProbe.current = null;
    actionProbeRenderSpy.mockClear();
    useSettingsSectionStore.setState({ section: null });
    useTabsStore.setState({ systemTabs: { history: null, settings: null } });
  });
  afterEach(() => {
    cleanup();
    useSettingsSectionStore.setState({ section: null });
  });

  it("openSettings puts the section in the store + only the open flag in the URL; setSection never navigates", async () => {
    const router = buildModalRouter();
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(modalProbe.current).not.toBeNull());

    act(() => {
      modalProbe.current?.openSettings({
        section: "host",
        resetToGeneral: false,
      });
    });

    await waitFor(() => {
      expect(useSettingsSectionStore.getState().section).toBe("host");
    });
    expect(router.state.location.search).toMatchObject({
      settingsOverlay: true,
    });
    expect(router.state.location.search).not.toHaveProperty("overlaySection");
    expect(modalProbe.current?.active).toMatchObject({
      kind: "settings",
      section: "host",
    });

    const navigateSpy = vi.spyOn(router, "navigate");
    act(() => {
      modalProbe.current?.setSection("appearance");
    });
    await waitFor(() => {
      expect(useSettingsSectionStore.getState().section).toBe("appearance");
    });
    // Section nav is store-only: it must not re-render the root route.
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("command-only modal actions do not subscribe to section changes", async () => {
    const router = buildActionRouter();
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(actionProbeRenderSpy).toHaveBeenCalled());
    const rendersBeforeSectionChange = actionProbeRenderSpy.mock.calls.length;

    act(() => {
      useSettingsSectionStore.getState().setSection("appearance");
    });

    expect(actionProbeRenderSpy).toHaveBeenCalledTimes(
      rendersBeforeSectionChange,
    );
  });
});

describe("useSystemTabModalRefreshGuard", () => {
  beforeEach(() => {
    // The cold-load latch is module-scoped ("once per renderer boot"), not
    // per-hook-instance, so tests must reset it explicitly between cases -
    // otherwise a prior test's boot consumes it and the redirect below never
    // gets to fire.
    resetSystemTabModalColdLoadForTests();
    useTabsStore.setState({ systemTabs: { history: null, settings: null } });
  });
  afterEach(() => {
    cleanup();
    useTabsStore.setState({ systemTabs: { history: null, settings: null } });
  });

  it("does not issue a second navigation when no system modal overlay is open", async () => {
    const router = buildRouter("/epics/epic-1/tab-1");
    const navigateSpy = vi.spyOn(router, "navigate");
    render(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/epics/epic-1/tab-1");
    });

    await router.navigate({ to: "/settings/general" });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/settings/general");
    });

    expect(navigateSpy).toHaveBeenCalledOnce();
  });

  it("fires the focus-tab-first redirect exactly once on cold load, using replace", async () => {
    // Simulates a genuine cold boot: the persisted/restored URL carries an
    // overlay flag, but the settings tab is already open (e.g. restored from
    // a prior session). The guard's first-ever effect pass must redirect
    // straight to the tab and drop the overlay param.
    useTabsStore.setState({
      systemTabs: {
        history: null,
        settings: {
          id: "settings",
          kind: "settings",
          name: "Settings",
          lastPath: "/settings/general",
        },
      },
    });
    const router = buildRouter("/epics/epic-1/tab-1?settingsOverlay=true");
    const navigateSpy = vi.spyOn(router, "navigate");
    render(<RouterProvider router={router} />);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/settings/general");
    });
    expect(router.state.location.search).not.toHaveProperty("settingsOverlay");
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(navigateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ replace: true }),
    );

    // A later in-app crossing back onto an overlay-flagged URL must NOT
    // re-trigger the cold-load-only redirect. Unlike the old per-instance
    // ref (which reset on any ancestor remount), the module-scoped latch
    // stays consumed for the rest of the renderer's life, so this can only
    // land back on `/settings/general` if the redirect incorrectly re-fires.
    navigateSpy.mockClear();
    await router.navigate({
      to: "/epics/$epicId/$tabId",
      params: { epicId: "epic-1", tabId: "tab-1" },
      search: {
        focusedAt: undefined,
        focusArtifactId: undefined,
        focusThreadId: undefined,
        migrationSource: undefined,
        focusPaneId: undefined,
        focusTileInstanceId: undefined,
        settingsOverlay: true,
      },
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/epics/epic-1/tab-1");
    });
  });

  it("cold boot onto an overlay entry with the tab route already ahead leaves no dead forward step", async () => {
    // A restored stack where the redirect target is ALREADY the next
    // persisted entry (e.g. the user promoted the overlay to a tab in a
    // prior session, then quit with the cursor back on the overlay entry).
    // The cold-load redirect's `replace` must collapse that forward
    // duplicate, not just land on it and leave a dead forward step.
    useTabsStore.setState({
      systemTabs: {
        history: null,
        settings: {
          id: "settings",
          kind: "settings",
          name: "Settings",
          lastPath: "/settings/general",
        },
      },
    });
    const windowId = "cold-boot-overlay-ahead";
    window.localStorage.setItem(
      `traycer-gui-app:last-route:${windowId}`,
      JSON.stringify({
        entries: [
          "/epics/epic-1/tab-1",
          "/epics/epic-1/tab-1?settingsOverlay=true",
          "/settings/general",
        ],
        index: 1,
      }),
    );
    const router = buildPersistentRouter(windowId);
    render(<RouterProvider router={router} />);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/settings/general");
    });
    expect(router.state.location.search).not.toHaveProperty("settingsOverlay");

    const controller = getHistoryController(router.history);
    if (controller === null) {
      throw new Error("expected a persistent controller");
    }
    expect(controller.getEntries()).toEqual([
      "/epics/epic-1/tab-1",
      "/settings/general",
    ]);
    expect(controller.getIndex()).toBe(1);
    expect(controller.canGoForward()).toBe(false);
  });
});

describe("canPopOverlayEntry", () => {
  function seedHistory(
    windowId: string,
    entries: ReadonlyArray<string>,
    index: number,
  ) {
    window.localStorage.setItem(
      `traycer-gui-app:last-route:${windowId}`,
      JSON.stringify({ entries, index }),
    );
    return createPersistentMemoryHistory(null, windowId);
  }

  it("pops back when the entry behind is the overlay-free underlying page", () => {
    const history = seedHistory(
      "pop-underlying",
      ["/epics/e/t", "/epics/e/t?settingsOverlay=true"],
      1,
    );
    expect(canPopOverlayEntry(history)).toBe(true);
  });

  it("refuses to pop into a previous overlay entry on the same path", () => {
    // [page, settingsOverlay, historyOverlay] — closing history must NOT back()
    // into the settings overlay, it must dismiss to the page via replace.
    const history = seedHistory(
      "pop-stacked",
      [
        "/epics/e/t",
        "/epics/e/t?settingsOverlay=true",
        "/epics/e/t?historyOverlay=true",
      ],
      2,
    );
    expect(canPopOverlayEntry(history)).toBe(false);
  });

  it("refuses when nothing sits behind the current entry", () => {
    const history = seedHistory(
      "pop-deeplink",
      ["/epics/e/t?settingsOverlay=true"],
      0,
    );
    expect(canPopOverlayEntry(history)).toBe(false);
  });
});

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
  useSystemTabModalActions,
  useSystemTabModalController,
  useSystemTabModalRefreshGuard,
  type SystemTabModalApi,
} from "@/stores/tabs/use-system-tab-modal";
import { createPersistentMemoryHistory } from "@/lib/persistent-history";
import { useSettingsSectionStore } from "@/stores/tabs/settings-section-store";
import { useTabsStore } from "@/stores/tabs/store";
import { systemTabOverlaySearchSchema } from "@/lib/system-tab-overlay-search";

function GuardedRoot() {
  useSystemTabModalRefreshGuard();
  return <Outlet />;
}

function buildRouter(initialPath: string) {
  const rootRoute = createRootRoute({ component: GuardedRoot });
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
  afterEach(() => {
    cleanup();
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

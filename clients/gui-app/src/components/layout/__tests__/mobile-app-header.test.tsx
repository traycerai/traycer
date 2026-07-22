import "../../../../__tests__/test-browser-apis";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileAppHeader } from "@/components/layout/header/mobile-app-header";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useMobileHeaderStore } from "@/stores/layout/mobile-header-store";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

// The real rate-limit / resource-monitor controls pull host + stream
// providers; stub them to their accessible trigger so the header renders in
// this minimal harness while the switch on the resource-monitor toggle stays
// observable.
vi.mock("@/components/layout/header/rate-limit-icon", () => ({
  RateLimitIconButton: () => (
    <button type="button" aria-label="Usage limits" />
  ),
}));
vi.mock("@/components/resources/resource-monitor-popover", () => ({
  ResourceMonitorPopover: () => (
    <button type="button" aria-label="Resource monitor" />
  ),
}));

function renderAt(path: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <MobileAppHeader />
        <Outlet />
      </>
    ),
  });
  const nullComponent = () => null;
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: "/", component: nullComponent }),
    createRoute({ getParentRoute: () => rootRoute, path: "/epics", component: nullComponent }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/epics/$epicId/$tabId",
      component: nullComponent,
    }),
    createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: nullComponent }),
    createRoute({ getParentRoute: () => rootRoute, path: "/draft/new", component: nullComponent }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<RouterProvider router={router} />);
}

describe("MobileAppHeader", () => {
  beforeEach(() => {
    useMobileNavStore.setState({ open: false });
    useMobileHeaderStore.setState({ rightActions: null });
    useEpicCanvasStore.setState({ tabsById: {} });
    useSettingsStore.setState({ showGlobalResourceMonitor: false });
  });
  afterEach(() => {
    cleanup();
    useMobileNavStore.setState({ open: false });
    useMobileHeaderStore.setState({ rightActions: null });
    useEpicCanvasStore.setState({ tabsById: {} });
  });

  it("renders the hamburger menu trigger", async () => {
    renderAt("/");
    expect(
      await screen.findByRole("button", { name: "Open menu" }),
    ).not.toBeNull();
  });

  it("opens the navigation drawer store when the hamburger is tapped", async () => {
    renderAt("/");
    fireEvent.click(await screen.findByTestId("mobile-nav-trigger"));
    expect(useMobileNavStore.getState().open).toBe(true);
  });

  it("titles the History and Settings surfaces from the route", async () => {
    renderAt("/epics");
    expect(
      (await screen.findByTestId("mobile-header-title")).textContent,
    ).toBe("History");
    cleanup();
    renderAt("/settings");
    expect(
      (await screen.findByTestId("mobile-header-title")).textContent,
    ).toBe("Settings");
  });

  it("titles the epic surface with the open epic's name", async () => {
    useEpicCanvasStore.setState({
      tabsById: { t1: { tabId: "t1", epicId: "e1", name: "Wire up billing" } },
    });
    renderAt("/epics/e1/t1");
    expect(
      (await screen.findByTestId("mobile-header-title")).textContent,
    ).toBe("Wire up billing");
  });

  it("always renders the rate-limit control", async () => {
    renderAt("/");
    expect(
      await screen.findByRole("button", { name: "Usage limits" }),
    ).not.toBeNull();
  });

  it("shows the resource monitor only when the global toggle is on", async () => {
    useSettingsStore.setState({ showGlobalResourceMonitor: true });
    renderAt("/");
    expect(
      await screen.findByRole("button", { name: "Resource monitor" }),
    ).not.toBeNull();

    cleanup();
    useSettingsStore.setState({ showGlobalResourceMonitor: false });
    renderAt("/");
    await screen.findByRole("button", { name: "Open menu" });
    expect(
      screen.queryByRole("button", { name: "Resource monitor" }),
    ).toBeNull();
  });

  it("renders route-contributed right actions from the slot store", async () => {
    useMobileHeaderStore.setState({
      rightActions: <button type="button">epic action</button>,
    });
    renderAt("/epics/e1/t1");
    expect(
      await screen.findByRole("button", { name: "epic action" }),
    ).not.toBeNull();
  });
});

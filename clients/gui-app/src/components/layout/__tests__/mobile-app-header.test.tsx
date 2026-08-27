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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MobileAppHeader } from "@/components/layout/header/mobile-app-header";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useMobileHeaderStore } from "@/stores/layout/mobile-header-store";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { emptySystemTabs, tabItemId } from "@/stores/tabs/layout";
import type { SystemTabs } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";

// The real rate-limit / resource-monitor controls pull host + stream
// providers; stub them to their accessible trigger so the header renders in
// this minimal harness while the switch on the resource-monitor toggle stays
// observable.
vi.mock("@/components/layout/header/rate-limit-icon", () => ({
  RateLimitIconButton: () => <button type="button" aria-label="Usage limits" />,
}));
vi.mock("@/components/resources/resource-monitor-popover", () => ({
  ResourceMonitorPopover: () => (
    <button type="button" aria-label="Resource monitor" />
  ),
}));
vi.mock("@/components/notifications/mobile-notifications-button", () => ({
  MobileNotificationsButton: () => (
    <button type="button" aria-label="Notifications" />
  ),
}));

// On the epic route the title slot renders `MobileEpicHeaderTitle`, which
// pulls a host mutation (`useEpicUpdateTitle`) and the registered-epic
// permission role. Neither host runtime nor a registered epic exist in this
// bare harness, so stub both.
// `mobile-app-header-cold-restore.test.tsx` drives these registry accessors for
// real; here they are stubbed so the surface-resolution cases stay readable.
const headerTitleState = vi.hoisted(() => ({
  role: "owner",
  liveTitle: null as string | null,
}));
const updateTitleMutateSpy = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/epic/use-epic-title-mutation", () => ({
  useEpicUpdateTitle: () => ({
    mutate: updateTitleMutateSpy,
    isPending: false,
  }),
}));
vi.mock("@/lib/epic-selectors", () => ({
  useRegisteredEpicPermissionRole: () => headerTitleState.role,
  useRegisteredEpicTitle: () => headerTitleState.liveTitle,
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
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: nullComponent,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/epics",
      component: nullComponent,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/epics/$epicId/$tabId",
      component: nullComponent,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/settings",
      component: nullComponent,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/draft/new",
      component: nullComponent,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  // `MobileEpicHeaderTitle` reads `useQueryClient()` for the session-host
  // success arm's cloud-cache patch; the mocked mutation hook used to hide
  // that dependency.
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/**
 * Focuses one tab in the layout the header reads.
 *
 * The layout is what a restored session actually restores - so every titled
 * case here seeds it, INCLUDING the ones that also put the router on the
 * matching route. A case that only set the route would be testing a state the
 * phone never reaches.
 */
function focusTab(ref: TabRef, systemTabs: SystemTabs): void {
  const itemId = tabItemId(ref);
  useTabsStore.setState({
    items: [{ kind: "tab", id: itemId, ref }],
    activeItemId: itemId,
    systemTabs,
  });
}

function presentEpicTab(tabId: string, epicId: string, name: string): void {
  focusTab({ kind: "epic", id: tabId }, emptySystemTabs());
  useEpicCanvasStore.setState({
    tabsById: { [tabId]: { tabId, epicId, name } },
  });
}

function presentHistoryTab(): void {
  focusTab(
    { kind: "history", id: "history" },
    {
      ...emptySystemTabs(),
      history: {
        id: "history",
        kind: "history",
        name: "History",
        lastPath: "/epics",
      },
    },
  );
}

function presentSettingsTab(lastPath: string): void {
  focusTab(
    { kind: "settings", id: "settings" },
    {
      ...emptySystemTabs(),
      settings: {
        id: "settings",
        kind: "settings",
        name: "Settings",
        lastPath,
      },
    },
  );
}

function presentNoTab(): void {
  useTabsStore.setState({
    items: [],
    activeItemId: null,
    systemTabs: emptySystemTabs(),
  });
  useEpicCanvasStore.setState({ tabsById: {} });
}

describe("MobileAppHeader", () => {
  beforeEach(() => {
    useMobileNavStore.setState({ open: false });
    useMobileHeaderStore.setState({ rightActions: null });
    presentNoTab();
    useSettingsStore.setState({ showGlobalResourceMonitor: false });
    headerTitleState.role = "owner";
    headerTitleState.liveTitle = null;
    updateTitleMutateSpy.mockClear();
  });
  afterEach(() => {
    cleanup();
    useMobileNavStore.setState({ open: false });
    useMobileHeaderStore.setState({ rightActions: null });
    presentNoTab();
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

  it("titles the History and Settings surfaces", async () => {
    presentHistoryTab();
    renderAt("/epics");
    expect((await screen.findByTestId("mobile-header-title")).textContent).toBe(
      "History",
    );
    cleanup();
    presentSettingsTab("/settings");
    renderAt("/settings");
    expect((await screen.findByTestId("mobile-header-title")).textContent).toBe(
      "Settings",
    );
  });

  // Same cold-restore path as the epic case below: the system tabs are restored
  // into the layout while the router is still on the landing route it booted
  // at, so neither surface has a route to be titled from.
  it("titles the History and Settings surfaces restored under the landing route", async () => {
    presentHistoryTab();
    renderAt("/");
    expect((await screen.findByTestId("mobile-header-title")).textContent).toBe(
      "History",
    );
    cleanup();
    presentSettingsTab("/settings");
    renderAt("/");
    expect((await screen.findByTestId("mobile-header-title")).textContent).toBe(
      "Settings",
    );
  });

  it("crumbs a restored settings section under the landing route", async () => {
    presentSettingsTab("/settings/appearance");
    renderAt("/");
    expect((await screen.findByTestId("mobile-header-title")).textContent).toBe(
      "SettingsAppearance",
    );
    expect(screen.getByTestId("mobile-header-settings-crumb")).not.toBeNull();
  });

  // Composer surfaces are where you already are, and each opens with a hero
  // greeting - so neither the app name nor "New task" earns a header row.
  it("renders no title on the composer surfaces", async () => {
    renderAt("/");
    await screen.findByRole("button", { name: "Open menu" });

    expect(screen.queryByTestId("mobile-header-title")).toBeNull();
    expect(screen.queryByText("Traycer")).toBeNull();
    // The spacer still has to hold the right cluster against the right edge.
    expect(screen.getByRole("button", { name: "Usage limits" })).not.toBeNull();

    cleanup();
    renderAt("/draft/new");
    await screen.findByRole("button", { name: "Open menu" });

    expect(screen.queryByTestId("mobile-header-title")).toBeNull();
    expect(screen.queryByText("New task")).toBeNull();
  });

  it("titles the epic surface with the open epic's name", async () => {
    presentEpicTab("t1", "e1", "Wire up billing");
    renderAt("/epics/e1/t1");
    expect((await screen.findByTestId("mobile-header-title")).textContent).toBe(
      "Wire up billing",
    );
  });

  // The phone shell has no route persistence: its WebView boots at `/` and the
  // restored epic tab is painted from the tab layout alone, with the router
  // still on the landing route. The header has to name that tab anyway - this
  // is the cold-restore path, and seeding the epic ROUTE here (as a suite that
  // renders at `/epics/e1/t1` does) would hide the whole failure.
  it("titles the epic surface restored under the landing route", async () => {
    presentEpicTab("t1", "e1", "Wire up billing");
    renderAt("/");
    expect((await screen.findByTestId("mobile-header-title")).textContent).toBe(
      "Wire up billing",
    );
  });

  it("renders the epic title as an editable control for an editor and plain text for a viewer", async () => {
    presentEpicTab("t1", "e1", "Wire up billing");
    headerTitleState.role = "owner";
    renderAt("/epics/e1/t1");
    expect(
      (await screen.findByTestId("mobile-epic-header-title")).tagName,
    ).toBe("BUTTON");
    cleanup();

    headerTitleState.role = "viewer";
    renderAt("/epics/e1/t1");
    expect(
      (await screen.findByTestId("mobile-epic-header-title")).tagName,
    ).toBe("SPAN");
  });

  it("always renders the rate-limit control", async () => {
    renderAt("/");
    expect(
      await screen.findByRole("button", { name: "Usage limits" }),
    ).not.toBeNull();
  });

  // Notifications moved out of the hamburger drawer into this cluster; the
  // drawer no longer carries a bell at all.
  it("always renders the notifications control", async () => {
    renderAt("/");
    expect(
      await screen.findByRole("button", { name: "Notifications" }),
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

  it("renders surface-contributed right actions from the slot store", async () => {
    useMobileHeaderStore.setState({
      rightActions: <button type="button">epic action</button>,
    });
    presentEpicTab("t1", "e1", "Wire up billing");
    renderAt("/epics/e1/t1");
    expect(
      await screen.findByRole("button", { name: "epic action" }),
    ).not.toBeNull();
  });
});

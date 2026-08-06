import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

const windowHost = window as { runnerHost?: unknown };

vi.mock("@/components/layout/tabs/tab-strip", () => ({
  TabStrip: () => <div data-testid="tab-strip" />,
}));

// Router-dependent like TabStrip: the app-variant header mounts these arrows
// inside the router tree, but this AppShell unit test renders without a
// RouterProvider, so stub them out the same way.
vi.mock("@/components/layout/header/history-nav-buttons", () => ({
  HistoryNavButtons: () => <div data-testid="history-nav-buttons" />,
}));

vi.mock("@/components/layout/header/history-button", () => ({
  HistoryButton: () => <button type="button">History</button>,
}));

vi.mock("@/components/layout/header/sign-in-button", () => ({
  SignInButton: () => <button type="button">Sign in</button>,
}));

vi.mock("@/components/open-folder-dialog", () => ({
  OpenFolderDialog: () => <div data-testid="open-folder-dialog" />,
}));

vi.mock("@/components/layout/bridges/quit-intercept-bridge", () => ({
  QuitInterceptBridge: () => <div data-testid="quit-intercept-bridge" />,
}));

vi.mock("@/components/layout/find-in-page-bar", () => ({
  FindInPageBar: () => <div data-testid="legacy-find-in-page-bar" />,
}));

vi.mock("@/components/epic-canvas/tile-find/tile-find-owner-bridge", () => ({
  TileFindOwnerBridge: () => <div data-testid="tile-find-owner-bridge" />,
}));

vi.mock("@/components/migration/migration-run-controller", () => ({
  MigrationRunController: () => null,
}));

vi.mock("@/components/layout/dialogs/migration-blocking-modal-host", () => ({
  MigrationBlockingModalHost: () => null,
}));

vi.mock("@/components/notifications/notifications-bell", () => ({
  NotificationsBell: () => <div data-testid="notifications-bell" />,
}));

vi.mock("@/components/layout/header/rate-limit-icon", () => ({
  RateLimitIconButton: () => <div data-testid="rate-limit-header-button" />,
}));

// The Windows menu strip routes its popup through a TanStack mutation; this
// provider-light AppShell test has no QueryClient, so stub it like the other
// host/query-backed header children above.
vi.mock("@/components/layout/header/windows-menu-bar", () => ({
  WindowsMenuBar: () => null,
}));

vi.mock("@/components/resources/resource-monitor-popover", () => ({
  ResourceMonitorPopover: () => (
    <div data-testid="resource-monitor-header-button" />
  ),
}));

vi.mock("@/components/auth/user-menu", () => ({
  UserMenu: () => <div data-testid="user-menu" />,
}));

// Rendered unconditionally so the surface row's clipping contract can be
// asserted; the real host self-gates on a focused/visible draft surface.
vi.mock("@/components/home/terminal-panel/landing-terminal-host", () => ({
  LandingTerminalHost: () => <div data-testid="landing-terminal-host" />,
}));

import { AppShell } from "@/components/layout/app-shell";

describe("<AppShell />", () => {
  beforeEach(() => {
    windowHost.runnerHost = {};
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "user-1", userName: "Test User", email: "test@example.com" },
        { userId: "user-1", username: "test-user" },
        [],
      );
    useSettingsStore.setState({ showGlobalResourceMonitor: true });
  });

  afterEach(() => {
    cleanup();
    delete windowHost.runnerHost;
    useAuthStore.getState().setSignedOut();
    useSettingsStore.setState({ showGlobalResourceMonitor: true });
  });

  it("renders the signed-in app shell around routed children", () => {
    render(
      <AppShell>
        <div data-testid="app-shell-child" />
      </AppShell>,
    );

    expect(screen.getByTestId("user-menu")).not.toBeNull();
    expect(screen.getByTestId("resource-monitor-header-button")).not.toBeNull();
    expect(screen.getByTestId("app-shell-child")).not.toBeNull();
    expect(screen.getByTestId("tile-find-owner-bridge")).not.toBeNull();
    const routeLayer = screen.getByTestId("route-adapter-layer");
    expect(routeLayer.className).toContain("pointer-events-none");
    expect(routeLayer.className).toContain("[&>*]:pointer-events-auto");
    expect(routeLayer.className).toContain("flex");
    expect(routeLayer.className).toContain("h-full");
    expect(routeLayer.className).toContain("min-h-0");
    expect(screen.queryByTestId("legacy-find-in-page-bar")).toBeNull();
    // Host status footer was removed; the combined chip on the
    // composer is now the host-state surface.
    expect(screen.queryByTestId("host-status-footer")).toBeNull();
  });

  it("clips the surface row that hosts the landing terminal panel", () => {
    render(
      <AppShell>
        <div data-testid="app-shell-child" />
      </AppShell>,
    );

    // The terminal panel sits in this row as a sibling of the tab host, and its
    // 1px resize handle carries a 10px `::after` hit area centred on it. With
    // the panel collapsed the handle is pinned to the row's right edge, so half
    // that hit area lands outside the viewport. The panel used to be nested
    // inside the landing page's own `overflow-hidden` box, which absorbed the
    // overhang; hoisted up here it needs the row to clip, or the overhang
    // becomes document-level scrollable width and the landing page grows a
    // horizontal scrollbar. `TopLevelTabHost` already clips itself for the same
    // reason - this covers everything mounted beside it.
    const surfaceRow = screen.getByTestId("route-adapter-layer").parentElement;
    expect(surfaceRow).not.toBeNull();
    expect(
      surfaceRow?.contains(screen.getByTestId("landing-terminal-host")),
    ).toBe(true);
    expect(surfaceRow?.className).toContain("overflow-hidden");
  });

  it("makes the capped tab strip leftover a desktop drag region", () => {
    render(
      <AppShell>
        <div data-testid="app-shell-child" />
      </AppShell>,
    );

    const tabRegion = screen.getByTestId("tab-strip").parentElement;
    expect(tabRegion).not.toBeNull();
    expect(tabRegion?.className).toContain("[-webkit-app-region:drag]");
  });

  it("hides the global resource monitor button when the preference is off", () => {
    useSettingsStore.setState({ showGlobalResourceMonitor: false });

    render(
      <AppShell>
        <div data-testid="app-shell-child" />
      </AppShell>,
    );

    expect(screen.queryByTestId("resource-monitor-header-button")).toBeNull();
  });
});
